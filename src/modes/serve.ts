import { serve } from '@hono/node-server';
import { buildMcpRegistry } from '../agent/tools/mcp.js';
import { buildServer } from '../api/server.js';
import { loadConfig } from '../config/load.js';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { shutdownTracing, startTracing } from '../observability/tracing.js';

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
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await registry.cleanup();
    await shutdownTracing();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
