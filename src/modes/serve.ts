import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { buildMcpRegistry } from '../agent/tools/mcp.js';
import { buildServer } from '../api/server.js';
import { loadConfig } from '../config/load.js';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { shutdownTracing, startTracing } from '../observability/tracing.js';
import { intFromEnv } from '../util.js';

const DEFAULT_CONFIG_PATH = '/etc/configurable-agent/config.yaml';

export async function runServe(): Promise<void> {
  startTracing();

  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const port = intFromEnv('PORT', 3000);

  const config = await loadOrExit(configPath);
  logger.info(
    { configPath, provider: config.model.provider, model: config.model.name },
    'config loaded',
  );

  if (config.safety.approval.mode !== 'none' && !process.env.TOOL_APPROVAL_SECRET) {
    logger.warn(
      { approvalMode: config.safety.approval.mode },
      'TOOL_APPROVAL_SECRET is not set; tool approvals will not be signed',
    );
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
  const shutdownTimeoutMs = intFromEnv('SHUTDOWN_TIMEOUT_MS', 10_000);
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

    // Best-effort teardown of MCP children and the OTEL exporter; neither
    // should hold up process exit.
    void Promise.allSettled([registry.cleanup(), shutdownTracing()]);
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

async function loadOrExit(configPath: string): Promise<AgentConfig> {
  try {
    return loadConfig(configPath);
  } catch (err) {
    logger.error({ err, configPath }, 'config load failed');
    await shutdownTracing();
    process.exit(1);
  }
}
