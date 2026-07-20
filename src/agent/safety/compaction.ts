import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../../config/schema.js';
import { logger } from '../../observability/logger.js';
import { errorMessage } from '../../util.js';
import type { AgentEmitter, SizeSnapshot } from '../events.js';

export type Summarizer = (prompt: string) => Promise<string>;

export const COMPACTION_MARKER = '[COMPACTED CONTEXT]';

interface CompactionInputs {
  messages: ModelMessage[];
  /**
   * Provider-reported input-token count of the previous step. This is the
   * real size of the conversation as the provider counted it — no estimation.
   * Undefined on the first step (nothing sent yet) or when the provider does
   * not report usage; compaction then stays off.
   */
  lastInputTokens: number | undefined;
  config: AgentConfig;
  summarize: Summarizer;
  emit: AgentEmitter;
  abortSignal?: AbortSignal;
}

export async function maybeCompactMessages({
  messages,
  lastInputTokens,
  config,
  summarize,
  emit,
  abortSignal,
}: CompactionInputs): Promise<ModelMessage[]> {
  if (lastInputTokens === undefined || lastInputTokens <= config.safety.compaction.triggerTokens) {
    return messages;
  }

  const { baseSystem, compactable } = splitBaseSystem(messages);
  const split = chooseSplitIndex(compactable, config.safety.compaction.keepRecentMessages);
  if (split === null) {
    return messages;
  }

  const earlier = compactable.slice(0, split);
  const recent = compactable.slice(split);

  await emit({ type: 'compaction_start', before: snapshot(messages) });

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
  // dropping the earlier turns without a summary: context is lost, but the
  // history still shrinks so the loop makes progress instead of failing every
  // step.
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

  await emit({
    type: 'compaction_finished',
    before: snapshot(messages),
    after: snapshot(newMessages),
    droppedCount: earlier.length,
  });

  return newMessages;
}

function snapshot(messages: ReadonlyArray<ModelMessage>): SizeSnapshot {
  let chars = 0;
  for (const msg of messages) {
    chars += stringifyMessageContent(msg).length;
  }
  return { messages: messages.length, chars };
}

export function stringifyMessageContent(msg: ModelMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => stringifyPart(p)).join('\n');
  }
  return JSON.stringify(msg.content);
}

function stringifyPart(part: unknown): string {
  if (
    part &&
    typeof part === 'object' &&
    'text' in part &&
    typeof (part as { text: unknown }).text === 'string'
  ) {
    return (part as { text: string }).text;
  }
  return JSON.stringify(part);
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
