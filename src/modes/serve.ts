import { serve } from '@hono/node-server';
import { buildServer } from '../api/server.js';
import { loadConfig } from '../config/load.js';
import { logger } from '../observability/logger.js';
import { shutdownTracing, startTracing } from '../observability/tracing.js';

export function runServe(): void {
  startTracing();

  const configPath = process.env.CONFIG_PATH ?? '/etc/configurable-agent/config.yaml';
  const port = Number(process.env.PORT ?? 3000);

  const config = loadConfig(configPath);
  logger.info(
    { configPath, provider: config.model.provider, model: config.model.name },
    'config loaded',
  );

  const app = buildServer(config);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'configurable-agent listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await shutdownTracing();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
