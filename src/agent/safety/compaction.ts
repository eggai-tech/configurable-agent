import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../../config/schema.js';
import type { AgentEmitter } from '../events.js';
import { countMessagesTokens, stringifyMessageContent } from './tokens.js';

export type Summarizer = (prompt: string) => Promise<string>;

interface CompactionInputs {
  messages: ModelMessage[];
  config: AgentConfig;
  summarize: Summarizer;
  emit: AgentEmitter;
}

export async function maybeCompactMessages({
  messages,
  config,
  summarize,
  emit,
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
  if (earlier.length === 0) return messages;

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

  const summary = await summarize(summaryPrompt);

  const summaryMessage: ModelMessage = {
    role: 'system',
    content: `[COMPACTED CONTEXT]\n${summary}`,
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

// Pick a split index such that `recent` starts on a safe boundary (a user
// message, so we don't break an assistant/tool pair).
function chooseSplitIndex(messages: ModelMessage[], keepRecent: number): number | null {
  if (messages.length <= keepRecent) return null;

  let idx = Math.max(0, messages.length - keepRecent);
  while (idx < messages.length && messages[idx]?.role !== 'user') {
    idx++;
  }
  if (idx >= messages.length) return null;
  if (idx === 0) return null;
  return idx;
}
