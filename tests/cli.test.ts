import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTraceparent } from '../src/cli/stdio.js';
import { runCli } from '../src/modes/run.js';

type StreamPart = LanguageModelV3StreamPart;

const BASE_YAML = `
systemPrompt: SYSTEM
model:
  provider: anthropic
  name: stub
agent:
  maxSteps: 3
`;

const STUB_USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

const STUB_FINISH = { unified: 'stop', raw: undefined } as const;

function textStream(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: STUB_USAGE,
      finishReason: STUB_FINISH,
    },
  ];
}

function mockModel(streams: Array<StreamPart[]>): MockLanguageModelV3 {
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = streams[idx++];
      if (!parts) throw new Error(`mock model: no stream queued for call #${idx}`);
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

async function invoke(opts: {
  configYaml: string;
  stdinBody: string;
  argv?: string[];
  modelOverride?: MockLanguageModelV3;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  dir: string;
}): Promise<Captured> {
  const configPath = opts.configPath ?? join(opts.dir, 'config.yaml');
  if (opts.configPath === undefined) {
    writeFileSync(configPath, opts.configYaml, 'utf8');
  }

  const stdin = new PassThrough();
  stdin.end(opts.stdinBody);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on('data', (c) => outChunks.push(Buffer.from(c)));
  stderr.on('data', (c) => errChunks.push(Buffer.from(c)));

  const argv = opts.argv ?? ['--config', configPath];

  const code = await runCli({
    argv,
    stdin,
    stdout,
    stderr,
    env: opts.env ?? {},
    modelOverride: opts.modelOverride,
  });

  await new Promise((r) => setImmediate(r));

  return {
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
    code,
  };
}

function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error('stdout had no non-empty lines');
  return JSON.parse(last);
}

describe('configurable-agent run CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'configurable-agent-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy path — text-only final response', async () => {
    const r = await invoke({
      dir,
      configYaml: BASE_YAML,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      modelOverride: mockModel([textStream('hello')]),
    });

    expect(r.code).toBe(0);
    const rec = lastJsonLine(r.stdout) as Record<string, unknown>;
    expect(rec).toEqual({ ok: true, finalText: 'hello', error: null });
  });

  it('invalid stdin JSON → exit 2, stderr set, stdout empty', async () => {
    const r = await invoke({
      dir,
      configYaml: BASE_YAML,
      stdinBody: 'not json',
    });

    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stdout).toBe('');
  });

  it('missing --config → exit 2, usage on stderr', async () => {
    const r = await invoke({
      dir,
      configYaml: BASE_YAML,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      argv: [],
    });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('configurable-agent run --config');
    expect(r.stdout).toBe('');
  });

  it('bad config path → exit 2, stderr names the path', async () => {
    const bogus = join(dir, 'does-not-exist.yaml');
    const r = await invoke({
      dir,
      configYaml: BASE_YAML,
      configPath: bogus,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain(bogus);
    expect(r.stdout).toBe('');
  });

  it('invalid config (unknown key) → exit 2, stderr set', async () => {
    const r = await invoke({
      dir,
      configYaml: `
systemPrompt: SYSTEM
model:
  provider: anthropic
  name: stub
unknownKey: true
`,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stdout).toBe('');
  });

  it('stdout has exactly one JSON line (regression guard)', async () => {
    const r = await invoke({
      dir,
      configYaml: BASE_YAML,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      modelOverride: mockModel([textStream('hello')]),
    });

    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const only = lines[0];
    if (!only) throw new Error('expected one line');
    expect(() => JSON.parse(only)).not.toThrow();
  });
});

describe('parseTraceparent', () => {
  it('parses a valid W3C traceparent', () => {
    const ctx = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(ctx).not.toBeNull();
    expect(ctx?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx?.spanId).toBe('b7ad6b7169203331');
    expect(ctx?.isRemote).toBe(true);
  });

  it('returns null for invalid shapes', () => {
    expect(parseTraceparent('00-tooShort-xxxx-01')).toBeNull();
    expect(parseTraceparent('bad')).toBeNull();
    expect(parseTraceparent('')).toBeNull();
  });

  it('returns null for missing value', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('returns null when traceId is all zeros', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-b7ad6b7169203331-01`)).toBeNull();
  });
});
