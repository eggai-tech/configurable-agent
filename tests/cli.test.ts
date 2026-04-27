import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV2, convertArrayToReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTraceparent } from '../src/cli/stdio.js';
import { runCli } from '../src/modes/run.js';

type StreamPart = LanguageModelV2StreamPart;

const BASE_YAML = `
systemPrompt: SYSTEM
model:
  provider: anthropic
  name: stub
agent:
  maxSteps: 3
tools:
  bash:
    enabled: false
  websearch:
    enabled: false
  http:
    enabled: false
  todowrite:
    enabled: false
`;

const BASH_ALLOW_ECHO_YAML = `
systemPrompt: SYSTEM
model:
  provider: anthropic
  name: stub
agent:
  maxSteps: 3
tools:
  bash:
    enabled: true
    timeoutMs: 5000
    maxBufferBytes: 64000
    policy:
      approval:
        enabled: false
      allow: ['echo']
  websearch:
    enabled: false
  http:
    enabled: false
  todowrite:
    enabled: false
`;

const BASH_APPROVAL_REQUIRED_YAML = `
systemPrompt: SYSTEM
model:
  provider: anthropic
  name: stub
agent:
  maxSteps: 3
tools:
  bash:
    enabled: true
    timeoutMs: 5000
    maxBufferBytes: 64000
    policy:
      approval:
        enabled: true
      disableBuiltinAllow: true
      allow: []
      ask: []
      deny: []
  websearch:
    enabled: false
  http:
    enabled: false
  todowrite:
    enabled: false
`;

const BASH_ONE_STEP_YAML = `
systemPrompt: SYSTEM
model:
  provider: anthropic
  name: stub
agent:
  maxSteps: 1
tools:
  bash:
    enabled: true
    timeoutMs: 5000
    maxBufferBytes: 64000
    policy:
      approval:
        enabled: false
      allow: ['echo']
  websearch:
    enabled: false
  http:
    enabled: false
  todowrite:
    enabled: false
`;

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

function toolCallStream(toolCallId: string, command: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'bash',
      input: JSON.stringify({ command, intent: 'test tool call' }),
    },
    {
      type: 'finish',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      finishReason: 'tool-calls',
    },
  ];
}

function mockModel(streams: Array<StreamPart[]>): MockLanguageModelV2 {
  let idx = 0;
  return new MockLanguageModelV2({
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
  modelOverride?: MockLanguageModelV2;
  env?: NodeJS.ProcessEnv;
  configPath?: string; // explicit override to force a bad path
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

  // Give the captured streams a tick to flush.
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

describe('wally run CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wally-cli-'));
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

  it('tool call + final — completes through a tool-using turn', async () => {
    const r = await invoke({
      dir,
      configYaml: BASH_ALLOW_ECHO_YAML,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
      modelOverride: mockModel([toolCallStream('tc1', 'echo hi'), textStream('done')]),
    });

    expect(r.code).toBe(0);
    const rec = lastJsonLine(r.stdout) as Record<string, unknown>;
    expect(rec).toEqual({ ok: true, finalText: 'done', error: null });
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
    expect(r.stderr).toContain('wally run --config');
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

  it('approval required halts gracefully — ok:false, exit 0, error mentions approval', async () => {
    const r = await invoke({
      dir,
      configYaml: BASH_APPROVAL_REQUIRED_YAML,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'please echo' }] }),
      modelOverride: mockModel([toolCallStream('tc1', 'echo needs-approval')]),
    });

    expect(r.code).toBe(0);
    const rec = lastJsonLine(r.stdout) as { ok: boolean; error: string | null };
    expect(rec.ok).toBe(false);
    expect(rec.error).toMatch(/approval/i);
  });

  it('tool_call_on_final_step error → ok:false, exit 0, error populated', async () => {
    const r = await invoke({
      dir,
      configYaml: BASH_ONE_STEP_YAML,
      stdinBody: JSON.stringify({ messages: [{ role: 'user', content: 'do it' }] }),
      modelOverride: mockModel([toolCallStream('tc1', 'echo hi')]),
    });

    expect(r.code).toBe(0);
    const rec = lastJsonLine(r.stdout) as { ok: boolean; error: string | null };
    expect(rec.ok).toBe(false);
    expect(rec.error).toBeTruthy();
    expect(rec.error ?? '').toMatch(/final step/i);
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
