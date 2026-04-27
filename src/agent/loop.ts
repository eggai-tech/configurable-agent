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
import type { ApprovalDecision } from '../api/request.js';
import type { AgentConfig } from '../config/schema.js';
import type { AgentEmitter } from './events.js';
import { buildModel } from './model.js';
import { renderSystemPrompt } from './prompt.js';
import { type Summarizer, maybeCompactMessages } from './safety/compaction.js';
import type { ApprovalRecord, ToolSummaryRuntime } from './safety/tool-summary.js';
import { gateCommand, runBashStreaming } from './tools/bash.js';
import { buildTools } from './tools/index.js';
import { type ToolResult, wrapToolExecute } from './tools/result.js';

export type { AgentEmitter, AgentEvent } from './events.js';

export interface RunAgentOptions {
  approvals?: ApprovalDecision[];
  sessionAllowRules?: string[];
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

  const summarize: Summarizer = async (prompt) => {
    const { text } = await generateText({
      model,
      prompt,
      abortSignal,
      experimental_telemetry: { isEnabled: true, functionId: 'wally.summarize' },
    });
    return text;
  };

  const approvalMap = buildApprovalMap(options.approvals ?? []);
  const sessionAllowRules = new Set<string>(options.sessionAllowRules ?? []);
  for (const [, record] of approvalMap) {
    if (record.decision === 'allow_session' && record.rule) {
      sessionAllowRules.add(record.rule);
    }
  }

  const toolCtx: ToolSummaryRuntime = {
    config,
    emit,
    summarize,
    approvals: approvalMap,
    sessionAllowRules,
    pendingApprovals: new Set<string>(),
  };
  const tools = buildTools(config, toolCtx);

  try {
    messages = await resolvePendingToolCalls(messages, config, toolCtx, abortSignal);
    if (toolCtx.pendingApprovals.size > 0) {
      return;
    }

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
          functionId: 'wally.step',
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
            const envelope = ensureToolResultEnvelope(part.output, part.toolName, part.input);
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

      if (toolCtx.pendingApprovals.size > 0) {
        return;
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
              experimental_telemetry: { isEnabled: true, functionId: 'wally.structured' },
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
  }
}

export function prepareMessages(config: AgentConfig, incoming: ModelMessage[]): ModelMessage[] {
  const withoutSystem = incoming.filter((m) => m.role !== 'system');
  return [{ role: 'system', content: renderSystemPrompt(config) }, ...withoutSystem];
}

function buildApprovalMap(approvals: ApprovalDecision[]): Map<string, ApprovalRecord> {
  const map = new Map<string, ApprovalRecord>();
  for (const a of approvals) {
    map.set(a.toolCallId, { decision: a.decision, rule: a.rule });
  }
  return map;
}

interface ToolCallRef {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

async function resolvePendingToolCalls(
  messages: ModelMessage[],
  config: AgentConfig,
  ctx: ToolSummaryRuntime,
  abortSignal: AbortSignal | undefined,
): Promise<ModelMessage[]> {
  const resolvedIds = collectResolvedToolCallIds(messages);
  const pendingCalls = collectToolCallsMissingResults(messages, resolvedIds);
  if (pendingCalls.length === 0) return messages;

  const newToolResults: Array<{ toolCallId: string; toolName: string; output: ToolResult }> = [];

  for (const call of pendingCalls) {
    if (call.toolName !== 'bash') {
      throw new Error(
        `Unresolved tool_use for non-bash tool "${call.toolName}" (id=${call.toolCallId}) — approval flow only supports bash`,
      );
    }
    const command = extractBashCommand(call.input);
    if (!command) {
      throw new Error(`Unresolved bash tool_use (id=${call.toolCallId}) has no command input`);
    }
    const bashCfg = bashConfigFromAgentConfig(config);
    const envelope = await wrapToolExecute<{ command: string }>(
      {
        toolName: 'bash',
        labeler: (a) => a.command,
        handler: async (a, opts) => {
          const gate = await gateCommand(a.command, bashCfg, ctx, opts.toolCallId);
          if (gate) return gate;
          return runBashStreaming(a.command, bashCfg, ctx.emit, opts.toolCallId, opts.abortSignal);
        },
        ctx,
      },
      { command },
      { toolCallId: call.toolCallId, abortSignal },
    );
    await ctx.emit({ type: 'tool_result', id: call.toolCallId, output: envelope });
    newToolResults.push({
      toolCallId: call.toolCallId,
      toolName: 'bash',
      output: envelope,
    });
  }

  if (newToolResults.length === 0) return messages;

  const toolMessage: ModelMessage = {
    role: 'tool',
    content: newToolResults.map((r) => ({
      type: 'tool-result' as const,
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: { type: 'json' as const, value: r.output as never },
    })),
  };
  return [...messages, toolMessage];
}

function collectResolvedToolCallIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        (part as { type: string }).type === 'tool-result'
      ) {
        const id = (part as { toolCallId?: unknown }).toolCallId;
        if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return ids;
}

function collectToolCallsMissingResults(
  messages: ModelMessage[],
  resolvedIds: Set<string>,
): ToolCallRef[] {
  const missing: ToolCallRef[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        (part as { type: string }).type === 'tool-call'
      ) {
        const p = part as {
          toolCallId?: unknown;
          toolName?: unknown;
          input?: unknown;
        };
        if (typeof p.toolCallId === 'string' && typeof p.toolName === 'string') {
          if (!resolvedIds.has(p.toolCallId)) {
            missing.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
          }
        }
      }
    }
  }
  return missing;
}

function extractBashCommand(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in input) {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === 'string' && cmd.length > 0) return cmd;
  }
  return null;
}

function bashConfigFromAgentConfig(config: AgentConfig): {
  timeoutMs: number;
  maxBufferBytes: number;
  policy: {
    approvalEnabled: boolean;
    allowCompound: boolean;
    disableBuiltinAllow: boolean;
    bypassSecurityChecks: boolean;
    allow: string[];
    ask: string[];
    deny: string[];
  };
} {
  const bash = config.tools.bash;
  return {
    timeoutMs: bash.timeoutMs,
    maxBufferBytes: bash.maxBufferBytes,
    policy: {
      approvalEnabled: bash.policy.approval.enabled,
      allowCompound: bash.policy.allowCompound,
      disableBuiltinAllow: bash.policy.disableBuiltinAllow,
      bypassSecurityChecks: bash.policy.bypassSecurityChecks,
      allow: bash.policy.allow,
      ask: bash.policy.ask,
      deny: bash.policy.deny,
    },
  };
}

function ensureToolResultEnvelope(output: unknown, toolName: string, input: unknown): ToolResult {
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
