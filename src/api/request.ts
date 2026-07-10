import { modelMessageSchema } from 'ai';
import { z } from 'zod';

// Reuses the AI SDK's own message schema, so the boundary accepts exactly what
// streamText accepts (text, multimodal parts, tool calls/results, approval
// responses) and the parsed type IS ModelMessage — no cast, no drift, and
// malformed messages fail here with a clear 400 instead of mid-stream.
export const InvokeRequestSchema = z
  .object({
    messages: z
      .array(modelMessageSchema, { error: 'messages must be an array of model messages' })
      .min(1, 'messages must contain at least one message'),
  })
  .strict();

export type InvokeRequest = z.infer<typeof InvokeRequestSchema>;
