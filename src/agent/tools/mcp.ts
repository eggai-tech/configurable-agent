import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import type { experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { Tool, ToolSet } from 'ai';
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
      type: server.transport,
      url: server.url,
      headers: server.headers,
    },
  });
}

async function closeAll(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
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
    toModelOutput(output: unknown) {
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
