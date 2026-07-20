import { randomUUID } from 'node:crypto';
import { context, trace } from '@opentelemetry/api';
import type { LanguageModel, ToolSet } from 'ai';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AgentEvent } from '../agent/events.js';
import { runAgent } from '../agent/loop.js';
import { type ProbeResult, probeModel, requiredEnvVarFor } from '../agent/model.js';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { parseTraceparent } from '../observability/tracing.js';
import { positiveIntFromEnv } from '../util.js';
import { parseInvokeRequest } from './request.js';
import { writeAgentEvent } from './sse.js';

export interface BuildServerOptions {
  /**
   * MCP tool map prebuilt at startup. Reused across all requests so MCP
   * discovery does not run per /invoke.
   */
  tools: ToolSet;
  /** Model override, used by tests to run the endpoints against a mock model. */
  model?: LanguageModel;
}

export function buildServer(config: AgentConfig, options: BuildServerOptions) {
  const app = new Hono();
  const { tools, model } = options;
  const tracer = trace.getTracer('configurable-agent');

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Cheap presence check by default; opt into an active provider probe with
  // `?deep=1` (or READINESS_DEEP_PROBE=1) to also catch bad credentials, an
  // unreachable baseUrl, or an unknown model. The probe hits the provider, so
  // it is off by default to keep k8s readiness polling free. Probe results are
  // cached briefly with single-flight dedup so the endpoint cannot be abused
  // to hammer the provider (it is unauthenticated).
  const deepProbeDefault = process.env.READINESS_DEEP_PROBE === '1';
  const probeTimeoutMs = positiveIntFromEnv('READINESS_PROBE_TIMEOUT_MS', 5000);
  const probeCacheMs = positiveIntFromEnv('READINESS_PROBE_CACHE_MS', 10_000);
  let probeInFlight: Promise<ProbeResult> | null = null;
  let probeCache: { result: ProbeResult; at: number } | null = null;

  const cachedProbe = (): Promise<ProbeResult> => {
    if (probeCache && Date.now() - probeCache.at < probeCacheMs) {
      return Promise.resolve(probeCache.result);
    }
    probeInFlight ??= probeModel(config.model, AbortSignal.timeout(probeTimeoutMs))
      .then((result) => {
        probeCache = { result, at: Date.now() };
        return result;
      })
      .finally(() => {
        probeInFlight = null;
      });
    return probeInFlight;
  };

  app.get('/ready', async (c) => {
    const requiredEnv = requiredEnvVarFor(config.model.provider);
    if (requiredEnv && !process.env[requiredEnv]) {
      return c.json({ status: 'not_ready', reason: `${requiredEnv} is not set` }, 503);
    }

    const deep = c.req.query('deep') === '1' || deepProbeDefault;
    if (deep) {
      const probe = await cachedProbe();
      if (!probe.ok) {
        // The provider error text can carry endpoint/key details — log it,
        // never return it to the (unauthenticated) caller.
        logger.warn({ error: probe.error }, 'readiness deep probe failed');
        return c.json({ status: 'not_ready', reason: 'provider probe failed' }, 503);
      }
      return c.json({ status: 'ok', probe: 'passed' });
    }

    return c.json({ status: 'ok' });
  });

  const maxBodyBytes = positiveIntFromEnv('MAX_REQUEST_BODY_BYTES', 10 * 1024 * 1024);
  const invokeBodyLimit = bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: 'payload_too_large', maxBytes: maxBodyBytes }, 413),
  });

  app.post('/invoke', invokeBodyLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const parsed = parseInvokeRequest(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_request',
          message: z.prettifyError(parsed.error),
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const incoming = parsed.messages;
    const requestId = randomUUID();
    const startedAt = Date.now();

    // One span per request: incoming `traceparent` becomes the parent, the AI
    // SDK model spans nest inside, and the logger mixin stamps every request
    // log with the shared trace_id.
    const parentSpanCtx = parseTraceparent(c.req.header('traceparent'));
    const baseCtx = parentSpanCtx
      ? trace.setSpanContext(context.active(), parentSpanCtx)
      : context.active();
    const span = tracer.startSpan('configurable-agent.invoke', undefined, baseCtx);
    span.setAttribute('request.id', requestId);
    const spanCtx = trace.setSpan(baseCtx, span);

    context.with(spanCtx, () =>
      logger.info({ requestId, messages: incoming.length }, 'invoke started'),
    );
    c.header('x-request-id', requestId);

    return streamSSE(c, (stream) =>
      context.with(spanCtx, async () => {
        const abortController = new AbortController();
        const clientSignal = c.req.raw.signal;
        if (clientSignal?.aborted) {
          abortController.abort();
        } else {
          clientSignal?.addEventListener('abort', () => abortController.abort(), { once: true });
        }
        stream.onAbort(() => abortController.abort());

        // Emit wrapper: log agent-level errors server-side (they are otherwise
        // only visible to the SSE client) and swallow write failures — once the
        // client disconnects there is nothing left to send, and that is not an
        // agent failure.
        const emit = async (event: AgentEvent): Promise<void> => {
          if (event.type === 'error') {
            logger.error({ requestId, code: event.code, message: event.message }, 'agent error');
          }
          try {
            await writeAgentEvent(stream, event);
          } catch (err) {
            logger.debug({ requestId, err }, 'failed to write SSE event (client disconnected?)');
          }
        };

        try {
          await runAgent(config, incoming, emit, abortController.signal, { tools, model });
          logger.info({ requestId, durationMs: Date.now() - startedAt }, 'invoke finished');
        } catch (err) {
          logger.error({ requestId, err, durationMs: Date.now() - startedAt }, 'agent run failed');
          // Deliberately generic: internal failure details stay in server logs.
          try {
            await writeAgentEvent(stream, {
              type: 'error',
              code: 'internal_error',
              message: 'internal error — see server logs',
              details: { requestId },
            });
          } catch {
            // client already gone
          }
        } finally {
          span.end();
        }
      }),
    );
  });

  return app;
}
