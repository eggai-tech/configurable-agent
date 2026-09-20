import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config/load.js';
import type { AgentConfig } from '../src/config/schema.js';

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
    agent: { maxSteps: 10 },
    mcpTools: [],
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
      toolOutput: { triggerChars: 16_000, headChars: 500, tailChars: 500 },
      approval: { mode: 'none', tools: [] },
    },
    ...overrides,
  };
}

function textModel(text: string): MockLanguageModelV3 {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      finishReason: { unified: 'stop', raw: 'stop' },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
  });
}

/** Parse an SSE payload into [{event, data}] entries. */
function parseSse(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1] ?? '';
      const data = /data: (.+)/.exec(block)?.[1] ?? '';
      return { event, data: JSON.parse(data) };
    });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = buildServer(baseConfig(), { tools: {} });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns 503 when the provider API key env var is missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const app = buildServer(baseConfig(), { tools: {} });
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'not_ready',
      reason: 'ANTHROPIC_API_KEY is not set',
    });
  });

  it('returns ok when the provider API key env var is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const app = buildServer(baseConfig(), { tools: {} });
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('deep probe failure returns 503 without leaking the provider error', async () => {
    // Unreachable baseUrl: the probe fails fast with a connection error whose
    // message names the endpoint — that detail must stay out of the response.
    const config = baseConfig({
      model: { provider: 'ollama', name: 'test', baseUrl: 'http://127.0.0.1:1/v1' },
    });
    const app = buildServer(config, { tools: {} });
    const res = await app.request('/ready?deep=1');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: 'not_ready', reason: 'provider probe failed' });
  });
});

describe('POST /invoke — request validation', () => {
  it('rejects malformed JSON with 400', async () => {
    const app = buildServer(baseConfig(), { tools: {} });
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('rejects a schema-invalid body with 400 and a readable message', async () => {
    const app = buildServer(baseConfig(), { tools: {} });
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toContain('at least one message');
  });

  it('rejects an oversized body with 413', async () => {
    vi.stubEnv('MAX_REQUEST_BODY_BYTES', '1024');
    const app = buildServer(baseConfig(), { tools: {} });
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'x'.repeat(4096) }],
      }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large', maxBytes: 1024 });
  });
});

describe('POST /invoke — streaming', () => {
  it('streams content deltas and a final event over SSE with a request id', async () => {
    const app = buildServer(baseConfig(), { tools: {}, model: textModel('hello world') });
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const events = parseSse(await res.text());
    const deltas = events.filter((e) => e.event === 'content_delta');
    expect(deltas.map((e) => (e.data as { text: string }).text).join('')).toBe('hello world');

    const final = events.at(-1);
    expect(final?.event).toBe('final');
    expect(final?.data).toMatchObject({
      content: 'hello world',
      stopReason: 'stop',
      steps: 1,
      usage: { inputTokens: 5, outputTokens: 5 },
    });
  });
});

describe('POST /invoke — system prompt context', () => {
  let dir: string;
  let config: AgentConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'configurable-agent-context-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      `systemPrompt: >-
  You are the {{team}} assistant for {{system_prompt_context.tenant.name}}. Today is {{today}}.
promptVars:
  team: Platform
model:
  provider: anthropic
  name: stub
`,
    );
    config = loadConfig(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders each request context from YAML through to the model and streams a final response', async () => {
    const model = textModel('hello');
    const app = buildServer(config, { tools: {}, model });
    const tenants = ['Acme & Sons', 'Other Tenant'];

    await Promise.all(
      tenants.map(async (name) => {
        const res = await app.request('/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            system_prompt_context: {
              tenant: { name },
              team: 'Request data must stay in its namespace',
              today: 'Request data must not override built-ins',
            },
          }),
        });

        expect(res.status).toBe(200);
        expect(parseSse(await res.text()).at(-1)).toMatchObject({
          event: 'final',
          data: { content: 'hello' },
        });
      }),
    );

    expect(model.doStreamCalls).toHaveLength(2);
    const systemMessages = model.doStreamCalls.flatMap((call) =>
      call.prompt.filter((message) => message.role === 'system'),
    );
    for (const name of tenants) {
      expect(systemMessages).toContainEqual({
        role: 'system',
        content: expect.stringMatching(
          new RegExp(
            `^You are the Platform assistant for ${name}\\. Today is \\d{4}-\\d{2}-\\d{2}\\.$`,
          ),
        ),
      });
    }
    expect(config.promptVars).toEqual({ team: 'Platform' });
  });

  it.each([
    undefined,
    {},
    { tenant: {} },
  ])('emits an error without calling the model when required context is missing: %j', async (systemPromptContext) => {
    const model = textModel('must not run');
    const app = buildServer(config, { tools: {}, model });
    const res = await app.request('/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        system_prompt_context: systemPromptContext,
      }),
    });

    expect(res.status).toBe(200);
    expect(parseSse(await res.text())).toEqual([
      {
        event: 'error',
        data: {
          code: 'invalid_prompt_context',
          message: expect.stringMatching(/Failed to render system prompt:.*"name" not defined/),
        },
      },
    ]);
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
