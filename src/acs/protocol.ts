import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormatsPkg from 'ajv-formats';
import canonicalize from 'canonicalize';
import schemas from './vendor/schemas.json' with { type: 'json' };

export const ACS_VERSION = '0.1.0';
const SCHEMA_BASE =
  'https://genai-security-project.github.io/agent-control-standard/schema/v0.1.0/';
export const HOOKS = {
  'steps/sessionStart': 'session-start',
  'steps/agentTrigger': 'agent-trigger',
  'steps/turnStart': 'turn-start',
  'steps/toolCallRequest': 'tool-call-request',
  'steps/toolCallResult': 'tool-call-result',
  'steps/agentResponse': 'agent-response',
  'steps/preCompact': 'pre-compact',
  'steps/postCompact': 'post-compact',
  'steps/turnEnd': 'turn-end',
  'steps/sessionEnd': 'session-end',
} as const;
export type Hook = keyof typeof HOOKS;
export type Decision = 'allow' | 'deny' | 'modify' | 'ask' | 'defer';
export type JsonObject = Record<string, unknown>;
export interface Signature {
  algorithm: 'HMAC-SHA256';
  key_id: string;
  value: string;
}
export interface RequestEnvelope {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: {
    acs_version: string;
    request_id: string;
    timestamp: string;
    metadata: JsonObject;
    payload: JsonObject;
    signature?: Signature;
  };
}
export interface ResponseEnvelope {
  jsonrpc: '2.0';
  id: string;
  result: JsonObject;
}

