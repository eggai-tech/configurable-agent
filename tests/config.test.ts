import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/load.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wally-cfg-'));
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
    expect(cfg.tools.bash.enabled).toBe(false);
    expect(cfg.output.structured).toBe(false);
  });

  it('accepts a full config with structured output', () => {
    const path = write(
      'config.yaml',
      `systemPrompt: "be precise"
model:
  provider: openai
  name: gpt-4o
  temperature: 0.1
agent:
  maxSteps: 5
tools:
  bash:
    enabled: true
    timeoutMs: 5000
  websearch:
    enabled: true
output:
  structured: true
  schema:
    type: object
    properties:
      answer: { type: string }
    required: [answer]
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.agent.maxSteps).toBe(5);
    expect(cfg.tools.bash.timeoutMs).toBe(5000);
    expect(cfg.output.structured).toBe(true);
    if (cfg.output.structured) {
      expect(cfg.output.schema).toMatchObject({ type: 'object' });
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
});
