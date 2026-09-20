import Handlebars from 'handlebars';
import type { AgentConfig } from '../config/schema.js';

// One compiled template per template string: the config is static for the
// process lifetime, so recompiling on every request is pure waste.
const compiled = new Map<string, HandlebarsTemplateDelegate>();

export function renderSystemPrompt(
  config: AgentConfig,
  systemPromptContext: Record<string, unknown> = {},
): string {
  let template = compiled.get(config.systemPrompt);
  if (!template) {
    template = Handlebars.compile(config.systemPrompt, { noEscape: true, strict: true });
    compiled.set(config.systemPrompt, template);
  }
  const now = new Date();
  const builtins = {
    now: now.toISOString(),
    today: now.toISOString().slice(0, 10),
    cwd: process.cwd(),
  };
  return template({
    ...builtins,
    ...(config.promptVars ?? {}),
    system_prompt_context: systemPromptContext,
  });
}
