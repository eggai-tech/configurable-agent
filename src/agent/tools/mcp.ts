import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import type { experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { AgentConfig } from '../../config/schema.js';

type McpTools = Awaited<ReturnType<MCPClient['tools']>>;

export async function buildMcpTools(cfg: AgentConfig): Promise<{
  tools: McpTools;
  cleanup: () => Promise<void>;
}> {
  const clients: MCPClient[] = [];
  const allTools = {} as McpTools;

  for (const server of cfg.mcpTools) {
    const client =
      server.transport === 'stdio'
        ? await createMCPClient({
            transport: new Experimental_StdioMCPTransport({
              command: server.command,
              args: server.args,
              cwd: server.cwd,
              env: { ...process.env, ...server.env } as Record<string, string>,
            }),
          })
        : await createMCPClient({
            transport: {
              type: 'http',
              url: server.url,
              headers: server.headers,
            },
          });

    const serverTools = await client.tools();
    for (const toolName of Object.keys(serverTools)) {
      if (Object.prototype.hasOwnProperty.call(allTools, toolName)) {
        throw new Error(
          `MCP tool name conflict: "${toolName}" is exposed by "${server.name}" but already registered by a previously loaded server`,
        );
      }
    }
    Object.assign(allTools, serverTools);
    clients.push(client);
  }

  return {
    tools: allTools,
    async cleanup() {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
