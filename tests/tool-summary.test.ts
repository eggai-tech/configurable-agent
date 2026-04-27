import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/events.js';
import { maybeSummarizeToolOutput } from '../src/agent/safety/tool-summary.js';
import type { ToolResult } from '../src/agent/tools/result.js';
import type { AgentConfig } from '../src/config/schema.js';

function cfg(overrides: Partial<AgentConfig['safety']['toolOutput']> = {}): AgentConfig {
  return {
    systemPrompt: 'SYS',
    model: { provider: 'anthropic', name: 'x' },
    agent: { maxSteps: 10 },
    tools: {
      bash: {
        enabled: false,
        timeoutMs: 30_000,
        maxBufferBytes: 1_048_576,
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
    },
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
      toolOutput: { triggerTokens: 50, headChars: 20, tailChars: 20, ...overrides },
    },
  };
}

function recorder() {
  const seen: AgentEvent[] = [];
  return { emit: (e: AgentEvent) => void seen.push(e), seen };
}

function runtimeExtras() {
  return {
    approvals: new Map(),
    sessionAllowRules: new Set<string>(),
    pendingApprovals: new Set<string>(),
  };
}

function envelope(content: string): ToolResult {
  return {
    label: 'bash',
    status: 'succeeded',
    content,
    return_code: 0,
    args: { command: 'echo hi' },
    duration_ms: 1,
  };
}

describe('maybeSummarizeToolOutput', () => {
  it('passes through small envelopes unchanged', async () => {
    const { emit, seen } = recorder();
    const summarize = vi.fn();
    const input = envelope('hello');
    const out = await maybeSummarizeToolOutput(input, 'call-1', 'bash', {
      config: cfg(),
      emit,
      summarize,
      ...runtimeExtras(),
    });
    expect(out).toBe(input);
    expect(out.truncated).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('summarizes oversized content and marks envelope truncated', async () => {
    const { emit, seen } = recorder();
    const summarize = vi.fn(async () => 'the output listed 1000 rows, all green');
    const big = 'line of output '.repeat(200);
    const out = await maybeSummarizeToolOutput(envelope(big), 'call-2', 'bash', {
      config: cfg(),
      emit,
      summarize,
      ...runtimeExtras(),
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('1000 rows');
    expect(out.content).toContain('HEAD');
    expect(out.content).toContain('TAIL');
    expect(out.label).toBe('bash');
    expect(out.return_code).toBe(0);
    expect(seen).toEqual([]);
  });
});
