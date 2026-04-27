import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { type AgentEvent, runAgent } from '../src/agent/loop.js';
import type { AgentConfig } from '../src/config/schema.js';

type StreamPart = LanguageModelV2StreamPart;

function baseConfig(): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'stub' },
    agent: { maxSteps: 3 },
    tools: {
      bash: {
        enabled: true,
        timeoutMs: 5_000,
        maxBufferBytes: 64_000,
        policy: {
          approval: { enabled: true },
          allowCompound: false,
          disableBuiltinAllow: false,
          bypassSecurityChecks: false,
          allow: [],
          ask: [],
          deny: [],
        },
      },
      websearch: { enabled: false, maxResults: 5 },
      http: { enabled: false, timeoutMs: 30_000, maxResponseBytes: 1_048_576 },
      todowrite: { enabled: false, maxItems: 50 },
      moRun: { enabled: false, timeoutMs: 300_000, maxBufferBytes: 4_194_304 },
    },
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
      toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
    },
  };
}

function recorder() {
  const seen: AgentEvent[] = [];
  return { emit: async (e: AgentEvent) => void seen.push(e), seen };
}

function toolCallStream(toolCallId: string, command: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'bash',
      input: JSON.stringify({ command, intent: 'test tool call' }),
    },
    {
      type: 'finish',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      finishReason: 'tool-calls',
    },
  ];
}

function textStream(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      finishReason: 'stop',
    },
  ];
}

function mockModel(streams: Array<StreamPart[]>): MockLanguageModelV2 {
  let idx = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const parts = streams[idx++];
      if (!parts) throw new Error(`mock model: no stream queued for call #${idx}`);
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

describe('approval flow — first contact halts the loop', () => {
  it('emits tool_approval_requested + approval_required tool_result and halts', async () => {
    const { emit, seen } = recorder();
    const model = mockModel([toolCallStream('tc1', 'echo needs-approval')]);

    await runAgent(baseConfig(), [{ role: 'user', content: 'run it' }], emit, undefined, { model });

    const types = seen.map((e) => e.type);
    expect(types).toContain('tool_approval_requested');
    expect(types).toContain('tool_result');
    expect(types).not.toContain('final');

    const approval = seen.find((e) => e.type === 'tool_approval_requested');
    if (approval?.type !== 'tool_approval_requested') throw new Error('missing approval event');
    expect(approval.id).toBe('tc1');
    expect(approval.command).toBe('echo needs-approval');

    const result = seen.find((e) => e.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('missing tool_result');
    expect(result.id).toBe('tc1');
    expect(result.output.status).toBe('approval_required');
    expect(result.output.label).toBe('echo needs-approval');
    expect(result.output.return_code).toBeNull();
    expect(result.output.args).toEqual({
      command: 'echo needs-approval',
      intent: 'test tool call',
    });
    expect(typeof result.output.duration_ms).toBe('number');
  });
});

describe('approval flow — re-invoke with allow_once runs the tool', () => {
  it('executes the command and emits a succeeded envelope', async () => {
    const { emit, seen } = recorder();
    // After resolvePendingToolCalls succeeds, the loop still calls streamText
    // once to produce the model's next turn. Mock returns a trivial text reply.
    const model = mockModel([textStream('done')]);

    const conversation: ModelMessage[] = [
      { role: 'user', content: 'please echo' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'bash',
            input: { command: 'echo hello', intent: 'test tool call' },
          },
        ],
      },
    ];

    await runAgent(baseConfig(), conversation, emit, undefined, {
      model,
      approvals: [{ toolCallId: 'tc1', decision: 'allow_once' }],
    });

    const result = seen.find((e) => e.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('missing tool_result');
    expect(result.output.status).toBe('succeeded');
    expect(result.output.return_code).toBe(0);
    expect(result.output.content).toContain('hello');
    expect(result.output.label).toBe('echo hello');

    const streamEnd = seen.find((e) => e.type === 'tool_stream_end');
    if (streamEnd?.type !== 'tool_stream_end') throw new Error('missing tool_stream_end');
    expect(streamEnd.exitCode).toBe(0);

    const chunks = seen.filter((e) => e.type === 'tool_output_chunk');
    expect(chunks.length).toBeGreaterThan(0);

    expect(seen.some((e) => e.type === 'tool_approval_requested')).toBe(false);
    expect(seen.some((e) => e.type === 'final')).toBe(true);
  });
});

describe('approval flow — re-invoke with deny produces denied envelope', () => {
  it('emits status=denied with denied_reason=user_denied and does not execute', async () => {
    const { emit, seen } = recorder();
    const model = mockModel([textStream('ok, stopping')]);

    const conversation: ModelMessage[] = [
      { role: 'user', content: 'please echo' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'bash',
            input: { command: 'echo hello', intent: 'test tool call' },
          },
        ],
      },
    ];

    await runAgent(baseConfig(), conversation, emit, undefined, {
      model,
      approvals: [{ toolCallId: 'tc1', decision: 'deny' }],
    });

    const result = seen.find((e) => e.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('missing tool_result');
    expect(result.output.status).toBe('denied');
    expect(result.output.denied_reason).toBe('user_denied');
    expect(result.output.return_code).toBeNull();

    expect(seen.some((e) => e.type === 'tool_output_chunk')).toBe(false);
    expect(seen.some((e) => e.type === 'tool_stream_end')).toBe(false);
    expect(seen.some((e) => e.type === 'tool_approval_requested')).toBe(false);
    expect(seen.some((e) => e.type === 'final')).toBe(true);
  });
});

