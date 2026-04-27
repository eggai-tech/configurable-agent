import type { ModelMessage, ToolSet } from 'ai';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAgent } from '../agent/loop.js';
import { requiredEnvVarFor } from '../agent/model.js';
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

  app.get('/ready', (c) => {
    const requiredEnv = requiredEnvVarFor(config.model.provider);
    if (requiredEnv && !process.env[requiredEnv]) {
      return c.json({ status: 'not_ready', reason: `${requiredEnv} is not set` }, 503);
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
          { tools },
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
