import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../../config/schema.js';
import { logger } from '../../observability/logger.js';
import { errorMessage } from '../../util.js';
import type { AgentEmitter } from '../events.js';
import { countMessagesTokens, stringifyMessageContent } from './tokens.js';

export type Summarizer = (prompt: string) => Promise<string>;

export const COMPACTION_MARKER = '[COMPACTED CONTEXT]';

interface CompactionInputs {
  messages: ModelMessage[];
  config: AgentConfig;
  summarize: Summarizer;
  emit: AgentEmitter;
  abortSignal?: AbortSignal;
}

export async function maybeCompactMessages({
  messages,
  config,
  summarize,
  emit,
  abortSignal,
}: CompactionInputs): Promise<ModelMessage[]> {
  const beforeTokens = countMessagesTokens(messages);
  if (beforeTokens <= config.safety.compaction.triggerTokens) {
    return messages;
  }

  const { baseSystem, compactable } = splitBaseSystem(messages);
  const split = chooseSplitIndex(compactable, config.safety.compaction.keepRecentMessages);
  if (split === null) {
    return messages;
  }

  const earlier = compactable.slice(0, split);
  const recent = compactable.slice(split);

  await emit({
    type: 'compaction_start',
    before: { tokens: beforeTokens, messages: messages.length },
  });

  const earlierText = earlier
    .map((m, i) => `--- message ${i + 1} (${m.role}) ---\n${stringifyMessageContent(m)}`)
    .join('\n\n');

  const summaryPrompt = [
    'Summarize the conversation below as concisely as possible while preserving:',
    "- the user's original request and any follow-up requests",
    '- key facts, decisions, and tool results that might be relevant later',
    '- any pending action items or unresolved questions',
    '',
    'Reply ONLY with the summary, no preamble.',
    '',
    earlierText,
  ].join('\n');

  // A summarizer outage must not abort an otherwise-healthy run. Fall back to
  // dropping the earlier turns without a summary: context is lost, but tokens
  // still shrink so the loop makes progress instead of failing every step.
  let summary: string;
  try {
    summary = await summarize(summaryPrompt);
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    logger.warn(
      { err: errorMessage(err) },
      'context compaction summarization failed; dropping earlier turns without a summary',
    );
    summary = '[earlier conversation omitted — summarization unavailable]';
  }

  // The summary rides as a user message: providers such as Anthropic reject a
  // conversation whose first non-system message is not user-role, which would
  // otherwise happen whenever `recent` starts on an assistant message.
  const summaryMessage: ModelMessage = {
    role: 'user',
    content: `${COMPACTION_MARKER}\n${summary}`,
  };

  const newMessages: ModelMessage[] = [
    ...(baseSystem ? [baseSystem] : []),
    summaryMessage,
    ...recent,
  ];
  const afterTokens = countMessagesTokens(newMessages);

  await emit({
    type: 'compaction_finished',
    before: { tokens: beforeTokens, messages: messages.length },
    after: { tokens: afterTokens, messages: newMessages.length },
    droppedCount: earlier.length,
  });

  return newMessages;
}

function splitBaseSystem(messages: ModelMessage[]): {
  baseSystem: ModelMessage | null;
  compactable: ModelMessage[];
} {
  const [first, ...rest] = messages;
  if (first?.role === 'system') {
    return { baseSystem: first, compactable: rest };
  }
  return { baseSystem: null, compactable: messages };
}

// Pick a split index so `recent` never starts on a tool message — that would
// separate an assistant tool-call from its tool results and break the
// assistant/tool pairing providers require. Any user or assistant boundary is
// safe (an assistant tool-call keeps its results because they follow it).
function chooseSplitIndex(messages: ModelMessage[], keepRecent: number): number | null {
  if (messages.length <= keepRecent) return null;

  let idx = messages.length - keepRecent;
  while (idx < messages.length && messages[idx]?.role === 'tool') {
    idx++;
  }
  if (idx >= messages.length || idx === 0) return null;
  return idx;
}
