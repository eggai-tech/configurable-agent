import { z } from 'zod';

const TextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const Content = z.union([z.string(), z.array(TextPart).min(1)]);

export const ApprovalDecisionSchema = z
  .object({
    toolCallId: z.string().min(1),
    decision: z.enum(['allow_once', 'allow_session', 'deny']),
    rule: z.string().min(1).optional(),
  })
  .strict()
  .refine((d) => d.decision !== 'allow_session' || typeof d.rule === 'string', {
    message: 'rule is required when decision is allow_session',
    path: ['rule'],
  });

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

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
    approvals: z.array(ApprovalDecisionSchema).optional(),
    sessionAllowRules: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type InvokeRequest = z.infer<typeof InvokeRequestSchema>;

export { Content as MessageContent, TextPart };
