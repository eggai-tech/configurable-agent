import { z } from 'zod';

export const ModelProvider = z.enum([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'openai-compatible',
]);
export type ModelProvider = z.infer<typeof ModelProvider>;

const JsonSchemaObject = z.record(z.unknown());

const McpStdioServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional().default({}),
});

const McpHttpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional().default({}),
});

const McpServerSchema = z.discriminatedUnion('transport', [
  McpStdioServerSchema,
  McpHttpServerSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const AgentConfigSchema = z
  .object({
    systemPrompt: z.string().min(1),
    promptVars: z.record(z.unknown()).optional(),
    model: z.object({
      provider: ModelProvider,
      name: z.string().min(1),
      baseUrl: z.string().url().optional(),
      apiKey: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    }),
    agent: z
      .object({
        maxSteps: z.number().int().positive().default(10),
      })
      .default({ maxSteps: 10 }),
    mcpTools: z.array(McpServerSchema).optional().default([]),
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
