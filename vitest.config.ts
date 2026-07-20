import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Silence pino during tests: the logger reads LOG_LEVEL at import time, and
    // Vitest applies `env` before test files load. Keeps expected warn/info
    // lines (summarizer fallbacks, MCP lifecycle) out of the test output.
    env: { LOG_LEVEL: 'silent' },
  },
});
