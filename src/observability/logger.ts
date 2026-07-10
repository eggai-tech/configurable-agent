import pino from 'pino';

// Log to stderr (fd 2), not stdout. The CLI `run` mode writes a single
// machine-readable JSON record to stdout, so all diagnostics must stay off it;
// stderr is the conventional home for logs and works the same in serve mode.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'configurable-agent' },
  },
  pino.destination(2),
);
