import { z } from 'zod';

export const ModelProvider = z.enum(
  ['anthropic', 'openai', 'google', 'ollama', 'openai-compatible'],
  { error: 'model.provider must be one of: anthropic, openai, google, ollama, openai-compatible' },
);
export type ModelProvider = z.infer<typeof ModelProvider>;

const JsonSchemaObject = z.record(z.string(), z.unknown(), {
  error: 'output.schema must be a JSON Schema object',
});

const McpStdioServerSchema = z.strictObject({
  name: z.string().min(1, 'MCP server name must not be empty'),
  transport: z.literal('stdio'),
  command: z.string().min(1, 'stdio MCP server needs a non-empty command'),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

const McpHttpServerSchema = z.strictObject({
  name: z.string().min(1, 'MCP server name must not be empty'),
  transport: z.literal('http'),
  url: z.url('http MCP server needs a valid url (e.g. https://host/mcp)'),
  headers: z.record(z.string(), z.string()).default({}),
});

const McpServerSchema = z.discriminatedUnion('transport', [
  McpStdioServerSchema,
  McpHttpServerSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const AgentConfigSchema = z
  .object({
    systemPrompt: z.string().min(1, 'systemPrompt must not be empty'),
    promptVars: z.record(z.string(), z.unknown()).optional(),
    model: z.strictObject({
      provider: ModelProvider,
      name: z.string().min(1, 'model.name must not be empty'),
      baseUrl: z.url('model.baseUrl must be a valid URL').optional(),
      temperature: z
        .number()
        .min(0, 'model.temperature must be between 0 and 2')
        .max(2, 'model.temperature must be between 0 and 2')
        .optional(),
      topP: z
        .number()
        .min(0, 'model.topP must be between 0 and 1')
        .max(1, 'model.topP must be between 0 and 1')
        .optional(),
      maxOutputTokens: z
        .number()
        .int('model.maxOutputTokens must be a positive integer')
        .positive('model.maxOutputTokens must be a positive integer')
        .optional(),
    }),
    agent: z
      .strictObject({
        maxSteps: z
          .number()
          .int('agent.maxSteps must be a positive integer')
          .positive('agent.maxSteps must be a positive integer')
          .default(10),
      })
      .prefault({}),
    mcpTools: z.array(McpServerSchema).default([]),
    output: z
      .discriminatedUnion('structured', [
        z.strictObject({ structured: z.literal(false) }),
        z.strictObject({ structured: z.literal(true), schema: JsonSchemaObject }),
      ])
      .default({ structured: false }),
    safety: z
      .strictObject({
        compaction: z
          .strictObject({
            triggerTokens: z
              .number()
              .int('safety.compaction.triggerTokens must be a positive integer')
              .positive('safety.compaction.triggerTokens must be a positive integer')
              .default(100_000),
            keepRecentMessages: z
              .number()
              .int('safety.compaction.keepRecentMessages must be a positive integer')
              .positive('safety.compaction.keepRecentMessages must be a positive integer')
              .default(6),
          })
          .prefault({}),
        toolOutput: z
          .strictObject({
            triggerTokens: z
              .number()
              .int('safety.toolOutput.triggerTokens must be a positive integer')
              .positive('safety.toolOutput.triggerTokens must be a positive integer')
              .default(4_000),
            headChars: z
              .number()
              .int('safety.toolOutput.headChars must be a non-negative integer')
              .nonnegative('safety.toolOutput.headChars must be a non-negative integer')
              .default(500),
            tailChars: z
              .number()
              .int('safety.toolOutput.tailChars must be a non-negative integer')
              .nonnegative('safety.toolOutput.tailChars must be a non-negative integer')
              .default(500),
          })
          .prefault({}),
        approval: z
          .strictObject({
            // 'none' — no tool ever needs approval (default).
            // 'all'  — every model-invoked tool needs human approval.
            // 'selected' — only tools whose name matches a `tools` pattern.
            mode: z
              .enum(['none', 'all', 'selected'], {
                error: 'safety.approval.mode must be one of: none, all, selected',
              })
              .default('none'),
            // Glob-style name patterns (`*` wildcard), used when mode is
            // 'selected', e.g. "delete_*", "send_email".
            tools: z.array(z.string()).default([]),
          })
          .prefault({}),
      })
      .prefault({}),
    evals: z
      .strictObject({
        dir: z.string().min(1, 'evals.dir must not be empty'),
      })
      .optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
