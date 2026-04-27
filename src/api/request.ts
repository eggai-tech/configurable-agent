import { z } from 'zod';

const TextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const Content = z.union([z.string(), z.array(TextPart).min(1)]);

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

export { Content as MessageContent, TextPart };
