import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import ajvFormatsPkg from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ajv-formats is CJS with `export default`; NodeNext resolution types the default import
// as the module namespace. Grab the real callable plugin from `.default` when present.
const addFormats = (
  typeof ajvFormatsPkg === 'function'
    ? ajvFormatsPkg
    : (ajvFormatsPkg as unknown as { default: (ajv: Ajv) => Ajv }).default
) as (ajv: Ajv) => Ajv;

import { renderSystemPrompt } from '../agent/prompt.js';
import { logger } from '../observability/logger.js';
import { type AgentConfig, AgentConfigSchema } from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(path: string): AgentConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read config at ${path}`, err);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`config at ${path} is not valid YAML`, err);
  }

  parsed = expandEnvVars(parsed, process.env);

  const result = AgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `config failed validation:\n${z.prettifyError(result.error)}`,
      z.treeifyError(result.error),
    );
  }

  if (result.data.output.structured) {
    validateJsonSchema(result.data.output.schema);
  }

  // Render once at load: Handlebars parses lazily, so a template syntax error
  // would otherwise surface on the first request instead of at startup.
  try {
    renderSystemPrompt(result.data);
  } catch (err) {
    throw new ConfigError(
      `systemPrompt is not a valid Handlebars template: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  return result.data;
}

const ENV_VAR_PATTERN = /\$(\$?)\{(\w+)\}/g;

/**
 * Recursively expand `${VAR}` references in every string of a parsed config
 * against the given environment. Lets secrets (e.g. API tokens) stay out of the
 * YAML file. `$${VAR}` escapes expansion and yields a literal `${VAR}` — for
 * prompt text that must contain the sequence verbatim. Unset variables expand
 * to an empty string and are logged, so an optional variable does not block
 * startup.
 */
export function expandEnvVars(value: unknown, env: NodeJS.ProcessEnv): unknown {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(ENV_VAR_PATTERN, (_match, escaped: string, name: string) => {
        if (escaped) return `\${${name}}`;
        const replacement = env[name];
        if (replacement === undefined) {
          logger.warn({ name }, 'config references an unset environment variable');
          return '';
        }
        return replacement;
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };

  return walk(value);
}

function validateJsonSchema(schema: Record<string, unknown>): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  try {
    ajv.compile(schema);
  } catch (err) {
    throw new ConfigError('output.schema is not a valid JSON Schema', err);
  }
}
