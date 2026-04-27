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

  const result = AgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError('config failed validation', result.error.format());
  }

  if (result.data.output.structured) {
    validateJsonSchema(result.data.output.schema);
  }

  return result.data;
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
