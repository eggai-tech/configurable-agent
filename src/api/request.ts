import { type ModelMessage, modelMessageSchema } from 'ai';
import { z } from 'zod';

// Reuses the AI SDK's own message schema, so the boundary accepts exactly what
// streamText accepts (text, multimodal parts, tool calls/results, approval
// responses) and malformed messages fail here with a clear 400 instead of
// mid-stream.
export const InvokeRequestSchema = z
  .object({
    messages: z
      .array(modelMessageSchema, { error: 'messages must be an array of model messages' })
      .min(1, 'messages must contain at least one message'),
  })
  .strict();

export type InvokeRequest = z.infer<typeof InvokeRequestSchema>;

export type ParsedInvokeRequest =
  | { success: true; messages: ModelMessage[] }
  | { success: false; error: z.ZodError };

/**
 * Validate an /invoke (or CLI stdin) body. On success the ORIGINAL messages
 * are returned, not the zod-parsed copy: `modelMessageSchema` strips fields it
 * does not model — notably the `signature` on tool-approval-request parts —
 * which would break HMAC-signed approval resume. The SDK validates the same
 * way internally and also passes the original messages through.
 */
export function parseInvokeRequest(body: unknown): ParsedInvokeRequest {
  const parsed = InvokeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }
  return { success: true, messages: (body as { messages: ModelMessage[] }).messages };
}
