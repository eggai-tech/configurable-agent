import { z } from 'zod';

export const ModelProvider = z.enum([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'openai-compatible',
]);
export type ModelProvider = z.infer<typeof ModelProvider>;

const JsonSchemaObject = z.record(z.string(), z.unknown());

const McpStdioServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

const McpHttpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const McpServerSchema = z.discriminatedUnion('transport', [
  McpStdioServerSchema,
  McpHttpServerSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const AgentConfigSchema = z
  .object({
    systemPrompt: z.string().min(1),
    promptVars: z.record(z.string(), z.unknown()).optional(),
    model: z.object({
      provider: ModelProvider,
      name: z.string().min(1),
      baseUrl: z.url().optional(),
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    }),
    agent: z
      .object({
        maxSteps: z.number().int().positive().default(10),
      })
      .prefault({}),
    mcpTools: z.array(McpServerSchema).default([]),
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
          .prefault({}),
        toolOutput: z
          .object({
            triggerTokens: z.number().int().positive().default(4_000),
            headChars: z.number().int().nonnegative().default(500),
            tailChars: z.number().int().nonnegative().default(500),
          })
          .prefault({}),
        approval: z
          .object({
            // 'none' — no tool ever needs approval (default).
            // 'all'  — every model-invoked tool needs human approval.
            // 'selected' — only tools whose name matches a `tools` pattern.
            mode: z.enum(['none', 'all', 'selected']).default('none'),
            // Glob-style name patterns (`*` wildcard), used when mode is
            // 'selected', e.g. "delete_*", "send_email".
            tools: z.array(z.string()).default([]),
          })
          .prefault({}),
      })
      .prefault({}),
    evals: z
      .object({
        dir: z.string().min(1),
      })
      .optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
