import Handlebars from 'handlebars';
import type { AgentConfig } from '../config/schema.js';

/**
 * Render the configured system prompt with the built-in template variables
 * (`now`, `today`, `cwd`) plus any user-supplied `promptVars`. Templates are
 * compiled per call: they are small and this keeps the function stateless.
 */
export function renderSystemPrompt(config: AgentConfig): string {
  const template = Handlebars.compile(config.systemPrompt, { noEscape: true });
  const now = new Date();
  const builtins = {
    now: now.toISOString(),
    today: now.toISOString().slice(0, 10),
    cwd: process.cwd(),
  };
  return template({ ...builtins, ...(config.promptVars ?? {}) });
}
