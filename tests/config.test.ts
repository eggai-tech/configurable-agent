import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/load.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'configurable-agent-cfg-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: string): string {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    return p;
  }

  it('accepts a minimal valid config', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be helpful"
model:
  provider: anthropic
  name: claude-sonnet-4-6
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.systemPrompt).toBe('be helpful');
    expect(cfg.agent.maxSteps).toBe(10);
    expect(cfg.mcpTools).toEqual([]);
    expect(cfg.output.structured).toBe(false);
  });

  it('accepts a config with mcpTools stdio server', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be precise"
model:
  provider: openai
  name: gpt-4o
  temperature: 0.1
agent:
  maxSteps: 5
mcpTools:
  - name: accounts
    transport: stdio
    command: accounts-mcp
    env:
      ACCOUNTS_URL: http://accounts:8080
output:
  structured: false
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.agent.maxSteps).toBe(5);
    expect(cfg.mcpTools).toHaveLength(1);
    const server = cfg.mcpTools[0];
    expect(server?.name).toBe('accounts');
    expect(server?.transport).toBe('stdio');
    if (server?.transport === 'stdio') {
      expect(server.command).toBe('accounts-mcp');
      expect(server.env).toEqual({ ACCOUNTS_URL: 'http://accounts:8080' });
    }
  });

  it('accepts a config with mcpTools http server', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "ok"
model:
  provider: anthropic
  name: claude-sonnet-4-6
mcpTools:
  - name: files
    transport: http
    url: https://files.internal/mcp
    headers:
      X-Tenant: acme
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.mcpTools).toHaveLength(1);
    const server = cfg.mcpTools[0];
    expect(server?.transport).toBe('http');
    if (server?.transport === 'http') {
      expect(server.url).toBe('https://files.internal/mcp');
      expect(server.headers).toEqual({ 'X-Tenant': 'acme' });
    }
  });

  it('throws ConfigError for invalid YAML', () => {
    const path = write('config.yaml', 'this: is: not: yaml: [');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError for missing required fields', () => {
    const path = write('config.yaml', 'systemPrompt: ""\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError for unknown provider', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "ok"
model:
  provider: cohere
  name: command
`,
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid JSON Schema in structured output', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "ok"
model:
  provider: anthropic
  name: claude-sonnet-4-6
output:
  structured: true
  schema:
    type: nonsense
`,
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError when file does not exist', () => {
    expect(() => loadConfig(join(dir, 'missing.yaml'))).toThrow(ConfigError);
  });

  it('throws ConfigError for mcpTools stdio server missing command', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "ok"
model:
  provider: anthropic
  name: claude-sonnet-4-6
mcpTools:
  - name: broken
    transport: stdio
`,
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('throws ConfigError for mcpTools http server with invalid url', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "ok"
model:
  provider: anthropic
  name: claude-sonnet-4-6
mcpTools:
  - name: broken
    transport: http
    url: not-a-url
`,
    );
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('accepts an optional evals.dir field', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be helpful"
model:
  provider: anthropic
  name: claude-sonnet-4-6
evals:
  dir: ./mo-evals
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.evals?.dir).toBe('./mo-evals');
  });

  it('leaves evals undefined when absent', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be helpful"
model:
  provider: anthropic
  name: claude-sonnet-4-6
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.evals).toBeUndefined();
  });

  it('accepts openai-compatible provider with baseUrl', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be helpful"
model:
  provider: openai-compatible
  name: mistral-small-latest
  baseUrl: https://api.mistral.ai/v1
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.model.provider).toBe('openai-compatible');
    expect(cfg.model.name).toBe('mistral-small-latest');
    expect(cfg.model.baseUrl).toBe('https://api.mistral.ai/v1');
  });

  it('accepts openai-compatible provider without baseUrl (unauthenticated endpoints)', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be helpful"
model:
  provider: openai-compatible
  name: llama3
  baseUrl: http://localhost:11434/v1
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.model.provider).toBe('openai-compatible');
    expect(cfg.model.baseUrl).toBe('http://localhost:11434/v1');
  });
});
