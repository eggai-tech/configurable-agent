import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { expect, vi } from 'vitest';
import {
  ACS_VERSION,
  deriveKey,
  HOOKS,
  type JsonObject,
  type RequestEnvelope,
  type ResponseEnvelope,
  signEnvelope,
  validPayload,
  validSchema,
} from '../../src/acs/protocol.js';
import { AgentConfigSchema } from '../../src/config/schema.js';

export const SECRET = 'test-only-shared-secret-not-for-production';
export const KEY_ID = 'test-key';
export type Handler = (request: RequestEnvelope) => JsonObject | Promise<JsonObject>;

export async function guardian(
  handler: Handler = () => ({}),
  fault?: 'signature' | 'id' | 'version' | 'rpc' | 'json' | 'disconnect',
) {
  const requests: RequestEnvelope[] = [];
  const errors: unknown[] = [];
  const heads = new Map<string, string>();
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestEnvelope;
      requests.push(request);
      expect(validSchema('request-envelope.json', request)).toBe(true);
      const key = deriveKey(SECRET, String(request.params.metadata.session_id));
      expect(request.params.signature).toEqual(signEnvelope(request, key, KEY_ID));
      const sessionId = String(request.params.metadata.session_id);
      if (request.method in HOOKS) {
        expect(validPayload(request.method as keyof typeof HOOKS, request.params.payload)).toBe(
          true,
        );
        const state = request.params.metadata.session_state as { chain_hash?: string } | undefined;
        // Closure may carry a stale last-verified head after a lost/invalid reply.
        if (!['steps/turnEnd', 'steps/sessionEnd'].includes(request.method)) {
          expect(state?.chain_hash).toBe(heads.get(sessionId));
        }
      }
      const overrides = await handler(request);
      if (fault === 'disconnect') {
        res.destroy();
        return;
      }
      if (fault === 'json') {
        res.end('invalid json');
        return;
      }
      const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const result: JsonObject =
        request.method === 'handshake/hello'
          ? {
              negotiated_version: ACS_VERSION,
              selected_transport: 'http',
              methods_evaluated: Object.keys(HOOKS),
              signature_algorithms_supported: ['HMAC-SHA256'],
              on_decision_failure: 'deny',
              timeout_config: { default_ms: 2000 },
              ...overrides,
            }
          : {
              type: 'final',
              acs_version: ACS_VERSION,
              request_id: request.params.request_id,
              decision: 'allow',
              chain_hash: hash,
              ...overrides,
            };
      if (request.method !== 'handshake/hello') heads.set(sessionId, hash);
      const response: ResponseEnvelope = { jsonrpc: '2.0', id: request.id, result };
      if (fault === 'id') response.id = 'wrong-id';
      if (fault === 'version') result.negotiated_version = '9.0.0';
      result.signature = signEnvelope(response, key, KEY_ID);
      if (fault === 'signature')
        (result.signature as { value: string }).value = `${'A'.repeat(43)}=`;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          fault === 'rpc'
            ? {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32000, message: 'private diagnostic' },
              }
            : response,
        ),
      );
    } catch (error) {
      errors.push(error);
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no listener');
  return {
    url: `http://127.0.0.1:${addr.port}/acs`,
    requests,
    errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(errors).toEqual([]);
    },
  };
}

export function config(url: string) {
  return AgentConfigSchema.parse({
    systemPrompt: 'SYSTEM {{request.weather}}',
    model: { provider: 'openai', name: 'test' },
    acs: {
      guardianUrl: url,
      agentId: 'test-agent',
      keyId: KEY_ID,
      secretEnv: 'ACS_TEST_SECRET',
      timeoutMs: 2000,
    },
  });
}
export const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
export function textStream(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}
export function toolStream(
  name = 'lookup',
  input = { query: 'private query' },
): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: `call-${name}`, toolName: name, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
  ];
}
export function model(streams: LanguageModelV3StreamPart[][], summary = 'SUMMARY') {
  const calls: LanguageModelV3CallOptions[] = [];
  let index = 0;
  const generate = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: summary }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  }));
  return {
    calls,
    generate,
    model: new MockLanguageModelV3({
      doStream: async (args) => {
        calls.push(args);
        const parts = streams[index++];
        if (!parts) throw new Error('no next stream');
        return { stream: convertArrayToReadableStream(parts) };
      },
      doGenerate: generate,
    }),
  };
}
export function verdict(
  decision: 'deny' | 'ask' | 'defer' | 'modify',
  modifications?: unknown,
): JsonObject {
  return {
    decision,
    reasoning: 'private policy explanation',
    ...(decision === 'modify' ? { modifications } : {}),
    ...(decision === 'ask'
      ? {
          ask_details: {
            approver: { type: 'human', id: 'reviewer' },
            question: 'approve?',
            timeout_seconds: 30,
          },
        }
      : {}),
    ...(decision === 'defer'
      ? {
          defer_details: {
            reason: 'pending_dependency',
            resolution_method: 'timeout',
            resolution_timeout_ms: 10000,
          },
        }
      : {}),
  };
}
