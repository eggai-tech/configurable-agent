import type { ModelMessage } from 'ai';

// Chars/4 approximation (the AI SDK docs' own estimator). The counts only feed
// "too big?" threshold gates, never billing, so an approximation is sufficient
// and avoids shipping a tokenizer dependency.
export function countTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function countMessagesTokens(messages: ReadonlyArray<ModelMessage>): number {
  let total = 0;
  for (const msg of messages) {
    total += countTextTokens(stringifyMessageContent(msg));
  }
  return total;
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
