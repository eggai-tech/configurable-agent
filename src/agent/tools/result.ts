import { z } from 'zod';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { maybeSummarizeToolOutput } from '../safety/tool-summary.js';

export type ToolStatus = 'succeeded' | 'error' | 'denied' | 'approval_required';
export type DeniedReason = 'policy_deny' | 'user_denied' | 'policy_compound';

export const intentField = {
  intent: z
    .string()
    .min(1)
    .max(280)
    .describe(
      "One short sentence (≤140 chars) describing WHY you're making this call, written for the human watching the UI — not for the model. Be specific: 'Round 2 of eval after tightening the urgent-category prose' beats 'Running tool'. Skipping this is not allowed.",
    ),
};

export interface ToolResult {
  label: string;
  status: ToolStatus;
  content: string;
  return_code: number | null;
  args: unknown;
  duration_ms: number;
  truncated?: boolean;
  denied_reason?: DeniedReason;
}

export interface PartialToolResult {
  status: ToolStatus;
  content: string;
  return_code: number | null;
  denied_reason?: DeniedReason;
  truncated?: boolean;
}

export type ToolLabeler<Args> = (args: Args) => string;
export type ToolHandler<Args> = (
  args: Args,
  opts: { toolCallId: string; abortSignal: AbortSignal | undefined },
) => Promise<PartialToolResult | ToolResult>;

export interface WrapToolExecuteParams<Args> {
  toolName: string;
  labeler: ToolLabeler<Args>;
  handler: ToolHandler<Args>;
  ctx: ToolSummaryRuntime;
}

export async function wrapToolExecute<Args>(
  params: WrapToolExecuteParams<Args>,
  args: Args,
  opts: { toolCallId: string; abortSignal: AbortSignal | undefined },
): Promise<ToolResult> {
  const startedAt = Date.now();
  const label = safeLabel(() => params.labeler(args), params.toolName);
  let partial: PartialToolResult;
  try {
    const out = await params.handler(args, opts);
    partial = toPartial(out);
  } catch (err) {
    partial = {
      status: 'error',
      content: errorToString(err),
      return_code: null,
    };
  }
  const duration_ms = Date.now() - startedAt;
  const envelope: ToolResult = {
    label,
    status: partial.status,
    content: partial.content,
    return_code: partial.return_code,
    args,
    duration_ms,
    ...(partial.truncated ? { truncated: true } : {}),
    ...(partial.denied_reason ? { denied_reason: partial.denied_reason } : {}),
  };
  if (envelope.status === 'succeeded') {
    return await maybeSummarizeToolOutput(envelope, opts.toolCallId, params.toolName, params.ctx);
  }
  return envelope;
}

function toPartial(value: PartialToolResult | ToolResult): PartialToolResult {
  return {
    status: value.status,
    content: value.content,
    return_code: value.return_code,
    ...('truncated' in value && value.truncated ? { truncated: true } : {}),
    ...('denied_reason' in value && value.denied_reason
      ? { denied_reason: value.denied_reason }
      : {}),
  };
}

function safeLabel(fn: () => string, fallback: string): string {
  try {
    const out = fn();
    return typeof out === 'string' && out.length > 0 ? out : fallback;
  } catch {
    return fallback;
  }
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
