import {
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  generateObject,
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
} from 'ai';
import type { AgentConfig } from '../config/schema.js';
import type { AgentEmitter } from './events.js';
import type { ToolResult } from './events.js';
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
  let messages = prepareMessages(config, incoming);
  const model = options.model ?? buildModel(config.model);
  const maxSteps = config.agent.maxSteps;

  const summarize = async (prompt: string): Promise<string> => {
    const { text } = await generateText({
      model,
      prompt,
      abortSignal,
      experimental_telemetry: { isEnabled: true, functionId: 'configurable-agent.summarize' },
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
  const mcpTools = wrapToolsWithSummarization(rawTools, { config, summarize });
  const todoStore = createTodoStore();
  const tools = {
    ...mcpTools,
    todowrite: createTodoWriteTool(todoStore),
  };

  try {
    let finishReason: FinishReason | 'unknown' = 'unknown';
    let lastText = '';
    let stepsRun = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let step = 0; step < maxSteps; step++) {
      stepsRun = step + 1;

      messages = await maybeCompactMessages({ messages, config, summarize, emit });

      const isLastStep = step === maxSteps - 1;
      const stream = streamText({
        model,
        messages,
        tools,
        stopWhen: stepCountIs(1),
        toolChoice: isLastStep ? ('none' as const) : undefined,
        temperature: config.model.temperature,
        topP: config.model.topP,
        maxOutputTokens: config.model.maxOutputTokens,
        abortSignal,
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'configurable-agent.step',
          metadata: { step: stepsRun, maxSteps },
        },
      });

      let stepHasToolCalls = false;
      let stepText = '';
      let stepResponseHeaders: Record<string, string> = {};

      for await (const part of stream.fullStream) {
        if (part.type === 'finish-step') {
          stepResponseHeaders = (part.response?.headers ?? {}) as Record<string, string>;
        }
        switch (part.type) {
          case 'reasoning-delta':
            await emit({ type: 'reasoning', text: part.text });
            break;
          case 'text-delta':
            stepText += part.text;
            await emit({ type: 'content_delta', text: part.text });
            break;
          case 'tool-call':
            stepHasToolCalls = true;
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
              content: String((part as { error?: unknown }).error ?? 'tool error'),
              return_code: null,
              args: part.input,
              duration_ms: 0,
            };
            await emit({ type: 'tool_result', id: part.toolCallId, output: envelope });
            break;
          }
          case 'error':
            await emit({
              type: 'error',
              code: 'stream_error',
              message: errorMessage(part.error),
              details: part.error,
              ...(stepText ? { partialContent: stepText } : {}),
            });
            return;
          default:
            break;
        }
      }

      lastText = stepText;
      const response = await stream.response;
      messages = [...messages, ...response.messages];
      finishReason = await stream.finishReason;
      const stepUsage = await stream.usage;
      totalInputTokens += stepUsage.inputTokens ?? 0;
      totalOutputTokens += stepUsage.outputTokens ?? 0;
      const remainingTokens = stepResponseHeaders['x-ratelimit-remaining-tokens'];
      const limitTokens = stepResponseHeaders['x-ratelimit-limit-tokens'];
      const resetTokens = stepResponseHeaders['x-ratelimit-reset-tokens'];
      if (remainingTokens !== undefined && limitTokens !== undefined) {
        const remaining = Number.parseInt(remainingTokens, 10);
        const limit = Number.parseInt(limitTokens, 10);
        if (!Number.isNaN(remaining) && !Number.isNaN(limit) && remaining / limit < 0.05) {
          await emit({
            type: 'error',
            code: 'rate_limit_tokens',
            message: `TPM rate limit exhausted: input consumed ${limit - remaining}/${limit} tokens, leaving only ${remaining} for output${resetTokens ? ` (resets in ${resetTokens})` : ''}. Split the request into smaller batches.`,
            details: { remaining, limit, resetTokens },
            ...(stepText ? { partialContent: stepText } : {}),
          });
          return;
        }
      }

      if (isLastStep && stepHasToolCalls) {
        await emit({
          type: 'error',
          code: 'tool_call_on_final_step',
          message:
            'Model produced tool calls on the final step despite toolChoice: none. Aborting.',
          details: { step: stepsRun },
        });
        return;
      }

      if (!stepHasToolCalls) {
        let structured: unknown;
        if (config.output.structured) {
          try {
            const { object } = await generateObject({
              model,
              messages,
              schema: jsonSchema(config.output.schema),
              abortSignal,
              experimental_telemetry: {
                isEnabled: true,
                functionId: 'configurable-agent.structured',
              },
            });
            structured = object;
          } catch (err) {
            await emit({
              type: 'error',
              code: 'structured_output_failed',
              message: errorMessage(err),
              details: { error: String(err) },
            });
            return;
          }
        }

        await emit({
          type: 'final',
          content: lastText,
          ...(structured !== undefined ? { structured } : {}),
          stopReason: String(finishReason),
          steps: stepsRun,
          truncated: false,
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        });
        return;
      }
    }
  } catch (err) {
    if (isAbortError(err)) return;
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'ResponseAborted' || err.message.includes('abort'))
  );
}
