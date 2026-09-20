import { randomUUID } from 'node:crypto';
import { asSchema, type FlexibleSchema, type ModelMessage, type Tool, type ToolSet } from 'ai';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormatsPkg from 'ajv-formats';
import canonicalize from 'canonicalize';
import { type AgentEmitter, type ToolResult, toolResultToModelOutput } from '../agent/events.js';
import { maybeSummarizeToolOutput } from '../agent/safety/tool-summary.js';
import { mcpResultToEnvelope } from '../agent/tools/mcp.js';
import { InvokeRequestSchema } from '../api/request.js';
import type { AgentConfig } from '../config/schema.js';
import { errorMessage, safeJson } from '../util.js';
import type { AcsSession } from './client.js';
import { AcsError, isObject, type JsonObject } from './protocol.js';

const ajv = new Ajv({ strict: false });
const addFormats = (
  typeof ajvFormatsPkg === 'function'
    ? ajvFormatsPkg
    : (ajvFormatsPkg as unknown as { default: (a: Ajv) => void }).default
) as (a: Ajv) => void;
addFormats(ajv);
const ajv2020 = new Ajv2020({ strict: false });
addFormats(ajv2020);

export async function validateInput(schema: FlexibleSchema, value: unknown): Promise<boolean> {
  const resolved = asSchema(schema);
  const json = await resolved.jsonSchema;
  const validator = String(json.$schema).includes('2020-12') ? ajv2020 : ajv;
  if (!validator.compile(json)(value)) return false;
  if (resolved.validate) {
    const checked = await resolved.validate(value);
    // Schema coercions/defaults would change the Guardian-approved arguments.
    return checked.success && canonicalize(checked.value) === canonicalize(value);
  }
  return true;
}

export class AcsRuntime {
  private readonly summaryProvenance: string[] = [];
  private readonly toolNames = new Set<string>();
  private readonly calls = new Map<string, { input: unknown; output: ToolResult }>();
  constructor(
    readonly session: AcsSession,
    private readonly config: AgentConfig,
    private readonly emit: AgentEmitter,
    private readonly summarize: (prompt: string) => Promise<string>,
  ) {}

