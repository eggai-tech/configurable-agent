import { APICallError } from '@ai-sdk/provider';
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  RetryError,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai';
import type { AgentConfig } from '../config/schema.js';
import { logger } from '../observability/logger.js';
import { telemetryOptions } from '../observability/tracing.js';
import { errorMessage, safeJson } from '../util.js';
import { toolNeedsApproval } from './approval.js';
import type { AgentEmitter, ToolResult } from './events.js';
import { buildModel } from './model.js';
import { renderSystemPrompt } from './prompt.js';
import { maybeCompactMessages } from './safety/compaction.js';
import { buildMcpRegistry, wrapToolsWithSummarization } from './tools/mcp.js';
import { createTodoStore, createTodoWriteTool } from './tools/todowrite.js';

export type { AgentEmitter, AgentEvent } from './events.js';

export interface RunAgentOptions {
  model?: LanguageModel;
  /**
   * Pre-built, validated MCP tool map. When provided, the loop reuses it
   * instead of running discovery for the request — used by the HTTP server,
   * which builds the registry once at startup.
   */
  tools?: ToolSet;
}

export async function runAgent(
  config: AgentConfig,
  incoming: ModelMessage[],
  emit: AgentEmitter,
  abortSignal?: AbortSignal,
  options: RunAgentOptions = {},
): Promise<void> {
  const messages = prepareMessages(config, incoming);
  const model = options.model ?? buildModel(config.model);
  const maxSteps = config.agent.maxSteps;

  const summarize = async (prompt: string): Promise<string> => {
    const { text } = await generateText({
      model,
      prompt,
      abortSignal,
      telemetry: telemetryOptions('configurable-agent.summarize'),
    });
    return text;
  };

  let rawTools: ToolSet;
  let cleanup: () => Promise<void> = async () => {};
  if (options.tools) {
    rawTools = options.tools;
  } else {
    const registry = await buildMcpRegistry(config);
    rawTools = registry.tools;
    cleanup = registry.cleanup;
  }
  const todoStore = createTodoStore();
  const tools = {
    ...wrapToolsWithSummarization(rawTools, { config, summarize }),
    todowrite: createTodoWriteTool(todoStore),
  };

  // Human-in-the-loop approval (AI SDK native). Gated calls surface a
  // `tool-approval-request` instead of executing; the loop pauses and the
  // client resolves it on the next request. TOOL_APPROVAL_SECRET (optional)
  // HMAC-signs approvals so a client cannot forge one for the stateless
  // /invoke history.
  const approval = config.safety.approval;
  const toolApproval =
    approval.mode === 'none'
      ? undefined
      : ({ toolCall }: { toolCall: { toolName: string } }) =>
          toolNeedsApproval(toolCall.toolName, approval) ? ('user-approval' as const) : undefined;

  try {
    const stream = streamText({
      model,
      messages,
      // Server-built system messages (base prompt) are trusted; incoming
      // system messages are stripped in prepareMessages.
      allowSystemInMessages: true,
      tools,
      toolApproval,
      experimental_toolApprovalSecret: process.env.TOOL_APPROVAL_SECRET,
      stopWhen: stepCountIs(maxSteps),
      prepareStep: async ({ stepNumber, steps: priorSteps, messages: stepMessages }) => ({
        messages: await maybeCompactMessages({
          messages: stepMessages,
          // Real provider-counted size of the previous step's prompt — the
          // compaction trigger never relies on a local token estimate.
          lastInputTokens: priorSteps.at(-1)?.usage.inputTokens,
          config,
          summarize,
          emit,
          abortSignal,
        }),
        // The final step must produce a text answer, not more tool calls.
        ...(stepNumber === maxSteps - 1 ? { toolChoice: 'none' as const } : {}),
      }),
      ...(config.output.structured
        ? { output: Output.object({ schema: jsonSchema(config.output.schema) }) }
        : {}),
      temperature: config.model.temperature,
      topP: config.model.topP,
      maxOutputTokens: config.model.maxOutputTokens,
      abortSignal,
      telemetry: telemetryOptions('configurable-agent.agent'),
    });

    let steps = 0;
    let stepText = '';
    let paused = false;

    for await (const part of stream.stream) {
      switch (part.type) {
        case 'start-step':
          steps += 1;
          stepText = '';
          break;
        case 'reasoning-delta':
          await emit({ type: 'reasoning', text: part.text });
          break;
        case 'text-delta':
          stepText += part.text;
          // In structured mode the text stream is the raw JSON of the final
          // object — never a deliverable to stream to the client.
          if (!config.output.structured) {
            await emit({ type: 'content_delta', text: part.text });
          }
          break;
        case 'tool-call':
          await emit({
            type: 'tool_call',
            id: part.toolCallId,
            name: part.toolName,
            args: part.input,
          });
          break;
        case 'tool-result': {
          const envelope = toToolResultEnvelope(part.output, part.toolName, part.input);
          await emit({ type: 'tool_result', id: part.toolCallId, output: envelope });
          break;
        }
        case 'tool-error': {
          const envelope: ToolResult = {
            label: part.toolName,
            status: 'error',
            content: String(part.error ?? 'tool error'),
            return_code: null,
            args: part.input,
            duration_ms: 0,
          };
          await emit({ type: 'tool_result', id: part.toolCallId, output: envelope });
          break;
        }
        case 'tool-approval-request': {
          paused = true;
          await emit({
            type: 'tool_approval_requested',
            id: part.toolCall.toolCallId,
            approvalId: part.approvalId,
            name: part.toolCall.toolName,
            args: part.toolCall.input,
            ...(part.signature ? { signature: part.signature } : {}),
          });
          // Also surface the standard envelope so consumers of `tool_result`
          // see the pending state (spec 003: status 'approval_required').
          await emit({
            type: 'tool_result',
            id: part.toolCall.toolCallId,
            output: {
              label: part.toolCall.toolName,
              status: 'approval_required',
              content: 'Awaiting human approval before this tool can execute.',
              return_code: null,
              args: part.toolCall.input,
              duration_ms: 0,
            },
          });
          break;
        }
        case 'tool-output-denied': {
          // Our policy only ever asks for user approval (never auto-denies),
          // so a denied output always means a human declined the call.
          await emit({
            type: 'tool_result',
            id: part.toolCallId,
            output: {
              label: part.toolName,
              status: 'denied',
              denied_reason: 'user_denied',
              content: 'Tool execution was denied by a human reviewer.',
              return_code: null,
              args: undefined,
              duration_ms: 0,
            },
          });
          break;
        }
        case 'abort':
          return;
        case 'error': {
          await emitStreamError(emit, part.error, stepText);
          return;
        }
        default:
          break;
      }
    }

    if (paused) {
      // The turn is paused for human approval, not finished: hand the client
      // the messages it needs to resume (assistant message with the approval
      // request plus any earlier tool results of this run). No `final` yet.
      await emit({
        type: 'run_paused',
        reason: 'tool_approval',
        messages: await stream.responseMessages,
      });
      return;
    }

    const finishReason = String(await stream.finishReason);
    const diagnosis = diagnoseStep({ finishReason, stepText });
    if (diagnosis) {
      await emit({ type: 'error', ...diagnosis });
      return;
    }
    if (finishReason === 'tool-calls') {
      await emit({
        type: 'error',
        code: 'tool_call_on_final_step',
        message: 'Model still requested tool calls when the step limit was reached. Aborting.',
        details: { steps },
      });
      return;
    }

    let structured: unknown;
    if (config.output.structured) {
      try {
        structured = await stream.output;
      } catch (err) {
        await emit({
          type: 'error',
          code: 'structured_output_failed',
          message: errorMessage(err),
        });
        return;
      }
    }

    const usage = await stream.usage;
    await emit({
      type: 'final',
      content: structured !== undefined ? '' : stepText,
      ...(structured !== undefined ? { structured } : {}),
      stopReason: finishReason,
      steps,
      truncated: false,
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    });
  } catch (err) {
    // A client cancellation is not an agent failure — end quietly.
    if (abortSignal?.aborted) return;
    logger.error({ err }, 'agent run failed');
    await emit({
      type: 'error',
      code: 'agent_failed',
      message: errorMessage(err),
    });
  } finally {
    await cleanup();
  }
}

