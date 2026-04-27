import { describe, expect, it } from 'vitest';
import { buildMcpTools } from '../src/agent/tools/mcp.js';
import type { AgentConfig } from '../src/config/schema.js';

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'stub' },
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

describe('buildMcpTools', () => {
  it('returns empty tools and cleanup when no servers are configured', async () => {
    const { tools, cleanup } = await buildMcpTools(baseConfig());
    expect(Object.keys(tools)).toHaveLength(0);
    await expect(cleanup()).resolves.not.toThrow();
  });
});
