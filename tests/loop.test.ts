import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { prepareMessages } from '../src/agent/loop.js';
import type { AgentConfig } from '../src/config/schema.js';

function baseConfig(): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
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
      toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
    },
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
