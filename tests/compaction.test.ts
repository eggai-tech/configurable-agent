import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/events.js';
import { maybeCompactMessages } from '../src/agent/safety/compaction.js';
import { countTextTokens } from '../src/agent/safety/tokens.js';
import type { AgentConfig } from '../src/config/schema.js';

function cfg(overrides: Partial<AgentConfig['safety']['compaction']> = {}): AgentConfig {
  return {
    systemPrompt: 'SYS',
    model: { provider: 'anthropic', name: 'x' },
    agent: { maxSteps: 10 },
    mcpTools: [],
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100, keepRecentMessages: 2, ...overrides },
      toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
      approval: { mode: 'none', tools: [] },
    },
  };
}

function events(): { emit: (e: AgentEvent) => void; seen: AgentEvent[] } {
  const seen: AgentEvent[] = [];
  return { emit: (e) => void seen.push(e), seen };
}

describe('maybeCompactMessages', () => {
  it('returns messages unchanged when under trigger', async () => {
    const { emit, seen } = events();
    const summarize = vi.fn();
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ];
    const out = await maybeCompactMessages({ messages, config: cfg(), summarize, emit });
    expect(out).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('summarizes earlier turns and emits start/finished events', async () => {
    const { emit, seen } = events();
    const bigContent = 'x'.repeat(400);
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: `Q1 ${bigContent}` },
      { role: 'assistant', content: `A1 ${bigContent}` },
      { role: 'user', content: `Q2 ${bigContent}` },
      { role: 'assistant', content: `A2 ${bigContent}` },
      { role: 'user', content: 'Q3 short' },
      { role: 'assistant', content: 'A3 short' },
    ];
    const summarize = vi.fn(async () => 'brief summary');

    const out = await maybeCompactMessages({ messages, config: cfg(), summarize, emit });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(seen[0]?.type).toBe('compaction_start');
    expect(seen[1]?.type).toBe('compaction_finished');

    // System preserved
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    // Summary injected as a synthetic user message (provider-safe even when
    // the kept recent turns start with an assistant message)
    expect(out[1]?.role).toBe('user');
    expect(String(out[1]?.content)).toContain('brief summary');
    // Recent turns preserved verbatim
    expect(out.slice(-2)).toEqual([
      { role: 'user', content: 'Q3 short' },
      { role: 'assistant', content: 'A3 short' },
    ]);
  });

  it('keeps the run alive when summarization fails, dropping earlier turns', async () => {
    const { emit, seen } = events();
    const bigContent = 'x'.repeat(400);
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: `Q1 ${bigContent}` },
      { role: 'assistant', content: `A1 ${bigContent}` },
      { role: 'user', content: `Q2 ${bigContent}` },
      { role: 'assistant', content: `A2 ${bigContent}` },
      { role: 'user', content: 'Q3 short' },
      { role: 'assistant', content: 'A3 short' },
    ];
    const summarize = vi.fn(async () => {
      throw new Error('summarizer offline');
    });

    const out = await maybeCompactMessages({ messages, config: cfg(), summarize, emit });

    // No throw: compaction completes with a placeholder instead of failing.
    expect(seen[1]?.type).toBe('compaction_finished');
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(String(out[1]?.content)).toContain('summarization unavailable');
    expect(out.slice(-2)).toEqual([
      { role: 'user', content: 'Q3 short' },
      { role: 'assistant', content: 'A3 short' },
    ]);
  });

  it('compaction_finished reports smaller token count than compaction_start', async () => {
    const { emit, seen } = events();
    const bigContent = 'lorem ipsum dolor sit amet '.repeat(40);
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: bigContent },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: bigContent },
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'recent' },
    ];
    const summarize = async () => 'tiny';
    await maybeCompactMessages({ messages, config: cfg(), summarize, emit });

    const start = seen.find((e) => e.type === 'compaction_start');
    const finished = seen.find((e) => e.type === 'compaction_finished');
    expect(start?.type === 'compaction_start' && finished?.type === 'compaction_finished').toBe(
      true,
    );
    if (start?.type === 'compaction_start' && finished?.type === 'compaction_finished') {
      expect(finished.after.tokens).toBeLessThan(start.before.tokens);
      expect(finished.droppedCount).toBeGreaterThan(0);
    }
  });

  it('replaces older synthetic summaries instead of accumulating them forever', async () => {
    const { emit } = events();
    const bigContent = 'x'.repeat(400);
    const summarize = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first summary')
      .mockResolvedValueOnce('second summary');

    const firstPass = await maybeCompactMessages({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: `Q1 ${bigContent}` },
        { role: 'assistant', content: `A1 ${bigContent}` },
        { role: 'user', content: `Q2 ${bigContent}` },
        { role: 'assistant', content: `A2 ${bigContent}` },
        { role: 'user', content: 'Q3 short' },
        { role: 'assistant', content: 'A3 short' },
      ],
      config: cfg(),
      summarize,
      emit,
    });

    const secondPass = await maybeCompactMessages({
      messages: [
        ...firstPass,
        { role: 'user', content: `Q4 ${bigContent}` },
        { role: 'assistant', content: `A4 ${bigContent}` },
      ],
      config: cfg(),
      summarize,
      emit,
    });

    const summaries = secondPass.filter((m) => String(m.content).includes('[COMPACTED CONTEXT]'));
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0]?.content)).toContain('second summary');
    expect(secondPass[0]).toEqual({ role: 'system', content: 'SYS' });
  });

  it('compacts a tool-loop history whose only user message is the original request', async () => {
    const { emit, seen } = events();
    const big = 'x'.repeat(400);
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: `calling tool A ${big}` },
      { role: 'tool', content: [] },
      { role: 'assistant', content: `calling tool B ${big}` },
      { role: 'tool', content: [] },
      { role: 'assistant', content: `calling tool C ${big}` },
      { role: 'tool', content: [] },
    ];
    const summarize = vi.fn(async () => 'tool-loop summary');

    const out = await maybeCompactMessages({ messages, config: cfg(), summarize, emit });

    expect(seen.some((e) => e.type === 'compaction_finished')).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    // Recent window must not start on a tool message (would orphan tool results
    // from their assistant tool-call).
    const summaryIdx = out.findIndex((m) => String(m.content).includes('[COMPACTED CONTEXT]'));
    expect(summaryIdx).toBe(1);
    expect(out[summaryIdx + 1]?.role).not.toBe('tool');
  });
});

describe('countTextTokens', () => {
  it('returns positive counts for non-empty text', () => {
    expect(countTextTokens('hello world')).toBeGreaterThan(0);
  });
  it('returns 0 for empty string', () => {
    expect(countTextTokens('')).toBe(0);
  });
});
