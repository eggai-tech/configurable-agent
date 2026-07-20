import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { buildMcpRegistry } from '../agent/tools/mcp.js';
import { buildServer } from '../api/server.js';
import { loadConfig } from '../config/load.js';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { shutdownTracing, startTracing } from '../observability/tracing.js';
import { positiveIntFromEnv } from '../util.js';

export async function runServe(): Promise<void> {
  startTracing();

  const configPath = process.env.CONFIG_PATH ?? '/etc/configurable-agent/config.yaml';
  const port = Number(process.env.PORT ?? 3000);

  let config: AgentConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    logger.error({ err, configPath }, 'config load failed');
    await shutdownTracing();
    process.exit(1);
  }
  logger.info(
    { configPath, provider: config.model.provider, model: config.model.name },
    'config loaded',
  );

  // The /invoke history is client-controlled. Without a signing secret, a
  // client can fabricate an "approved" response and bypass the human gate
  // entirely — refuse to serve an approval config that cannot be enforced.
  if (config.safety.approval.mode !== 'none' && !process.env.TOOL_APPROVAL_SECRET) {
    logger.error(
      { approvalMode: config.safety.approval.mode },
      'safety.approval is enabled but TOOL_APPROVAL_SECRET is not set — approvals would be forgeable. Set the secret or set safety.approval.mode: none',
    );
    await shutdownTracing();
    process.exit(1);
  }

  // Build the MCP registry BEFORE we start serving traffic. If discovery fails
  // or two servers expose the same tool name, the process exits non-zero — we
  // never accept a request against a half-initialized tool layer.
  let registry: Awaited<ReturnType<typeof buildMcpRegistry>>;
  try {
    registry = await buildMcpRegistry(config);
    logger.info(
      { tools: Object.keys(registry.tools).length, servers: config.mcpTools.length },
      'mcp registry ready',
    );
  } catch (err) {
    logger.error({ err }, 'mcp registry initialization failed');
    await shutdownTracing();
    process.exit(1);
  }

  const app = buildServer(config, { tools: registry.tools });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'configurable-agent listening');
  }) as Server;

  // Graceful shutdown: stop accepting connections and let in-flight requests
  // (including SSE streams) drain; force-close whatever is still open after
  // SHUTDOWN_TIMEOUT_MS so a long-running stream cannot block termination.
  const shutdownTimeoutMs = positiveIntFromEnv('SHUTDOWN_TIMEOUT_MS', 10_000);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceClose = setTimeout(() => {
      logger.warn({ shutdownTimeoutMs }, 'shutdown timeout reached; closing open connections');
      server.closeAllConnections();
    }, shutdownTimeoutMs);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(forceClose);

    // MCP children and the OTEL exporter get the same deadline: a child that
    // ignores its transport closing must not stall process exit forever.
    await Promise.race([
      Promise.allSettled([registry.cleanup(), shutdownTracing()]),
      new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
    ]);
    process.exit(0);
  };

  const onSignal = (signal: string) => {
    shutdown(signal).catch((err) => {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    });
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}
