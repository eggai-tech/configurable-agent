import type { AgentConfig } from '../../config/schema.js';
import { logger } from '../../observability/logger.js';
import { errorMessage } from '../../util.js';
import type { ToolResult } from '../events.js';
import type { Summarizer } from './compaction.js';

export interface ToolSummaryRuntime {
  config: AgentConfig;
  summarize: Summarizer;
}

const SUMMARY_INPUT_CHAR_LIMIT = 40_000;

export async function maybeSummarizeToolOutput(
  envelope: ToolResult,
  toolName: string,
  ctx: ToolSummaryRuntime,
): Promise<ToolResult> {
  const { triggerChars, headChars, tailChars } = ctx.config.safety.toolOutput;
  if (envelope.content.length <= triggerChars) {
    return envelope;
  }

  const raw = envelope.content;
  const headExcerpt = raw.slice(0, headChars);
  // Guard tailChars > 0: `slice(-0)` would return the entire raw string.
  const tailExcerpt =
    tailChars > 0 && raw.length > headChars + tailChars ? raw.slice(-tailChars) : '';

  const summaryPrompt = [
    `The "${toolName}" tool returned output too large to include verbatim in the`,
    'conversation history. Summarize it concisely (2-4 sentences) so that a',
    'downstream reasoning step still has the information needed to answer the',
    "user's original question. Focus on facts, errors, structured results, and",
    'identifiers; omit noise like repeated lines or formatting.',
    '',
    'Tool output (may be truncated):',
    raw.slice(0, SUMMARY_INPUT_CHAR_LIMIT),
  ].join('\n');

  // The tool itself succeeded; only shrinking its output failed. Degrade to a
  // head/tail excerpt rather than throwing, which would wrongly surface as a
  // tool error and discard a real result.
  let summary: string | null = null;
  try {
    summary = await ctx.summarize(summaryPrompt);
  } catch (err) {
    logger.warn(
      { tool: toolName, err: errorMessage(err) },
      'tool-output summarization failed; falling back to truncation',
    );
  }

  const parts = summary
    ? [summary, '']
    : ['[summary unavailable — showing truncated raw output]', ''];
  parts.push(`--- HEAD (first ${headChars} chars) ---`, headExcerpt);
  if (tailExcerpt.length > 0) {
    parts.push('', `--- TAIL (last ${tailChars} chars) ---`, tailExcerpt);
  }

  return {
    ...envelope,
    content: parts.join('\n'),
    truncated: true,
  };
}
