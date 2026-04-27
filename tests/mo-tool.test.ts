import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/events.js';
import { createMoRunTool } from '../src/agent/tools/mo.js';
import type { ToolResult } from '../src/agent/tools/result.js';
import type { AgentConfig } from '../src/config/schema.js';

const { runEvalsMock, buildJsonSummaryMock } = vi.hoisted(() => ({
  runEvalsMock: vi.fn(),
  buildJsonSummaryMock: vi.fn(),
}));

vi.mock('@eggai-tech/mo', () => ({
  runEvals: runEvalsMock,
  buildJsonSummary: buildJsonSummaryMock,
}));

function baseConfig(): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'stub' },
    agent: { maxSteps: 3 },
    tools: {
      bash: {
        enabled: false,
        timeoutMs: 5_000,
        maxBufferBytes: 64_000,
        policy: {
          approval: { enabled: false },
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
      moRun: { enabled: true, timeoutMs: 300_000, maxBufferBytes: 4_194_304 },
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

function runtime() {
  const { emit, seen } = recorder();
  return {
    ctx: {
      config: baseConfig(),
      emit,
      summarize: async () => 'summary',
      approvals: new Map(),
      sessionAllowRules: new Set<string>(),
      pendingApprovals: new Set<string>(),
    },
    seen,
  };
}

async function executeMoTool(
  tool: ReturnType<typeof createMoRunTool>,
  args: { configPath: string; intent: string },
): Promise<ToolResult> {
  if (!tool.execute) {
    throw new Error('tool.execute is unavailable');
  }
  const raw = await tool.execute(args, {
    toolCallId: 'tc',
    messages: [],
    abortSignal: undefined,
  });
  if (isAsyncIterable<ToolResult>(raw)) {
    throw new Error('expected a plain ToolResult');
  }
  return raw;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    Symbol.asyncIterator in value
  );
}

describe('createMoRunTool', () => {
  it('returns a timeout error when eval execution exceeds timeoutMs', async () => {
    runEvalsMock.mockReset();
    buildJsonSummaryMock.mockReset();
    runEvalsMock.mockImplementation(() => new Promise(() => undefined));

    const { ctx, seen } = runtime();
    const tool = createMoRunTool({ timeoutMs: 20, maxBufferBytes: 1024 }, ctx);

    const result = await executeMoTool(tool, {
      configPath: '/tmp/wally.yaml',
      intent: 'Run evals',
    });

    expect(result.status).toBe('error');
    expect(result.return_code).toBe(124);
    expect(result.content).toContain('timed out');

    const streamEnd = seen.find((e) => e.type === 'tool_stream_end');
    if (streamEnd?.type !== 'tool_stream_end') throw new Error('missing tool_stream_end');
    expect(streamEnd.exitCode).toBe(124);
    expect(streamEnd.timedOut).toBe(true);
  });

  it('caps streamed and returned summary bytes at maxBufferBytes', async () => {
    runEvalsMock.mockReset();
    buildJsonSummaryMock.mockReset();

    runEvalsMock.mockResolvedValue({
      failed: 0,
      errored: 0,
    });
    buildJsonSummaryMock.mockReturnValue({
      huge: 'x'.repeat(200),
    });

    const { ctx, seen } = runtime();
    const tool = createMoRunTool({ timeoutMs: 100, maxBufferBytes: 40 }, ctx);

    const result = await executeMoTool(tool, {
      configPath: '/tmp/wally.yaml',
      intent: 'Run evals',
    });

    expect(result.status).toBe('succeeded');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(40);

    const streamed = seen
      .filter((e) => e.type === 'tool_output_chunk')
      .map((e) => (e.type === 'tool_output_chunk' ? e.text : ''))
      .join('');
    expect(Buffer.byteLength(streamed, 'utf8')).toBeLessThanOrEqual(40);

    const streamEnd = seen.find((e) => e.type === 'tool_stream_end');
    if (streamEnd?.type !== 'tool_stream_end') throw new Error('missing tool_stream_end');
    expect(streamEnd.truncated).toBe(true);
  });
});
