import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { APICallError } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { jsonSchema } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { type AgentEvent, diagnoseStep, prepareMessages, runAgent } from '../src/agent/loop.js';
import type { AgentConfig } from '../src/config/schema.js';

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
    agent: { maxSteps: 10 },
    mcpTools: [],
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
      toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
      approval: { mode: 'none', tools: [] },
    },
    ...overrides,
  };
}

describe('prepareMessages', () => {
  it('prepends the configured system prompt', () => {
    const cfg = baseConfig();
    const incoming: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const out = prepareMessages(cfg, incoming);
    expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out).toHaveLength(2);
  });

  it('strips caller-provided system messages', () => {
    const cfg = baseConfig();
    const incoming: ModelMessage[] = [
      { role: 'system', content: 'OVERRIDE' },
      { role: 'user', content: 'hi' },
    ];
    const out = prepareMessages(cfg, incoming);
    expect(out.filter((m) => m.role === 'system')).toEqual([{ role: 'system', content: 'SYSTEM' }]);
    expect(out.some((m) => m.role === 'system' && m.content === 'OVERRIDE')).toBe(false);
  });

  it('keeps user and assistant message order intact', () => {
    const cfg = baseConfig();
    const incoming: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const out = prepareMessages(cfg, incoming);
    expect(out.slice(1)).toEqual(incoming);
  });

  it('renders built-in template variables in the system prompt', () => {
    const cfg = baseConfig();
    cfg.systemPrompt = 'today={{today}} cwd={{cwd}}';
    const out = prepareMessages(cfg, []);
    const system = out[0];
    if (system?.role !== 'system' || typeof system.content !== 'string') {
      throw new Error('expected string system message');
    }
    expect(system.content).toMatch(/^today=\d{4}-\d{2}-\d{2} cwd=.+/);
    expect(system.content).not.toContain('{{');
  });

  it('renders user-supplied promptVars alongside built-ins', () => {
    const cfg = baseConfig();
    cfg.systemPrompt = 'team={{team}} today={{today}}';
    cfg.promptVars = { team: 'Platform' };
    const out = prepareMessages(cfg, []);
    const system = out[0];
    if (system?.role !== 'system' || typeof system.content !== 'string') {
      throw new Error('expected string system message');
    }
    expect(system.content.startsWith('team=Platform today=')).toBe(true);
  });
});

type StreamPart = LanguageModelV3StreamPart;

const V3_USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function toolCallStream(toolName: string, input: Record<string, unknown>): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: `c-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: 'finish',
      usage: V3_USAGE,
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
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
      usage: V3_USAGE,
      finishReason: { unified: 'stop', raw: 'stop' },
    },
  ];
}

function fakeMcpTool(executeOutput: unknown) {
  return {
    description: 'stub',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    type: 'dynamic' as const,
    async execute() {
      return executeOutput;
    },
  };
}

interface DoStreamCall {
  prompt: LanguageModelV3CallOptions['prompt'];
}

function multiStepModel(
  streams: StreamPart[][],
  opts: { summarizeText?: string } = {},
): {
  model: MockLanguageModelV3;
  calls: DoStreamCall[];
} {
  const calls: DoStreamCall[] = [];
  let idx = 0;
  const model = new MockLanguageModelV3({
    doStream: async (callOpts) => {
      calls.push({ prompt: callOpts.prompt });
      const parts = streams[idx++];
      if (!parts) throw new Error(`mock model: no stream queued for call #${idx}`);
      return { stream: convertArrayToReadableStream(parts) };
    },
    // generateText() — used by the summarizer — goes through doGenerate, not
    // doStream. Return a deterministic summary so the test can assert the
    // SUMMARY text routed back into the next step's prompt.
    doGenerate: async () => ({
      content: [{ type: 'text', text: opts.summarizeText ?? 'STUB-SUMMARY' }],
      finishReason: { unified: 'stop', raw: 'stop' } as const,
      usage: V3_USAGE,
      warnings: [],
    }),
  });
  return { model, calls };
}

