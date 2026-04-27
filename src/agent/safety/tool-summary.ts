import type { AgentConfig } from '../../config/schema.js';
import type { AgentEmitter } from '../events.js';
import type { ToolResult } from '../tools/result.js';
import type { Summarizer } from './compaction.js';
import { countTextTokens } from './tokens.js';

export type ApprovalDecisionKind = 'allow_once' | 'allow_session' | 'deny';

export interface ApprovalRecord {
  decision: ApprovalDecisionKind;
  rule?: string;
}

export interface ToolSummaryRuntime {
  config: AgentConfig;
  emit: AgentEmitter;
  summarize: Summarizer;
  approvals: Map<string, ApprovalRecord>;
  sessionAllowRules: Set<string>;
  pendingApprovals: Set<string>;
}

export async function maybeSummarizeToolOutput(
  envelope: ToolResult,
  _toolCallId: string,
  toolName: string,
  ctx: ToolSummaryRuntime,
): Promise<ToolResult> {
  const rawTokens = countTextTokens(envelope.content);
  const { triggerTokens, headChars, tailChars } = ctx.config.safety.toolOutput;
  if (rawTokens <= triggerTokens) {
    return envelope;
  }

  const raw = envelope.content;
  const headExcerpt = raw.slice(0, headChars);
  const tailExcerpt = raw.length > headChars + tailChars ? raw.slice(-tailChars) : '';

  const summaryPrompt = [
    `The "${toolName}" tool returned output too large to include verbatim in the`,
    'conversation history. Summarize it concisely (2-4 sentences) so that a',
    'downstream reasoning step still has the information needed to answer the',
    "user's original question. Focus on facts, errors, structured results, and",
    'identifiers; omit noise like repeated lines or formatting.',
    '',
    'Tool output (may be truncated):',
    raw.slice(0, 40_000),
  ].join('\n');

  const summary = await ctx.summarize(summaryPrompt);

  const parts = [summary, '', `--- HEAD (first ${headChars} chars) ---`, headExcerpt];
  if (tailExcerpt.length > 0) {
    parts.push('', `--- TAIL (last ${tailChars} chars) ---`, tailExcerpt);
  }

  return {
    ...envelope,
    content: parts.join('\n'),
    truncated: true,
  };
}