  async input(
    messages: ModelMessage[],
    context?: Record<string, unknown>,
  ): Promise<{ messages: ModelMessage[]; context?: Record<string, unknown> }> {
    const payload = await this.session.require(
      'steps/agentTrigger',
      {
        trigger_type: 'user_message',
        trigger_source: { messages, ...(context ? { context } : {}) },
      },
      (p) =>
        p.trigger_type === 'user_message' &&
        InvokeRequestSchema.safeParse(p.trigger_source).success,
    );
    const source = InvokeRequestSchema.parse(payload.trigger_source);
    // No approval resumption under ACS. The request is data, never an authority to execute tools.
    if (
      source.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some(
            (part) =>
              part.type === 'tool-approval-request' || part.type === 'tool-approval-response',
          ),
      )
    ) {
      throw new AcsError('acs_denied');
    }
    return source;
  }

  wrapTools(raw: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(raw).map(([name, original]) => {
        this.toolNames.add(name);
        const execute = original.execute;
        if (!execute || original.type === 'provider') throw new AcsError('acs_configuration_error');
        const wrapped: Tool = {
          ...original,
          // Streaming callbacks would run before the ACS gate. Only execute is supported.
          onInputStart: undefined,
          onInputDelta: undefined,
          onInputAvailable: undefined,
          needsApproval: undefined,
          execute: async (input, options) => {
            this.session.assertActive();
            const denied = (): ToolResult => ({
              label: name,
              status: 'denied',
              denied_reason: 'policy_deny',
              content:
                'The Guardian denied this tool operation. You may try another permitted approach.',
              args: undefined,
              return_code: null,
              duration_ms: 0,
            });
            const remember = async (output: ToolResult, effectiveInput: unknown = {}) => {
              this.calls.set(options.toolCallId, { input: effectiveInput, output });
              await this.emit({ type: 'tool_result', id: options.toolCallId, output });
              return output;
            };
            // Install the denial first, so partially failed executions never expose original arguments.
            this.calls.set(options.toolCallId, { input: {}, output: denied() });
            if (!isObject(input)) return remember(denied());
            const checked = await this.session.check(
              'steps/toolCallRequest',
              {
                tool: { name },
                arguments: Object.fromEntries(
                  Object.entries(input).map(([key, value]) => [key, { value }]),
                ),
              },
              async (p) =>
                unchangedExcept(p, { tool: { name }, arguments: {} }, ['arguments']) &&
                isObject(p.arguments) &&
                (await validateInput(original.inputSchema, unwrapArguments(p.arguments))),
            );
            if (!checked.payload) return remember(denied());
            const effectiveInput = unwrapArguments(checked.payload.arguments as JsonObject);
            this.session.assertActive();
            await this.emit({
              type: 'tool_call',
              id: options.toolCallId,
              name,
              args: effectiveInput,
            });
            this.session.assertActive();
            const started = Date.now();
            let result: unknown;
            let failed = false;
            try {
              result = await execute.call(original, effectiveInput, options);
              // Library-supplied tools can yield intermediate results. Consume privately.
              if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
                for await (const part of result as AsyncIterable<unknown>) {
                  this.session.assertActive();
                  result = part;
                }
              }
            } catch (error) {
              this.session.assertActive();
              failed = true;
              result = { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
            }
            this.session.assertActive();
            const duration = Date.now() - started;
            failed ||= isObject(result) && (result.isError === true || result.status === 'error');
            const resultPayload = {
              tool: { name },
              request_id_ref: checked.requestId,
              exit_status: failed ? 'failure' : 'success',
              outputs: [{ value: result ?? null }],
              duration_ms: duration,
            };
            const validResult = (p: JsonObject, summary = false) =>
              unchangedExcept(
                p,
                {
                  ...resultPayload,
                  ...(summary ? { operation: 'summarize' } : {}),
                },
                ['outputs'],
              ) &&
              Array.isArray(p.outputs) &&
              p.outputs.length === 1;
            const reviewed = await this.session.check(
              'steps/toolCallResult',
              resultPayload,
              validResult,
            );
            if (!reviewed.payload) return remember(denied(), effectiveInput);
            const rawResult = (reviewed.payload.outputs as [{ value: unknown }])[0].value;
            let envelope = isEnvelope(rawResult)
              ? { ...rawResult, label: name, args: effectiveInput, duration_ms: duration }
              : mcpResultToEnvelope(rawResult, name, effectiveInput, duration);
            const summarized = await maybeSummarizeToolOutput(envelope, name, {
              config: this.config,
              summarize: this.summarize,
            });
            this.session.assertActive();
            if (summarized !== envelope) {
              // A summarizer generates new content; it needs its own check before consumption/delivery.
              const summary = await this.session.check(
                'steps/toolCallResult',
                {
                  ...resultPayload,
                  operation: 'summarize',
                  outputs: [{ value: summarized.content }],
                },
                (p) =>
                  validResult(p, true) &&
                  typeof (p.outputs as [{ value: unknown }])[0].value === 'string',
              );
              if (!summary.payload) return remember(denied(), effectiveInput);
              envelope = {
                ...summarized,
                content: (summary.payload.outputs as [{ value: string }])[0].value,
              };
            }
            return remember(envelope, effectiveInput);
          },
          toModelOutput: toolResultToModelOutput,
        };
        return [name, wrapped];
      }),
    );
  }

  async toolError(id: string, name: string): Promise<void> {
    const output: ToolResult = {
      label: this.toolNames.has(name) ? name : 'tool',
      status: 'error',
      content: 'The tool call could not be executed.',
      args: undefined,
      return_code: null,
      duration_ms: 0,
    };
    this.calls.set(id, { input: {}, output });
    await this.emit({ type: 'tool_result', id, output });
  }

  /** SDK history retains the model's original tool arguments. Replace them with what ran. */
  history(messages: ModelMessage[]): ModelMessage[] {
    return messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      if (message.role === 'assistant')
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== 'tool-call') return part;
            const call = this.calls.get(part.toolCallId);
            return call ? { ...part, input: call.input } : part;
          }),
        };
      if (message.role === 'tool')
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== 'tool-result') return part;
            const call = this.calls.get(part.toolCallId);
            return call
              ? { ...part, output: toolResultToModelOutput({ output: call.output }) }
              : part;
          }),
        };
      return message;
    });
  }

  async response(
    content: string,
    structured: unknown,
  ): Promise<{ content: string; structured?: unknown }> {
    const isStructured = this.config.output.structured;
    const payload = await this.session.require(
      'steps/agentResponse',
      {
        content: [{ type: 'text', value: isStructured ? safeJson(structured) : content }],
      },
      (p) => {
        const parts = p.content as [{ type: string; value: unknown }];
        if (parts.length !== 1 || parts[0].type !== 'text' || typeof parts[0].value !== 'string')
          return false;
        if (!this.config.output.structured) return true;
        try {
          return ajv.compile(this.config.output.schema)(JSON.parse(parts[0].value)) as boolean;
        } catch {
          return false;
        }
      },
    );
    const text = (payload.content as [{ value: string }])[0].value;
    return isStructured ? { content: '', structured: JSON.parse(text) } : { content: text };
  }

  async beforeCompact(messages: ModelMessage[]): Promise<{ entries: string[]; chainHash: string }> {
    // Conservative dependency set: all content-bearing observations so far. Include the exact
    // region as an extension because one trigger can cover several history messages.
    const entries = [...this.session.contentEntries];
    await this.session.require('steps/preCompact', {
      entries_to_compact: entries,
      triggered_by: 'size_threshold',
      messages,
    });
    if (!this.session.chainHash) throw new AcsError('acs_protocol_error');
    return { entries, chainHash: this.session.chainHash };
  }

  async afterCompact(
    summary: string,
    state: { entries: string[]; chainHash: string },
  ): Promise<string> {
    const payload = {
      entries_compacted: state.entries,
      pre_compact_chain_hash: state.chainHash,
      summary: {
        value: summary,
        provenance: {
          provenance_id: randomUUID(),
          origin: 'agent_generated',
          derived_from: [...this.summaryProvenance],
        },
      },
    };
    const approved = await this.session.require(
      'steps/postCompact',
      payload,
      (p) =>
        safeJson(p.entries_compacted) === safeJson(payload.entries_compacted) &&
        p.pre_compact_chain_hash === payload.pre_compact_chain_hash &&
        isObject(p.summary) &&
        typeof p.summary.value === 'string' &&
        safeJson(p.summary.provenance) === safeJson(payload.summary.provenance),
    );
    this.summaryProvenance.push(payload.summary.provenance.provenance_id);
    return (approved.summary as { value: string }).value;
  }
}

function unwrapArguments(args: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(args).map(([key, wrapped]) => [key, (wrapped as { value: unknown }).value]),
  );
}
function isEnvelope(raw: unknown): raw is ToolResult {
  return (
    isObject(raw) &&
    ['succeeded', 'error', 'denied', 'approval_required'].includes(String(raw.status)) &&
    typeof raw.content === 'string' &&
    typeof raw.label === 'string' &&
    typeof raw.duration_ms === 'number'
  );
}

function unchangedExcept(candidate: JsonObject, original: JsonObject, editable: string[]): boolean {
  const omit = (value: JsonObject) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !editable.includes(key)));
  return canonicalize(omit(candidate)) === canonicalize(omit(original));
}