describe('runAgent — MCP tool summarization in the real loop', () => {
  it('routes the SUMMARIZED tool output (not the raw oversized body) into the next model step', async () => {
    const big = 'A'.repeat(2000);
    const tools = {
      huge: fakeMcpTool({ content: [{ type: 'text', text: big }] }),
    };

    // Step 1: model decides to call the tool. Step 2: model produces final text.
    const { model, calls } = multiStepModel([
      toolCallStream('huge', { q: 1 }),
      textStream('all done'),
    ]);

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig({
        safety: {
          compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
          // small thresholds force summarization on `big`
          toolOutput: { triggerTokens: 50, headChars: 20, tailChars: 20 },
          approval: { mode: 'none', tools: [] },
        },
      }),
      [{ role: 'user', content: 'fetch huge thing' }],
      (e) => void events.push(e),
      undefined,
      { model, tools },
    );

    // Sanity: 2 model calls — one tool-calling, one final.
    expect(calls).toHaveLength(2);

    // The crucial assertion: the prompt the model received for step 2 must
    // contain the summarized envelope, NOT the oversized raw body.
    const step2Prompt = JSON.stringify(calls[1]?.prompt);
    expect(step2Prompt).not.toContain(big);
    expect(step2Prompt).toContain('HEAD');
    expect(step2Prompt).toContain('TAIL');

    // SSE side: the tool_result event must be marked truncated.
    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('no tool_result emitted');
    expect(toolResult.output.truncated).toBe(true);
    expect(toolResult.output.content).toContain('HEAD');

    // Final natural-language answer is preserved.
    const final = events.find((e) => e.type === 'final');
    expect(final?.type).toBe('final');
    if (final?.type === 'final') {
      expect(final.content).toBe('all done');
    }
  });

  it('emits a small tool result unchanged and untruncated', async () => {
    const tools = {
      ping: fakeMcpTool({ content: [{ type: 'text', text: 'pong' }] }),
    };

    const { model } = multiStepModel([toolCallStream('ping', {}), textStream('ok')]);

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model, tools },
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('no tool_result emitted');
    expect(toolResult.output.content).toBe('pong');
    expect(toolResult.output.truncated).toBeFalsy();
  });

  it('reuses the injected tool map across multiple invocations (no per-request rebuild)', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const tools = {
      shared: {
        description: 'shared',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {},
          additionalProperties: true,
        }),
        type: 'dynamic' as const,
        execute,
      },
    };

    for (let i = 0; i < 2; i++) {
      const { model } = multiStepModel([toolCallStream('shared', { i }), textStream(`done-${i}`)]);
      await runAgent(baseConfig(), [{ role: 'user', content: `req ${i}` }], () => {}, undefined, {
        model,
        tools,
      });
    }

    // Same tool object was used both times — execute fires once per request.
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('runAgent — tool approval', () => {
  it('pauses for human approval instead of executing a gated tool', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ran' }] }));
    const tools = {
      guarded: {
        description: 'guarded',
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: true }),
        type: 'dynamic' as const,
        execute,
      },
    };

    // Only one stream is queued: if the loop wrongly continued past the pause,
    // multiStepModel would throw "no stream queued for call #2".
    const { model, calls } = multiStepModel([toolCallStream('guarded', { x: 1 })]);

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig({
        safety: {
          compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
          toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
          approval: { mode: 'all', tools: [] },
        },
      }),
      [{ role: 'user', content: 'do the thing' }],
      (e) => void events.push(e),
      undefined,
      { model, tools },
    );

    // Paused after the first model call; the gated tool never ran.
    expect(calls).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();

    const approval = events.find((e) => e.type === 'tool_approval_requested');
    if (approval?.type !== 'tool_approval_requested') throw new Error('no approval event emitted');
    expect(approval.name).toBe('guarded');
    expect(approval.approvalId).toBeTruthy();

    // The standard envelope also reflects the pending state (spec 003).
    const pending = events.find(
      (e) => e.type === 'tool_result' && e.output.status === 'approval_required',
    );
    expect(pending).toBeDefined();

    // The turn is not finished — no final answer yet; the pause event carries
    // the messages a stateless client needs to resume.
    expect(events.some((e) => e.type === 'final')).toBe(false);
    const paused = events.find((e) => e.type === 'run_paused');
    if (paused?.type !== 'run_paused') throw new Error('no run_paused emitted');
    expect(paused.reason).toBe('tool_approval');
    expect(paused.messages.length).toBeGreaterThan(0);
  });

  it('resumes an approved run: the gated tool executes and a final is emitted', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'tool ran' }] }));
    const tools = {
      guarded: {
        description: 'guarded',
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: true }),
        type: 'dynamic' as const,
        execute,
      },
    };
    const approvalConfig = baseConfig({
      safety: {
        compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
        toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
        approval: { mode: 'all', tools: [] },
      },
    });
    const history: ModelMessage[] = [{ role: 'user', content: 'do the thing' }];

    // Request 1: pause.
    const first = multiStepModel([toolCallStream('guarded', { x: 1 })]);
    const firstEvents: AgentEvent[] = [];
    await runAgent(approvalConfig, history, (e) => void firstEvents.push(e), undefined, {
      model: first.model,
      tools,
    });
    const paused = firstEvents.find((e) => e.type === 'run_paused');
    const request = firstEvents.find((e) => e.type === 'tool_approval_requested');
    if (paused?.type !== 'run_paused' || request?.type !== 'tool_approval_requested') {
      throw new Error('run did not pause for approval');
    }
    expect(execute).not.toHaveBeenCalled();

    // Request 2: same history + paused messages + the human decision.
    const resumed: ModelMessage[] = [
      ...history,
      ...paused.messages,
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: request.approvalId, approved: true },
        ],
      } as ModelMessage,
    ];
    const second = multiStepModel([textStream('done after approval')]);
    const secondEvents: AgentEvent[] = [];
    await runAgent(approvalConfig, resumed, (e) => void secondEvents.push(e), undefined, {
      model: second.model,
      tools,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const toolResult = secondEvents.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('no tool_result after approval');
    expect(toolResult.output.status).toBe('succeeded');
    const final = secondEvents.find((e) => e.type === 'final');
    if (final?.type !== 'final') throw new Error('no final after approval');
    expect(final.content).toBe('done after approval');
  });

  it('resumes a denied run: the tool never executes and the model is informed', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'tool ran' }] }));
    const tools = {
      guarded: {
        description: 'guarded',
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: true }),
        type: 'dynamic' as const,
        execute,
      },
    };
    const approvalConfig = baseConfig({
      safety: {
        compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
        toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
        approval: { mode: 'all', tools: [] },
      },
    });
    const history: ModelMessage[] = [{ role: 'user', content: 'do the thing' }];

    const first = multiStepModel([toolCallStream('guarded', { x: 1 })]);
    const firstEvents: AgentEvent[] = [];
    await runAgent(approvalConfig, history, (e) => void firstEvents.push(e), undefined, {
      model: first.model,
      tools,
    });
    const paused = firstEvents.find((e) => e.type === 'run_paused');
    const request = firstEvents.find((e) => e.type === 'tool_approval_requested');
    if (paused?.type !== 'run_paused' || request?.type !== 'tool_approval_requested') {
      throw new Error('run did not pause for approval');
    }

    const resumed: ModelMessage[] = [
      ...history,
      ...paused.messages,
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: request.approvalId, approved: false },
        ],
      } as ModelMessage,
    ];
    const second = multiStepModel([textStream('understood, not doing that')]);
    const secondEvents: AgentEvent[] = [];
    await runAgent(approvalConfig, resumed, (e) => void secondEvents.push(e), undefined, {
      model: second.model,
      tools,
    });

    expect(execute).not.toHaveBeenCalled();
    const denied = secondEvents.find(
      (e) => e.type === 'tool_result' && e.output.status === 'denied',
    );
    if (denied?.type !== 'tool_result') throw new Error('no denied tool_result');
    expect(denied.output.denied_reason).toBe('user_denied');
    const final = secondEvents.find((e) => e.type === 'final');
    expect(final?.type).toBe('final');
  });

  it('does not gate tools when approval mode is none', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const tools = {
      ping: {
        description: 'ping',
        inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: true }),
        type: 'dynamic' as const,
        execute,
      },
    };

    const { model } = multiStepModel([toolCallStream('ping', {}), textStream('ok')]);

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model, tools },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'tool_approval_requested')).toBe(false);
    expect(events.some((e) => e.type === 'final')).toBe(true);
  });
});

