import type { ModelMessage } from 'ai';
import { countTokens as gptCountTokens } from 'gpt-tokenizer';

// gpt-tokenizer uses o200k_base (GPT-4o) by default. It's an approximation for
// Anthropic/Google; Anthropic tokens are typically ~25% shorter than OpenAI's,
// so this over-counts — safe for "too big?" thresholds.

export function countTextTokens(text: string): number {
  return gptCountTokens(text);
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
