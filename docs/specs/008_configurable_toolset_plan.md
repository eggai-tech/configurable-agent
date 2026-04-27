# Plan: Configurable Toolset Interface (spec 008)

## Context

The configurable-agent currently bundles all tools (bash, websearch, http, todowrite) directly in
`src/agent/tools/`. The goal is to define an interface so that **tools live in separate
repositories**, wired into the agent purely through the YAML config file — no tool code in this
repo. MCP (Model Context Protocol) is the sole integration mechanism, supporting both local
subprocess tools (stdio) and remote services (HTTP).

Auth/OBO is explicitly **out of scope** for this iteration.

## Agreed Design Decisions

| Decision | Choice |
|---|---|
| Tool delivery | **MCP only** — stdio (spawn per invocation) or HTTP |
| Existing built-ins | **Remove entirely** (bash, websearch, http, todowrite) |
| Config key | `mcpTools:` — flat list of MCP server configs |
| Name conflicts | Fail at startup if two MCP servers expose the same tool name |
| Auth/OBO | Out of scope |

## Config Schema (target)

The `tools:` key is replaced by `mcpTools:` (consistent with the existing camelCase convention:
`systemPrompt`, `keepRecentMessages`, etc.):

```yaml
mcpTools:
  - name: accounts
    transport: stdio
    command: accounts-mcp
    args: []                    # optional
    cwd: /opt/tools             # optional
    env:                        # merged with process.env at spawn time
      ACCOUNTS_URL: http://accounts:8080

  - name: files
    transport: http
    url: https://files.internal/mcp
    headers:                    # optional static headers
      X-Tenant: acme
```

## Architecture

```
buildMcpTools(cfg)
├── for each mcpTools[]:
│     stdio → createMCPClient(StdioTransport { command, args, cwd, env })
│     http  → createMCPClient(HttpTransport { url, headers })
├── list tools from each server
├── fail if any two servers expose the same tool name
└── return { tools: ToolSet, cleanup() }
        │
        ▼
streamText({ model, messages, tools })   ← Vercel AI SDK v5
        │
        ▼
cleanup() → close MCP clients / kill stdio subprocesses
```

## Implementation

### New dependency

```
pnpm add @ai-sdk/mcp
```

### Files changed

| File | Change |
|---|---|
| `src/config/schema.ts` | Replace old `tools:` object with `mcpTools:` flat array |
| `src/agent/loop.ts` | Remove bash approval flow; use `buildMcpTools`; lifecycle cleanup |
| `src/agent/events.ts` | Move `ToolResult` type here; remove bash-only events |
| `src/agent/safety/tool-summary.ts` | Simplify `ToolSummaryRuntime` (remove bash-approval fields) |
| `src/api/request.ts` | Remove `approvals` / `sessionAllowRules` from InvokeRequest |
| `example.config.yaml` | Replace old tool config with `mcpTools:` examples |

### New files

| File | Purpose |
|---|---|
| `src/agent/tools/mcp.ts` | `buildMcpTools()` — creates MCP clients, checks conflicts, returns cleanup |

### Deleted files

| File | Reason |
|---|---|
| `src/agent/tools/bash.ts` | Built-in tool removed |
| `src/agent/tools/bash-policy.ts` | Built-in tool removed |
| `src/agent/tools/websearch.ts` | Built-in tool removed |
| `src/agent/tools/http.ts` | Built-in tool removed |
| `src/agent/tools/todowrite.ts` | Built-in tool removed |
| `src/agent/tools/index.ts` | Replaced by `mcp.ts` |
| `src/agent/tools/result.ts` | Tool wrapping machinery only needed by old built-ins |

### Deployment model

The base image is the configurable-agent. Teams build `FROM` it and add their MCP server
binaries. The config file points to those binaries by command name (on `PATH`).

```dockerfile
FROM eggai/eggai-configurable-agent:latest
COPY --from=accounts-mcp-builder /app/accounts-mcp /usr/local/bin/accounts-mcp
COPY config.yaml /etc/configurable-agent/config.yaml
```
