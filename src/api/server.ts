import type { ModelMessage } from 'ai';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAgent } from '../agent/loop.js';
import { requiredEnvVarFor } from '../agent/model.js';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { InvokeRequestSchema } from './request.js';
import { writeAgentEvent } from './sse.js';

export function buildServer(config: AgentConfig) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/ready', (c) => {
    const requiredEnv = requiredEnvVarFor(config.model.provider);
    if (requiredEnv && !process.env[requiredEnv]) {
      return c.json({ status: 'not_ready', reason: `${requiredEnv} is not set` }, 503);
    }
    if (config.tools.websearch.enabled && !process.env.TAVILY_API_KEY) {
      return c.json({ status: 'not_ready', reason: 'TAVILY_API_KEY is not set' }, 503);
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
    const approvals = parsed.data.approvals;
    const sessionAllowRules = parsed.data.sessionAllowRules;

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

      try {
        await runAgent(
          config,
          incoming,
          async (event) => {
            await writeAgentEvent(stream, event);
          },
          abortController.signal,
          { approvals, sessionAllowRules },
        );
      } catch (err) {
        logger.error({ err }, 'agent run failed');
        await writeAgentEvent(stream, {
          type: 'error',
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  return app;
}
