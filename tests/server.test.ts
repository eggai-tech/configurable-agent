import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
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