describe('approval flow — allow_session adds rule for subsequent commands', () => {
  it('allow_session with a rule adds to sessionAllowRules; follow-up matching command allows without approval', async () => {
    const { emit, seen } = recorder();
    // Model flow: resolve pending tc1 (allow_session 'echo'), then model
    // emits a second tool_call tc2 for another 'echo' which should now be
    // allowed by the session rule (no approval event), then a final text.
    const model = mockModel([toolCallStream('tc2', 'echo again'), textStream('done')]);

    const conversation: ModelMessage[] = [
      { role: 'user', content: 'first echo, then another' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'bash',
            input: { command: 'echo first', intent: 'test tool call' },
          },
        ],
      },
    ];

    await runAgent(baseConfig(), conversation, emit, undefined, {
      model,
      approvals: [{ toolCallId: 'tc1', decision: 'allow_session', rule: 'echo' }],
    });

    const results = seen.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);

    if (results[0]?.type !== 'tool_result') throw new Error('missing first tool_result');
    expect(results[0].id).toBe('tc1');
    expect(results[0].output.status).toBe('succeeded');

    if (results[1]?.type !== 'tool_result') throw new Error('missing second tool_result');
    expect(results[1].id).toBe('tc2');
    expect(results[1].output.status).toBe('succeeded');

    expect(seen.some((e) => e.type === 'tool_approval_requested')).toBe(false);
    expect(seen.some((e) => e.type === 'final')).toBe(true);
  });
});

describe('approval flow — policy deny does not prompt for approval', () => {
  it('status=denied with denied_reason=policy_deny and no approval event', async () => {
    const { emit, seen } = recorder();
    const cfg = baseConfig();
    cfg.tools.bash.policy.deny = ['rm'];

    const model = mockModel([toolCallStream('tc1', 'rm something'), textStream('done')]);

    await runAgent(cfg, [{ role: 'user', content: 'delete' }], emit, undefined, {
      model,
    });

    const result = seen.find((e) => e.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('missing tool_result');
    expect(result.output.status).toBe('denied');
    expect(result.output.denied_reason).toBe('policy_deny');
    expect(seen.some((e) => e.type === 'tool_approval_requested')).toBe(false);
  });
});