export function prepareMessages(config: AgentConfig, incoming: ModelMessage[]): ModelMessage[] {
  const withoutSystem = incoming.filter((m) => m.role !== 'system');
  return [{ role: 'system', content: renderSystemPrompt(config) }, ...withoutSystem];
}

export interface StepDiagnosis {
  code: string;
  message: string;
  details?: unknown;
  partialContent?: string;
}

export function diagnoseStep(ctx: {
  finishReason: string;
  stepText: string;
}): StepDiagnosis | null {
  if (ctx.finishReason === 'length') {
    return {
      code: 'max_tokens_reached',
      message:
        'Model stopped at max_tokens limit — output is truncated. Increase maxOutputTokens or reduce input size.',
      ...(ctx.stepText ? { partialContent: ctx.stepText } : {}),
    };
  }

  return null;
}

// Rate-limit headers a client can act on; everything else in the provider
// response (org/project identifiers, request ids, account details) stays
// server-side.
const RATE_LIMIT_HEADER_RE = /^(retry-after|(x-|anthropic-)ratelimit-.*)$/i;

async function emitStreamError(
  emit: AgentEmitter,
  error: unknown,
  stepText: string,
): Promise<void> {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  logger.error({ err: cause }, 'model stream error');

  if (APICallError.isInstance(cause) && cause.statusCode === 429) {
    const responseHeaders = Object.fromEntries(
      Object.entries(cause.responseHeaders ?? {}).filter(([k]) => RATE_LIMIT_HEADER_RE.test(k)),
    );
    await emit({
      type: 'error',
      code: 'rate_limit_tokens',
      message:
        'Provider returned HTTP 429. Possible causes: rate limit, quota exhausted, or plan limit reached.',
      details: { statusCode: 429, responseHeaders },
      ...(stepText ? { partialContent: stepText } : {}),
    });
    return;
  }

  // Never emit the raw error object: APICallError serializes the full request
  // body (prompts, system prompt) and provider response.
  await emit({
    type: 'error',
    code: 'stream_error',
    message: errorMessage(cause),
    ...(APICallError.isInstance(cause)
      ? { details: { name: cause.name, statusCode: cause.statusCode } }
      : cause instanceof Error
        ? { details: { name: cause.name } }
        : {}),
    ...(stepText ? { partialContent: stepText } : {}),
  });
}

function toToolResultEnvelope(output: unknown, toolName: string, input: unknown): ToolResult {
  if (isToolResult(output)) return output;
  return {
    label: toolName,
    status: 'succeeded',
    content: typeof output === 'string' ? output : safeJson(output),
    return_code: null,
    args: input,
    duration_ms: 0,
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    !!value &&
    typeof value === 'object' &&
    'status' in value &&
    'content' in value &&
    'label' in value &&
    'duration_ms' in value
  );
}
