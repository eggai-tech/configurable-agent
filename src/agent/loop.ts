import {
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
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

import { buildMcpTools } from './tools/mcp.js';

export type { AgentEmitter, AgentEvent } from './events.js';

export interface RunAgentOptions {
  model?: LanguageModel;
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

  const { tools, cleanup } = await buildMcpTools(config);

  try {
    let finishReason: FinishReason | 'unknown' = 'unknown';
    let lastText = '';
    let stepsRun = 0;

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

      for await (const part of stream.fullStream) {
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
