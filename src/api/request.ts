import { z } from 'zod';

// `content` is intentionally `unknown`: a ModelMessage's content spans many
// shapes (text, image, file, tool-call, tool-result parts). The AI SDK
// validates the full structure downstream, so we only assert the envelope
// (role + a present content field) here.
export const InvokeRequestSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          content: z.unknown(),
        }),
      )
      .min(1),
  })
  .strict();

export type InvokeRequest = z.infer<typeof InvokeRequestSchema>;