export class AcsError extends Error {
  constructor(
    public readonly code:
      | 'acs_denied'
      | 'acs_unavailable'
      | 'acs_protocol_error'
      | 'acs_configuration_error',
  ) {
    super(
      {
        acs_denied: 'The Guardian denied this operation.',
        acs_unavailable: 'The Guardian could not provide a decision.',
        acs_protocol_error: 'The Guardian response could not be verified.',
        acs_configuration_error: 'The ACS configuration is not usable.',
      }[code],
    );
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const addFormats = (
  typeof ajvFormatsPkg === 'function'
    ? ajvFormatsPkg
    : (ajvFormatsPkg as unknown as { default: (a: Ajv2020) => void }).default
) as (a: Ajv2020) => void;
addFormats(ajv);
for (const original of schemas) {
  const schema = structuredClone(original) as JsonObject;
  if (schema.$id === `${SCHEMA_BASE}hooks/post-compact.json`) {
    // Only the Guardian can know its future audit-chain hash. See vendor/README.md.
    schema.required = (schema.required as string[]).filter(
      (key) => key !== 'post_compact_chain_hash',
    );
  }
  if (schema.$id === `${SCHEMA_BASE}response-envelope.json`) {
    // Validate modification instructions separately, so invalid edits deny the action.
    const defs = schema.$defs as Record<string, JsonObject>;
    const result = defs.AcsResult as JsonObject;
    (result.properties as JsonObject).modifications = {};
    for (const rule of result.allOf as { then: { required: string[] } }[]) {
      rule.then.required = rule.then.required.filter((key) => key !== 'modifications');
    }
  }
  ajv.addSchema(schema);
}
export function validSchema(name: string, value: unknown): boolean {
  return ajv.getSchema(`${SCHEMA_BASE}${name}`)?.(value) === true;
}
export function validPayload(method: Hook, value: unknown): boolean {
  return validSchema(`hooks/${HOOKS[method]}.json`, value);
}
export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deployment convention: HKDF-SHA256, UTF-8 session UUID salt, UTF-8 info, 32 bytes. */
export function deriveKey(secret: string, sessionId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(sessionId, 'utf8'),
      Buffer.from('acs/0.1.0/hmac', 'utf8'),
      32,
    ),
  );
}
export function signEnvelope(
  envelope: RequestEnvelope | ResponseEnvelope,
  key: Buffer,
  keyId: string,
): Signature {
  const copy =
    'params' in envelope
      ? { ...envelope, params: { ...envelope.params } }
      : { ...envelope, result: { ...envelope.result } };
  const body = 'params' in copy ? copy.params : copy.result;
  delete body.signature;
  const canonical = canonicalize(copy);
  if (canonical === undefined) throw new AcsError('acs_protocol_error');
  return {
    algorithm: 'HMAC-SHA256',
    key_id: keyId,
    value: createHmac('sha256', key).update(canonical, 'utf8').digest('base64'),
  };
}
export function verifyEnvelope(envelope: ResponseEnvelope, key: Buffer, keyId: string): boolean {
  const signature = envelope.result.signature;
  if (
    !isObject(signature) ||
    signature.algorithm !== 'HMAC-SHA256' ||
    signature.key_id !== keyId ||
    typeof signature.value !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature.value)
  )
    return false;
  const expected = Buffer.from(signEnvelope(envelope, key, keyId).value, 'base64');
  const actual = Buffer.from(signature.value, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Apply edits to a copy. Reject ambiguous targets and prototype traversal. */
export function applyModifications(
  payload: JsonObject,
  modifications: unknown,
  method: Hook,
): JsonObject {
  if (
    !isObject(modifications) ||
    !validSchema('modifications.json', modifications) ||
    Object.keys(modifications).some(
      (key) => !['modified_content', 'redactions', 'parameter_overrides'].includes(key),
    )
  ) {
    throw new AcsError('acs_denied');
  }
  if (typeof modifications.modified_content === 'string') {
    // A replacement is a serialized hook payload, not an implicitly coerced field.
    try {
      const replacement: unknown = JSON.parse(modifications.modified_content);
      if (!isObject(replacement)) throw new Error();
      return replacement;
    } catch {
      throw new AcsError('acs_denied');
    }
  }
  const edits: { path: string[]; value: unknown; create?: boolean }[] = [];
  for (const redaction of (modifications.redactions ?? []) as {
    path: string;
    replacement?: string;
  }[]) {
    if (!redaction.path.startsWith('/') || /~(?![01])/u.test(redaction.path))
      throw new AcsError('acs_denied');
    edits.push({
      path: redaction.path
        .slice(1)
        .split('/')
        .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')),
      value: redaction.replacement ?? '[REDACTED]',
    });
  }
  if (modifications.parameter_overrides !== undefined) {
    if (method !== 'steps/toolCallRequest') throw new AcsError('acs_denied');
    for (const [name, value] of Object.entries(modifications.parameter_overrides as JsonObject)) {
      // The wrapper exists even for newly added optional arguments.
      edits.push({ path: ['arguments', name], value: { value }, create: true });
    }
  }
  if (!edits.length) throw new AcsError('acs_denied');
  for (let i = 0; i < edits.length; i++) {
    const path = (edits[i] as (typeof edits)[number]).path;
    if (path.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)))
      throw new AcsError('acs_denied');
    for (const other of edits.slice(i + 1)) {
      if (
        path.slice(0, Math.min(path.length, other.path.length)).every((p, j) => p === other.path[j])
      ) {
        throw new AcsError('acs_denied');
      }
    }
  }
  const copy = structuredClone(payload);
  for (const { path, value, create } of edits) {
    let target: unknown = copy;
    for (const segment of path.slice(0, -1)) {
      if ((!isObject(target) && !Array.isArray(target)) || !Object.hasOwn(target, segment))
        throw new AcsError('acs_denied');
      target = (target as JsonObject)[segment];
    }
    const last = path.at(-1);
    if (last === undefined) throw new AcsError('acs_denied');
    if ((!isObject(target) && !Array.isArray(target)) || (!create && !Object.hasOwn(target, last)))
      throw new AcsError('acs_denied');
    (target as JsonObject)[last] = value;
  }
  return copy;
}
