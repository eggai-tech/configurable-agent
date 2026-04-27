import type { ToolResult } from './tools/result.js';

export interface SizeSnapshot {
  tokens: number;
  messages: number;
}

export type AgentEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; output: ToolResult }
  | {
      type: 'tool_approval_requested';
      id: string;
      tool: 'bash';
      command: string;
      reason: string;
      policy: 'ask';
      suggestedRules: string[];
    }
  | {
      type: 'tool_output_chunk';
      id: string;
      text: string;
      seq: number;
    }
  | {
      type: 'tool_stream_end';
      id: string;
      exitCode: number;
      timedOut: boolean;
      totalBytes: number;
      truncated: boolean;
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
    }
  | { type: 'error'; code: string; message: string; details?: unknown };

export type AgentEmitter = (event: AgentEvent) => void | Promise<void>;
