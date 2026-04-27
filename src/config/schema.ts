import { z } from 'zod';

export const ModelProvider = z.enum(['anthropic', 'openai', 'google', 'ollama']);
export type ModelProvider = z.infer<typeof ModelProvider>;

const JsonSchemaObject = z.record(z.unknown());

export const AgentConfigSchema = z
  .object({
    systemPrompt: z.string().min(1),
    promptVars: z.record(z.unknown()).optional(),
    model: z.object({
      provider: ModelProvider,
      name: z.string().min(1),
      baseUrl: z.string().url().optional(),
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    }),
    agent: z
      .object({
        maxSteps: z.number().int().positive().default(10),
      })
      .default({ maxSteps: 10 }),
    tools: z
      .object({
        bash: z
          .object({
            enabled: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(30_000),
            maxBufferBytes: z.number().int().positive().default(1_048_576),
            policy: z
              .object({
                approval: z
                  .object({
                    enabled: z.boolean().default(false),
                  })
                  .default({ enabled: false }),
                allowCompound: z.boolean().default(false),
                disableBuiltinAllow: z.boolean().default(false),
                bypassSecurityChecks: z.boolean().default(false),
                allow: z.array(z.string()).default([]),
                ask: z.array(z.string()).default([]),
                deny: z.array(z.string()).default([]),
              })
              .default({
                approval: { enabled: false },
                allowCompound: false,
                disableBuiltinAllow: false,
                bypassSecurityChecks: false,
                allow: [],
                ask: [],
                deny: [],
              }),
          })
          .default({
            enabled: false,
            timeoutMs: 30_000,
            maxBufferBytes: 1_048_576,
            policy: {
              approval: { enabled: false },
              allowCompound: false,
              disableBuiltinAllow: false,
              bypassSecurityChecks: false,
              allow: [],
              ask: [],
              deny: [],
            },
          }),
        websearch: z
          .object({
            enabled: z.boolean().default(false),
            maxResults: z.number().int().positive().default(5),
          })
          .default({ enabled: false, maxResults: 5 }),
        http: z
          .object({
            enabled: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(30_000),
            maxResponseBytes: z.number().int().positive().default(1_048_576),
          })
          .default({ enabled: false, timeoutMs: 30_000, maxResponseBytes: 1_048_576 }),
        todowrite: z
          .object({
            enabled: z.boolean().default(false),
            maxItems: z.number().int().positive().default(50),
          })
          .default({ enabled: false, maxItems: 50 }),
      })
      .default({
        bash: {
          enabled: false,
          timeoutMs: 30_000,
          maxBufferBytes: 1_048_576,
          policy: {
            approval: { enabled: false },
            allowCompound: false,
            disableBuiltinAllow: false,
            bypassSecurityChecks: false,
            allow: [],
            ask: [],
            deny: [],
          },
        },
        websearch: { enabled: false, maxResults: 5 },
        http: { enabled: false, timeoutMs: 30_000, maxResponseBytes: 1_048_576 },
        todowrite: { enabled: false, maxItems: 50 },
      }),
    output: z
      .discriminatedUnion('structured', [
        z.object({ structured: z.literal(false) }),
        z.object({ structured: z.literal(true), schema: JsonSchemaObject }),
      ])
      .default({ structured: false }),
    safety: z
      .object({
        compaction: z
          .object({
            triggerTokens: z.number().int().positive().default(100_000),
            keepRecentMessages: z.number().int().positive().default(6),
          })
          .default({ triggerTokens: 100_000, keepRecentMessages: 6 }),
        toolOutput: z
          .object({
            triggerTokens: z.number().int().positive().default(4_000),
            headChars: z.number().int().nonnegative().default(500),
            tailChars: z.number().int().nonnegative().default(500),
          })
          .default({ triggerTokens: 4_000, headChars: 500, tailChars: 500 }),
      })
      .default({
        compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
        toolOutput: { triggerTokens: 4_000, headChars: 500, tailChars: 500 },
      }),
    evals: z
      .object({
        dir: z.string().min(1),
      })
      .optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
