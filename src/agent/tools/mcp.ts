import type { MCPClient } from '@ai-sdk/mcp';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { jsonSchema, type Tool, type ToolSet } from 'ai';
import type { AgentConfig, McpServerConfig } from '../../config/schema.js';
import { logger } from '../../observability/logger.js';
import { errorMessage, positiveIntFromEnv, safeJson } from '../../util.js';
import type { ToolResult } from '../events.js';
import { toolResultToModelOutput } from '../events.js';
import { maybeSummarizeToolOutput, type ToolSummaryRuntime } from '../safety/tool-summary.js';

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
  const discoveryTimeoutMs = positiveIntFromEnv('MCP_DISCOVERY_TIMEOUT_MS', 30_000);

  try {
    for (const server of cfg.mcpTools) {
      logger.debug(
        { server: server.name, transport: server.transport },
        'connecting to MCP server',
      );

      let serverTools: Record<string, Tool>;
      try {
        // Neither connect nor tool discovery has a protocol-level timeout: a
        // hung server would otherwise block startup (and /health) forever.
        serverTools = await withTimeout(
          discoveryTimeoutMs,
          `MCP server "${server.name}" did not respond within ${discoveryTimeoutMs}ms`,
          async () => {
            const client = await createClientForServer(server);
            clients.push(client);
            return client.tools();
          },
        );
      } catch (err) {
        // Name the offending server so a single broken transport is diagnosable
        // instead of surfacing as an opaque registry failure.
        throw new Error(
          `MCP server "${server.name}" (${server.transport}) failed during discovery: ${errorMessage(err)}`,
          { cause: err },
        );
      }

      normalizeToolSchemas(serverTools);
      for (const toolName of Object.keys(serverTools)) {
        if (Object.hasOwn(allTools, toolName)) {
          throw new Error(
            `MCP tool name conflict: "${toolName}" is exposed by "${server.name}" but already registered by a previously loaded server`,
          );
        }
      }
      Object.assign(allTools, serverTools);
      logger.info(
        { server: server.name, tools: Object.keys(serverTools).length },
        'MCP server ready',
      );
    }
  } catch (err) {
    await closeAll(clients);
    throw err;
  }

  return {
    tools: allTools,
    cleanup: () => closeAll(clients),
  };
}

async function withTimeout<T>(ms: number, message: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createClientForServer(server: McpServerConfig): Promise<MCPClient> {
  if (server.transport === 'stdio') {
    return createMCPClient({
      // Only the configured `env` reaches the child (plus the transport's safe
      // defaults such as PATH/HOME) — never the full process environment, which
      // holds provider API keys. Use `${VAR}` in the config to pass a specific
      // variable through.
      transport: new Experimental_StdioMCPTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: server.env,
        // stderr stays 'inherit' (the default): the transport keeps its child
        // process private, so piping stderr would leave it unread and block
        // the child once the pipe buffer fills. Child diagnostics therefore
        // pass through to fd 2 unstructured.
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
 * This is the seam that prevents oversized raw MCP output from leaking into the
 * next reasoning step.
 */
export function wrapToolsWithSummarization(tools: ToolSet, ctx: ToolSummaryRuntime): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = wrapTool(name, t, ctx);
  }
  return wrapped;
}

type ExecuteFn = (input: unknown, options: unknown) => unknown | Promise<unknown>;

function wrapTool(name: string, t: Tool, ctx: ToolSummaryRuntime): Tool {
  const original = (t as { execute?: ExecuteFn }).execute;
  if (typeof original !== 'function') {
    return t;
  }
  return {
    ...t,
    async execute(input: unknown, options: unknown) {
      const start = Date.now();
      const raw = await original.call(t, input, options);
      const envelope = mcpResultToEnvelope(raw, name, input, Date.now() - start);
      return maybeSummarizeToolOutput(envelope, name, ctx);
    },
    toModelOutput: toolResultToModelOutput,
  } as Tool;
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