describe('runAgent — token usage in final event', () => {
  it('includes inputTokens and outputTokens in the final event', async () => {
    // textStream emits finish with inputTokens:5, outputTokens:5 per step
    const { model } = multiStepModel([textStream('done')]);

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const final = events.find((e) => e.type === 'final');
    if (final?.type !== 'final') throw new Error('no final event emitted');
    expect(typeof final.usage.inputTokens).toBe('number');
    expect(typeof final.usage.outputTokens).toBe('number');
  });

  it('accumulates usage across multiple steps', async () => {
    // tool step (inputTokens:5, outputTokens:5) + text step (inputTokens:5, outputTokens:5)
    const tools = {
      ping: fakeMcpTool({ content: [{ type: 'text', text: 'pong' }] }),
    };
    const { model } = multiStepModel([toolCallStream('ping', {}), textStream('done')]);

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'ping' }],
      (e) => void events.push(e),
      undefined,
      { model, tools },
    );

    const final = events.find((e) => e.type === 'final');
    if (final?.type !== 'final') throw new Error('no final event emitted');
    // 2 steps × 5 tokens each = 10 total for each
    expect(final.usage.inputTokens).toBe(10);
    expect(final.usage.outputTokens).toBe(10);
  });
});

describe('runAgent — structured output', () => {
  const structuredConfig = () =>
    baseConfig({
      output: {
        structured: true,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    });

  it('emits the parsed object on final and suppresses content deltas', async () => {
    const { model } = multiStepModel([textStream('{"answer":"42"}')]);

    const events: AgentEvent[] = [];
    await runAgent(
      structuredConfig(),
      [{ role: 'user', content: 'answer?' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    expect(events.some((e) => e.type === 'content_delta')).toBe(false);
    const final = events.find((e) => e.type === 'final');
    if (final?.type !== 'final') throw new Error('no final emitted');
    expect(final.structured).toEqual({ answer: '42' });
    expect(final.content).toBe('');
  });

  it('emits structured_output_failed when the model output does not match the schema', async () => {
    const { model } = multiStepModel([textStream('not json at all')]);

    const events: AgentEvent[] = [];
    await runAgent(
      structuredConfig(),
      [{ role: 'user', content: 'answer?' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const error = events.find((e) => e.type === 'error');
    if (error?.type !== 'error') throw new Error('expected error event');
    expect(error.code).toBe('structured_output_failed');
    expect(events.some((e) => e.type === 'final')).toBe(false);
  });
});

describe('diagnoseStep', () => {
  it('returns max_tokens_reached when finishReason is length', () => {
    const result = diagnoseStep({ finishReason: 'length', stepText: 'truncated' });
    expect(result?.code).toBe('max_tokens_reached');
    expect(result?.partialContent).toBe('truncated');
  });

  it('omits partialContent when stepText is empty', () => {
    const result = diagnoseStep({ finishReason: 'length', stepText: '' });
    expect(result?.code).toBe('max_tokens_reached');
    expect(result?.partialContent).toBeUndefined();
  });

  it('returns null for a normal stop', () => {
    const result = diagnoseStep({ finishReason: 'stop', stepText: 'done' });
    expect(result).toBeNull();
  });
});

describe('runAgent — error propagation integration', () => {
  it('emits rate_limit_tokens with whitelisted headers only on a 429 APICallError', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: 'Rate limit exceeded',
          url: 'https://api.example.com/v1/chat',
          requestBodyValues: { messages: ['SECRET PROMPT'] },
          statusCode: 429,
          responseHeaders: {
            'retry-after': '60',
            'x-ratelimit-remaining-tokens': '0',
            'x-organization-id': 'org-secret',
            'request-id': 'req-123',
          },
          responseBody: '{"error":"rate_limit_exceeded","account":"acct-secret"}',
          isRetryable: false,
        });
      },
    });

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const error = events.find((e) => e.type === 'error');
    expect(error?.type).toBe('error');
    if (error?.type === 'error') {
      expect(error.code).toBe('rate_limit_tokens');
      expect(error.details).toEqual({
        statusCode: 429,
        responseHeaders: { 'retry-after': '60', 'x-ratelimit-remaining-tokens': '0' },
      });
      // Nothing from the provider request/response beyond the whitelist leaves
      // the server.
      expect(JSON.stringify(error)).not.toContain('SECRET PROMPT');
      expect(JSON.stringify(error)).not.toContain('acct-secret');
      expect(JSON.stringify(error)).not.toContain('org-secret');
    }
  });

  it('emits stream_error with partialContent when stream errors mid-response', async () => {
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'partial response' },
      { type: 'error', error: new Error('connection reset') },
    ];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
    });

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const error = events.find((e) => e.type === 'error');
    if (error?.type !== 'error') throw new Error('expected error event');
    expect(error.code).toBe('stream_error');
    expect((error as { partialContent?: string }).partialContent).toBe('partial response');
  });

  it('emits stream_error when stream part error is a plain object', async () => {
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: { code: 'unknown', reason: 'bad' } },
    ];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
    });

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const error = events.find((e) => e.type === 'error');
    if (error?.type !== 'error') throw new Error('expected error event');
    expect(error.code).toBe('stream_error');
    expect(error.message).toContain('unknown');
  });

  it('emits stream_error with string message when stream part error is a string', async () => {
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: 'plain string error' },
    ];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
    });

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const error = events.find((e) => e.type === 'error');
    if (error?.type !== 'error') throw new Error('expected error event');
    expect(error.code).toBe('stream_error');
    expect(error.message).toBe('plain string error');
  });

  it('emits max_tokens_reached via full loop when finishReason is length', async () => {
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'cut off' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        usage: V3_USAGE,
        finishReason: { unified: 'length', raw: 'length' },
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
    });

    const events: AgentEvent[] = [];
    await runAgent(
      baseConfig(),
      [{ role: 'user', content: 'go' }],
      (e) => void events.push(e),
      undefined,
      { model },
    );

    const error = events.find((e) => e.type === 'error');
    if (error?.type !== 'error') throw new Error('expected error event');
    expect(error.code).toBe('max_tokens_reached');
    expect((error as { partialContent?: string }).partialContent).toBe('cut off');
  });
});
