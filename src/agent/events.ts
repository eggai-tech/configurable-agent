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
  tokens: number;
  messages: number;
}

export type AgentEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: ToolResult }
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
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; code: string; message: string; details?: unknown; partialContent?: string };

export type AgentEmitter = (event: AgentEvent) => void | Promise<void>;
