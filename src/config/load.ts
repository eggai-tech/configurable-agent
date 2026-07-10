import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import ajvFormatsPkg from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

// ajv-formats is CJS with `export default`; NodeNext resolution types the default import
// as the module namespace. Grab the real callable plugin from `.default` when present.
const addFormats = (
  typeof ajvFormatsPkg === 'function'
    ? ajvFormatsPkg
    : (ajvFormatsPkg as unknown as { default: (ajv: Ajv) => Ajv }).default
) as (ajv: Ajv) => Ajv;

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
    throw new ConfigError('config failed validation', result.error.format());
  }

  if (result.data.output.structured) {
    validateJsonSchema(result.data.output.schema);
  }

  return result.data;
}

const ENV_VAR_PATTERN = /\$\{(\w+)\}/g;

/**
 * Recursively expand `${VAR}` references in every string of a parsed config
 * against the given environment. Lets secrets (e.g. API tokens) stay out of the
 * YAML file. Throws a ConfigError listing every referenced var that is unset.
 */
export function expandEnvVars(value: unknown, env: NodeJS.ProcessEnv): unknown {
  const missing = new Set<string>();

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(ENV_VAR_PATTERN, (_match, name: string) => {
        const replacement = env[name];
        if (replacement === undefined) {
          missing.add(name);
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

  const expanded = walk(value);
  if (missing.size > 0) {
    throw new ConfigError(
      `config references unset environment variable(s): ${[...missing].join(', ')}`,
    );
  }
  return expanded;
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
