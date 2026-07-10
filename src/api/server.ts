import { randomUUID } from 'node:crypto';
import type { ModelMessage, ToolSet } from 'ai';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentEvent } from '../agent/events.js';
import { runAgent } from '../agent/loop.js';
import { probeModel, requiredEnvVarFor } from '../agent/model.js';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { InvokeRequestSchema } from './request.js';
import { writeAgentEvent } from './sse.js';

export interface BuildServerOptions {
  /**
   * MCP tool map prebuilt at startup. Reused across all requests so MCP
   * discovery does not run per /invoke.
   */
  tools: ToolSet;
}

export function buildServer(config: AgentConfig, options: BuildServerOptions) {
  const app = new Hono();
  const { tools } = options;

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Cheap presence check by default; opt into an active provider probe with
  // `?deep=1` (or READINESS_DEEP_PROBE=1) to also catch bad credentials, an
  // unreachable baseUrl, or an unknown model. The probe hits the provider, so
  // it is off by default to keep k8s readiness polling free.
  const deepProbeDefault = process.env.READINESS_DEEP_PROBE === '1';
  const probeTimeoutMs = Number(process.env.READINESS_PROBE_TIMEOUT_MS ?? 5000);

  app.get('/ready', async (c) => {
    const requiredEnv = requiredEnvVarFor(config.model.provider);
    if (requiredEnv && !process.env[requiredEnv]) {
      return c.json({ status: 'not_ready', reason: `${requiredEnv} is not set` }, 503);
    }

    const deep = c.req.query('deep') === '1' || deepProbeDefault;
    if (deep) {
      const probe = await probeModel(config.model, AbortSignal.timeout(probeTimeoutMs));
      if (!probe.ok) {
        logger.warn({ error: probe.error }, 'readiness deep probe failed');
        return c.json(
          { status: 'not_ready', reason: 'provider probe failed', error: probe.error },
          503,
        );
      }
      return c.json({ status: 'ok', probe: 'passed' });
    }

    return c.json({ status: 'ok' });
  });

  app.post('/invoke', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const parsed = InvokeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.format() }, 400);
    }

    const incoming = parsed.data.messages as ModelMessage[];
    const requestId = randomUUID();
    const startedAt = Date.now();
    logger.info({ requestId, messages: incoming.length }, 'invoke started');

    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();
      const clientSignal = c.req.raw.signal;
      if (clientSignal) {
        clientSignal.addEventListener(
          'abort',
          () => {
            abortController.abort();
          },
          { once: true },
        );
      }
      stream.onAbort(() => {
        abortController.abort();
      });

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
        await runAgent(config, incoming, emit, abortController.signal, { tools });
        logger.info({ requestId, durationMs: Date.now() - startedAt }, 'invoke finished');
      } catch (err) {
        logger.error({ requestId, err, durationMs: Date.now() - startedAt }, 'agent run failed');
        await emit({
          type: 'error',
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  return app;
}
