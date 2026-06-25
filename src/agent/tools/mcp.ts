import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import type { experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { type Tool, type ToolSet, jsonSchema } from 'ai';
import type { AgentConfig, McpServerConfig } from '../../config/schema.js';
import type { ToolResult } from '../events.js';
import { type ToolSummaryRuntime, maybeSummarizeToolOutput } from '../safety/tool-summary.js';

export interface McpRegistry {
  tools: ToolSet;
  cleanup: () => Promise<void>;
}

/**
 * Discover and validate all configured MCP servers up front. Intended to run once
 * at service startup so tool-name conflicts and broken connectivity surface as
 * startup failures rather than per-request errors.
 */
export async function buildMcpRegistry(cfg: AgentConfig): Promise<McpRegistry> {
  const clients: MCPClient[] = [];
  const allTools: Record<string, Tool> = {};

  try {
    for (const server of cfg.mcpTools) {
      const client = await createClientForServer(server);
      clients.push(client);
      const serverTools = (await client.tools()) as Record<string, Tool>;
      normalizeToolSchemas(serverTools);
      for (const toolName of Object.keys(serverTools)) {
        if (Object.prototype.hasOwnProperty.call(allTools, toolName)) {
          throw new Error(
            `MCP tool name conflict: "${toolName}" is exposed by "${server.name}" but already registered by a previously loaded server`,
          );
        }
      }
      Object.assign(allTools, serverTools);
    }
  } catch (err) {
    await closeAll(clients);
    throw err;
  }

  return {
    tools: allTools as ToolSet,
    cleanup: () => closeAll(clients),
  };
}

async function createClientForServer(server: McpServerConfig): Promise<MCPClient> {
  if (server.transport === 'stdio') {
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: { ...process.env, ...server.env } as Record<string, string>,
      }),
    });
  }
  return createMCPClient({
    transport: {
      type: 'http',
      url: server.url,
      headers: server.headers,
    },
  });
}

async function closeAll(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}

/**
 * Some MCP servers ship tool input schemas using legacy JSON Schema idioms
 * (e.g. draft-04 boolean `exclusiveMinimum`). The Anthropic API validates tool
 * `input_schema` strictly against draft 2020-12 and rejects the whole request
 * if any tool is non-conformant. We rewrite each tool's raw schema in place so a
 * single misbehaving server tool cannot take down every /invoke call.
 */
function normalizeToolSchemas(tools: Record<string, Tool>): void {
  for (const t of Object.values(tools)) {
    const input = (t as { inputSchema?: { jsonSchema?: unknown } }).inputSchema;
    if (input && typeof input === 'object' && 'jsonSchema' in input) {
      (t as { inputSchema: unknown }).inputSchema = jsonSchema(
        normalizeJsonSchemaDraft2020(input.jsonSchema) as Parameters<typeof jsonSchema>[0],
      );
    }
  }
}

/**
 * Recursively coerce a JSON Schema to draft 2020-12. Currently converts the
 * draft-04 boolean form of `exclusiveMinimum`/`exclusiveMaximum` to the numeric
 * 2020-12 form. Returns a new object; the input is not mutated.
 */
export function normalizeJsonSchemaDraft2020(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(normalizeJsonSchemaDraft2020);
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    out[key] = normalizeJsonSchemaDraft2020(value);
  }
  for (const [bound, exclusive] of [
    ['minimum', 'exclusiveMinimum'],
    ['maximum', 'exclusiveMaximum'],
  ] as const) {
    if (typeof out[exclusive] === 'boolean') {
      // draft-04: { minimum: N, exclusiveMinimum: true } -> 2020-12: { exclusiveMinimum: N }
      if (out[exclusive] === true && typeof out[bound] === 'number') {
        out[exclusive] = out[bound];
        delete out[bound];
      } else {
        // exclusiveMinimum: false (or no numeric bound) is just a plain bound
        delete out[exclusive];
      }
    }
  }
  return out;
}

/**
 * Wrap each tool's `execute()` so that MCP results are converted into the
 * `ToolResult` envelope and run through `maybeSummarizeToolOutput()` before they
 * are emitted to the caller AND before they are appended to message history.
 *
 * This is the seam that prevents oversized raw MCP output from leaking into the
 * next reasoning step.
 */
export function wrapToolsWithSummarization(tools: ToolSet, ctx: ToolSummaryRuntime): ToolSet {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = wrapTool(name, t, ctx);
  }
  return wrapped as ToolSet;
}

type ExecuteFn = (input: unknown, options: unknown) => unknown | Promise<unknown>;

function wrapTool(name: string, t: Tool, ctx: ToolSummaryRuntime): Tool {
  const original = (t as { execute?: ExecuteFn }).execute;
  if (typeof original !== 'function') {
    return t;
  }
  const wrapped = {
    ...t,
    async execute(input: unknown, options: unknown) {
      const start = Date.now();
      const raw = await original.call(t, input, options);
      const envelope = mcpResultToEnvelope(raw, name, input, Date.now() - start);
      return maybeSummarizeToolOutput(envelope, name, ctx);
    },
    // AI SDK v6 invokes toModelOutput with { toolCallId, input, output }, where
    // `output` is the value returned by execute() (our ToolResult envelope).
    toModelOutput({ output }: { output: unknown }) {
      const env = output as ToolResult;
      const text = typeof env?.content === 'string' ? env.content : safeJson(env);
      if (env?.status === 'error') {
        return { type: 'error-text', value: text } as const;
      }
      return { type: 'text', value: text } as const;
    },
  };
  return wrapped as unknown as Tool;
}

function mcpResultToEnvelope(
  raw: unknown,
  toolName: string,
  args: unknown,
  durationMs: number,
): ToolResult {
  if (raw && typeof raw === 'object') {
    if (Array.isArray((raw as { content?: unknown }).content)) {
      const parts = (raw as { content: Array<{ type?: string; text?: string }> }).content;
      const text = parts
        .map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : safeJson(p)))
        .join('\n');
      const isError = (raw as { isError?: boolean }).isError === true;
      return {
        label: toolName,
        status: isError ? 'error' : 'succeeded',
        content: text,
        return_code: null,
        args,
        duration_ms: durationMs,
      };
    }
    if ('toolResult' in raw) {
      return {
        label: toolName,
        status: 'succeeded',
        content: safeJson((raw as { toolResult: unknown }).toolResult),
        return_code: null,
        args,
        duration_ms: durationMs,
      };
    }
  }
  return {
    label: toolName,
    status: 'succeeded',
    content: typeof raw === 'string' ? raw : safeJson(raw),
    return_code: null,
    args,
    duration_ms: durationMs,
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
