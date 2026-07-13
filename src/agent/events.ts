import type { ModelMessage } from 'ai';
import { safeJson } from '../util.js';

export type ToolStatus = 'succeeded' | 'error' | 'denied' | 'approval_required';
export type DeniedReason = 'policy_deny' | 'user_denied' | 'policy_compound';

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

export interface SizeSnapshot {
  messages: number;
  chars: number;
}

export type AgentEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: ToolResult }
  | {
      // A tool call requires human approval before it can execute. `signature`
      // is present only when TOOL_APPROVAL_SECRET is configured and must be
      // echoed back verbatim in the response.
      type: 'tool_approval_requested';
      id: string;
      approvalId: string;
      name: string;
      args: unknown;
      signature?: string;
    }
  | {
      // The run is paused waiting for human input. `messages` carries the
      // ModelMessages produced by this run so far; a stateless client resumes
      // by re-POSTing its original messages + these + its approval response.
      type: 'run_paused';
      reason: 'tool_approval';
      messages: ModelMessage[];
    }
  | { type: 'content_delta'; text: string }
  | {
      type: 'compaction_start';
      before: SizeSnapshot;
    }
  | {
      type: 'compaction_finished';
      before: SizeSnapshot;
      after: SizeSnapshot;
      droppedCount: number;
    }
  | {
      type: 'final';
      content: string;
      structured?: unknown;
      stopReason: string;
      steps: number;
      truncated: boolean;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; code: string; message: string; details?: unknown; partialContent?: string };

export type AgentEmitter = (event: AgentEvent) => void | Promise<void>;

/**
 * Shared `toModelOutput` for tools whose execute() returns a ToolResult
 * envelope: the model sees the envelope's content (as error text for failed
 * calls), never the raw envelope JSON.
 */
export function toolResultToModelOutput({ output }: { output: unknown }) {
  const env = output as ToolResult;
  const text = typeof env?.content === 'string' ? env.content : safeJson(env);
  if (env?.status === 'error') {
    return { type: 'error-text', value: text } as const;
  }
  return { type: 'text', value: text } as const;
}
