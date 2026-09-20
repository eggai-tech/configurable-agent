import { randomUUID } from 'node:crypto';
import type { AcsConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import {
  ACS_VERSION,
  AcsError,
  applyModifications,
  type Decision,
  deriveKey,
  HOOKS,
  type Hook,
  isObject,
  type JsonObject,
  type RequestEnvelope,
  type ResponseEnvelope,
  signEnvelope,
  validPayload,
  validSchema,
  verifyEnvelope,
} from './protocol.js';

export interface AcsDecisionRecord {
  sessionId: string;
  requestId: string;
  method: Hook;
  decision: Decision;
  effectiveDecision: 'allow' | 'modify' | 'deny';
  chainHash: string;
}
export interface CheckedPayload {
  payload: JsonObject | null;
  requestId: string;
}
const MAX_WIRE_BYTES = 10 * 1024 * 1024;

/** One invocation owns this object; tool registry instances never hold session state. */
export class AcsSession {
  readonly sessionId: string;
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  failure?: AcsError;
  chainHash?: string;
  private readonly key: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private timeoutDefault: number;
  private timeoutMethods: Record<string, number> = {};
  private started = false;
  private turnId?: string;
  private turnDenied = false;
  private count = 0;
  private closed = false;
  readonly contentEntries: string[] = [];

  constructor(
    private readonly config: AcsConfig,
    signal?: AbortSignal,
    sessionId?: string,
    private readonly record?: (decision: AcsDecisionRecord) => void | Promise<void>,
  ) {
    this.sessionId = sessionId ?? randomUUID();
    const secret = process.env[config.secretEnv];
    if (
      !secret ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.sessionId)
    )
      throw new AcsError('acs_configuration_error');
    this.key = deriveKey(secret, this.sessionId);
    this.timeoutDefault = config.timeoutMs;
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
  }

  assertActive(): void {
    if (this.failure) throw this.failure;
    this.signal.throwIfAborted();
    if (this.closed) throw new AcsError('acs_protocol_error');
  }

  async start(): Promise<void> {
    const hello = await this.serial(() =>
      this.exchange('handshake/hello', {
        acs_versions_supported: [ACS_VERSION],
        methods_implemented: Object.keys(HOOKS),
        transports_supported: [new URL(this.config.guardianUrl).protocol.slice(0, -1)],
        provenance_producer: 'none',
        profiles_supported: [],
        max_payload_size_bytes: MAX_WIRE_BYTES,
      }),
    );
    if (
      hello.negotiated_version !== ACS_VERSION ||
      hello.on_decision_failure !== 'deny' ||
      hello.selected_transport !== new URL(this.config.guardianUrl).protocol.slice(0, -1) ||
      hello.policy_requires_provenance === true ||
      !Array.isArray(hello.signature_algorithms_supported) ||
      !hello.signature_algorithms_supported.includes('HMAC-SHA256') ||
      !Array.isArray(hello.methods_evaluated) ||
      Object.keys(HOOKS).some(
        (method) => !(hello.methods_evaluated as unknown[]).includes(method),
      ) ||
      (Array.isArray(hello.profiles_accepted) && hello.profiles_accepted.length > 0)
    ) {
      throw this.fail(new AcsError('acs_protocol_error'));
    }
    const timeouts = hello.timeout_config as {
      default_ms: number;
      per_method_ms?: Record<string, number>;
    };
    this.timeoutDefault = Math.min(this.config.timeoutMs, timeouts.default_ms);
    this.timeoutMethods = timeouts.per_method_ms ?? {};
    this.started = true;
    await this.require('steps/sessionStart', {});
  }

  async beginTurn(): Promise<void> {
    this.turnId = randomUUID();
    this.count = 0;
    try {
      await this.require('steps/turnStart', { turn_id: this.turnId, triggered_by: 'user_message' });
    } catch (error) {
      this.turnDenied = error instanceof AcsError && error.code === 'acs_denied';
      throw error;
    } finally {
      // turnEnd counts observations strictly between turnStart and turnEnd.
      this.count = 0;
    }
  }

  async check(
    method: Hook,
    payload: JsonObject,
    validate: (payload: JsonObject) => boolean | Promise<boolean> = () => true,
  ): Promise<CheckedPayload> {
    return this.serial(async () => {
      this.assertActive();
      const requestId = randomUUID();
      if (!validPayload(method, payload)) throw this.fail(new AcsError('acs_protocol_error'));
      const result = await this.exchange(method, payload, requestId);
      const decision = result.decision as Decision;
      let effective: AcsDecisionRecord['effectiveDecision'] =
        decision === 'ask' || decision === 'defer' ? 'deny' : decision;
      let approved = payload;
      if (decision === 'modify') {
        try {
          if (
            [
              'steps/sessionStart',
              'steps/turnStart',
              'steps/preCompact',
              'steps/turnEnd',
              'steps/sessionEnd',
            ].includes(method)
          ) {
            throw new AcsError('acs_denied');
          }
          approved = applyModifications(payload, result.modifications, method);
          if (!validPayload(method, approved) || !(await validate(approved)))
            throw new AcsError('acs_denied');
        } catch {
          effective = 'deny';
        }
      } else if (effective === 'allow' && !(await validate(approved))) {
        effective = 'deny';
      }
      this.chainHash = result.chain_hash as string;
      this.count++;
      if (
        [
          'steps/agentTrigger',
          'steps/toolCallRequest',
          'steps/toolCallResult',
          'steps/postCompact',
        ].includes(method)
      ) {
        this.contentEntries.push(requestId);
      }
      const record: AcsDecisionRecord = {
        sessionId: this.sessionId,
        requestId,
        method,
        decision,
        effectiveDecision: effective,
        chainHash: this.chainHash,
      };
      logger.info(record, 'ACS decision');
      await this.record?.(record);
      this.assertActive();
      return { payload: effective === 'deny' ? null : approved, requestId };
    });
  }

  async require(
    method: Hook,
    payload: JsonObject,
    validate?: (payload: JsonObject) => boolean | Promise<boolean>,
  ): Promise<JsonObject> {
    const checked = await this.check(method, payload, validate);
    if (!checked.payload) throw new AcsError('acs_denied');
    return checked.payload;
  }

  /** Best-effort audit closure uses its own short deadline even after cancellation. */
  async close(reason: 'completed' | 'cancelled' | 'error'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) return;
    await this.serial(async () => {
      if (this.turnId) {
        try {
          const result = await this.exchange(
            'steps/turnEnd',
            {
              turn_id: this.turnId,
              outcome: this.turnDenied
                ? 'denied_at_start'
                : reason === 'cancelled'
                  ? 'interrupted'
                  : reason,
              step_count: this.count,
            },
            randomUUID(),
            true,
          );
          this.chainHash = result.chain_hash as string;
        } catch {
          logger.warn({ sessionId: this.sessionId }, 'ACS turn closure failed');
        }
      }
      this.turnId = undefined;
      try {
        await this.exchange(
          'steps/sessionEnd',
          {
            reason,
            ...(this.chainHash ? { final_chain_hash: this.chainHash } : {}),
          },
          randomUUID(),
          true,
        );
      } catch {
        logger.warn({ sessionId: this.sessionId }, 'ACS session closure failed');
      }
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private fail(error: AcsError): AcsError {
    this.failure ??= error;
    this.controller.abort(this.failure);
    return this.failure;
  }

  private async exchange(
    method: string,
    payload: JsonObject,
    requestId: string = randomUUID(),
    closing = false,
  ): Promise<JsonObject> {
    if (!closing) this.assertActive();
    const timeout = Math.min(
      this.config.timeoutMs,
      this.timeoutMethods[method] ?? this.timeoutDefault,
      closing ? 1000 : Number.POSITIVE_INFINITY,
    );
    const signal = closing
      ? AbortSignal.timeout(timeout)
      : AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]);
    const request: RequestEnvelope = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: {
        acs_version: ACS_VERSION,
        request_id: requestId,
        timestamp: new Date().toISOString(),
        metadata: {
          agent_id: this.config.agentId,
          session_id: this.sessionId,
          ...(this.turnId ? { turn_id: this.turnId } : {}),
          ...(this.chainHash ? { session_state: { chain_hash: this.chainHash } } : {}),
        },
        payload,
      },
    };
    try {
      request.params.signature = signEnvelope(request, this.key, this.config.keyId);
      if (!validSchema('request-envelope.json', request)) throw new AcsError('acs_protocol_error');
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > MAX_WIRE_BYTES) throw new AcsError('acs_protocol_error');
      const response = await fetch(this.config.guardianUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
        redirect: 'error',
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AcsError('acs_unavailable');
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_WIRE_BYTES) throw new AcsError('acs_protocol_error');
        chunks.push(chunk);
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new AcsError('acs_protocol_error');
      }
      if (
        !validSchema('response-envelope.json', envelope) ||
        !isObject(envelope) ||
        envelope.id !== requestId ||
        !isObject(envelope.result) ||
        !verifyEnvelope(envelope as unknown as ResponseEnvelope, this.key, this.config.keyId)
      ) {
        throw new AcsError('acs_protocol_error');
      }
      const result = envelope.result;
      if (method === 'handshake/hello') {
        if (!validSchema('handshake.json#/$defs/ServerHello', result))
          throw new AcsError('acs_protocol_error');
      } else if (
        result.request_id !== requestId ||
        result.acs_version !== ACS_VERSION ||
        result.type !== 'final' ||
        typeof result.chain_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.chain_hash)
      ) {
        throw new AcsError('acs_protocol_error');
      }
      if (closing && result.decision !== 'allow') throw new AcsError('acs_protocol_error');
      return result;
    } catch (error) {
      if (closing) throw error;
      if (this.signal.aborted && !this.failure) throw error;
      throw this.fail(error instanceof AcsError ? error : new AcsError('acs_unavailable'));
    }
  }
}
