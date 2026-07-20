import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ToolResult } from '../src/agent/events.js';
import { maybeSummarizeToolOutput } from '../src/agent/safety/tool-summary.js';
import type { AgentConfig } from '../src/config/schema.js';

function cfg(overrides: Partial<AgentConfig['safety']['toolOutput']> = {}): AgentConfig {
  return {
    systemPrompt: 'SYS',
    model: { provider: 'anthropic', name: 'x' },
    agent: { maxSteps: 10 },
    mcpTools: [],
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
      toolOutput: { triggerChars: 200, headChars: 20, tailChars: 20, ...overrides },
      approval: { mode: 'none', tools: [] },
    },
  };
}

function recorder() {
  const seen: AgentEvent[] = [];
  return { emit: (e: AgentEvent) => void seen.push(e), seen };
}

function envelope(content: string): ToolResult {
  return {
    label: 'some-tool',
    status: 'succeeded',
    content,
    return_code: null,
    args: {},
    duration_ms: 1,
  };
}

describe('maybeSummarizeToolOutput', () => {
  it('passes through small envelopes unchanged', async () => {
    const { seen } = recorder();
    const summarize = vi.fn();
    const input = envelope('hello');
    const out = await maybeSummarizeToolOutput(input, 'some-tool', {
      config: cfg(),
      summarize,
    });
    expect(out).toBe(input);
    expect(out.truncated).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('summarizes oversized content and marks envelope truncated', async () => {
    const { seen } = recorder();
    const summarize = vi.fn(async () => 'the output listed 1000 rows, all green');
    const big = 'line of output '.repeat(200);
    const out = await maybeSummarizeToolOutput(envelope(big), 'some-tool', {
      config: cfg(),
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('1000 rows');
    expect(out.content).toContain('HEAD');
    expect(out.content).toContain('TAIL');
    expect(out.label).toBe('some-tool');
    expect(out.return_code).toBeNull();
    expect(seen).toEqual([]);
  });

  it('falls back to truncation (still succeeded) when summarization throws', async () => {
    const summarize = vi.fn(async () => {
      throw new Error('summarizer offline');
    });
    const big = 'line of output '.repeat(200);
    const out = await maybeSummarizeToolOutput(envelope(big), 'some-tool', {
      config: cfg(),
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    // The tool succeeded; a summarizer outage must not turn it into an error.
    expect(out.status).toBe('succeeded');
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('summary unavailable');
    expect(out.content).toContain('HEAD');
    expect(out.content).toContain('TAIL');
  });

  it('does not leak the full raw output when tailChars is 0', async () => {
    const summarize = vi.fn(async () => 'short summary');
    const big = `START${'x'.repeat(3000)}END`;
    const out = await maybeSummarizeToolOutput(envelope(big), 'some-tool', {
      config: cfg({ tailChars: 0 }),
      summarize,
    });

    expect(out.truncated).toBe(true);
    expect(out.content).not.toContain('END');
    expect(out.content).not.toContain('TAIL');
    expect(out.content.length).toBeLessThan(500);
  });
});
