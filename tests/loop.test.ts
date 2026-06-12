import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { jsonSchema } from 'ai';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
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

type StreamPart = LanguageModelV2StreamPart;

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
  prompt: LanguageModelV2CallOptions['prompt'];
}

function multiStepModel(
  streams: StreamPart[][],
  opts: { summarizeText?: string } = {},
): {
  model: MockLanguageModelV2;
  calls: DoStreamCall[];
} {
  const calls: DoStreamCall[] = [];
  let idx = 0;
  const model = new MockLanguageModelV2({
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
      finishReason: 'stop' as const,
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
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
        },
      }),
      [{ role: 'user', content: 'fetch huge thing' }],
      (e) => void events.push(e),
      undefined,
      { model, tools: tools as never },
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
      { model, tools: tools as never },
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
        tools: tools as never,
      });
    }

    // Same tool object was used both times — execute fires once per request.
    expect(execute).toHaveBeenCalledTimes(2);
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
    expect(final).toHaveProperty('usage');
    const usage = (final as { usage?: { inputTokens: number; outputTokens: number } }).usage;
    expect(usage).toBeDefined();
    expect(typeof usage?.inputTokens).toBe('number');
    expect(typeof usage?.outputTokens).toBe('number');
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
      { model, tools: tools as never },
    );

    const final = events.find((e) => e.type === 'final');
    if (final?.type !== 'final') throw new Error('no final event emitted');
    const usage = (final as { usage?: { inputTokens: number; outputTokens: number } }).usage;
    expect(usage).toBeDefined();
    // 2 steps × 5 tokens each = 10 total for each
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(10);
  });
});

describe('diagnoseStep', () => {
  const noHeaders = {};

  it('returns rate_limit_tokens when remaining < 5% of limit', () => {
    const result = diagnoseStep({
      finishReason: 'stop',
      stepText: 'partial',
      responseHeaders: {
        'x-ratelimit-limit-tokens': '30000',
        'x-ratelimit-remaining-tokens': '100',
        'x-ratelimit-reset-tokens': '59s',
      },
    });
    expect(result?.code).toBe('rate_limit_tokens');
    expect(result?.message).toContain('29900/30000');
    expect(result?.message).toContain('59s');
    expect(result?.partialContent).toBe('partial');
  });

  it('returns null when remaining tokens are above threshold', () => {
    const result = diagnoseStep({
      finishReason: 'stop',
      stepText: '',
      responseHeaders: {
        'x-ratelimit-limit-tokens': '30000',
        'x-ratelimit-remaining-tokens': '5000',
      },
    });
    expect(result).toBeNull();
  });

  it('returns max_tokens_reached when finishReason is length', () => {
    const result = diagnoseStep({
      finishReason: 'length',
      stepText: 'truncated',
      responseHeaders: noHeaders,
    });
    expect(result?.code).toBe('max_tokens_reached');
    expect(result?.partialContent).toBe('truncated');
  });

  it('omits partialContent when stepText is empty', () => {
    const result = diagnoseStep({
      finishReason: 'length',
      stepText: '',
      responseHeaders: noHeaders,
    });
    expect(result?.code).toBe('max_tokens_reached');
    expect(result?.partialContent).toBeUndefined();
  });

  it('returns null for a normal stop with no rate limit headers', () => {
    const result = diagnoseStep({
      finishReason: 'stop',
      stepText: 'done',
      responseHeaders: noHeaders,
    });
    expect(result).toBeNull();
  });
});

describe('runAgent — error propagation integration', () => {
  it('emits rate_limit_tokens via full loop when headers indicate exhaustion', async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: convertArrayToReadableStream(textStream('partial')),
        response: {
          headers: {
            'x-ratelimit-limit-tokens': '30000',
            'x-ratelimit-remaining-tokens': '100',
          },
        },
      }),
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
    if (error?.type === 'error') expect(error.code).toBe('rate_limit_tokens');
  });

  it('emits stream_error with partialContent when stream errors mid-response', async () => {
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'partial response' },
      { type: 'error', error: new Error('connection reset') },
    ];
    const model = new MockLanguageModelV2({
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

  it('emits max_tokens_reached via full loop when finishReason is length', async () => {
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'cut off' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        finishReason: 'length',
      },
    ];
    const model = new MockLanguageModelV2({
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
