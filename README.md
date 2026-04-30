# Configurable Agent

A configurable LLM agent service. One YAML file defines the agent's system
prompt, model, tools, and safety knobs. It exposes an HTTP endpoint that
streams the agent loop back to clients over Server-Sent Events.

Built to be dropped into Kubernetes — the YAML lives in a `ConfigMap`,
provider API keys live in a `Secret`.

## Stack

Node 22 · TypeScript (ESM) · [Hono](https://hono.dev) · [Vercel AI SDK](https://sdk.vercel.ai/)
· Zod · pino · OpenTelemetry · Biome · Vitest. Package manager: pnpm.

Providers: Anthropic, OpenAI, Google, and any OpenAI-compatible endpoint
(including local [ollama](https://ollama.com)) via `@ai-sdk/openai-compatible`.

## Quick start (local)

```bash
pnpm install
export ANTHROPIC_API_KEY=...         # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
CONFIG_PATH=./example.config.yaml pnpm dev
```

Then:

```bash
curl -N -X POST http://localhost:3000/invoke \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"search the web for eggai and summarize"}]}'
```

## Configuration

Loaded once at startup from `CONFIG_PATH` (default `/etc/configurable-agent/config.yaml`).
The process exits non-zero if the file is invalid.

```yaml
systemPrompt: |
  You are a helpful assistant...

model:
  provider: anthropic           # anthropic | openai | google | ollama
  name: claude-sonnet-4-6
  # baseUrl: http://host.docker.internal:11434/v1   # required for ollama
  temperature: 0.2
  # topP, maxOutputTokens also supported

agent:
  maxSteps: 10                  # hard cap on the tool-use loop

mcpTools:                       # external MCP servers (none bundled — see Built-in tools below)
  - name: accounts
    transport: stdio
    command: accounts-mcp
    args: []
    env:
      ACCOUNTS_URL: http://accounts:8080
  # - name: files
  #   transport: http
  #   url: https://files.internal/mcp
  #   headers:
  #     X-Tenant: acme

safety:
  compaction:                   # before each LLM call
    triggerTokens: 100000
    keepRecentMessages: 6
  toolOutput:                   # after each tool call
    triggerTokens: 4000
    headChars: 500
    tailChars: 500

output:
  structured: false
  # When true, the final SSE event includes a `structured` field validated
  # against the JSON Schema below:
  # structured: true
  # schema:
  #   type: object
  #   properties:
  #     answer: { type: string }
  #     confidence: { type: number }
  #   required: [answer]
```

## Built-in tools

The agent always has access to one built-in tool regardless of `mcpTools` configuration:

| Tool | Purpose |
|------|---------|
| `todowrite` | Maintains an in-memory todo list for the duration of a single run. Each call **replaces** the entire list. Use it to break complex requests into steps and track progress (`pending` → `in_progress` → `completed`). The store is reset between requests. |

All other tools are provided externally via MCP servers configured under `mcpTools`.

## HTTP API

| Route          | Method | Purpose |
| -------------- | ------ | ------- |
| `/health`      | GET    | Liveness — always 200 once the process is up. |
| `/ready`       | GET    | Readiness — 200 when the config is loaded and required provider keys are present. The MCP tool registry is validated at startup, so if discovery or a tool-name conflict fails, the process exits non-zero before this endpoint is ever reachable. |
| `/invoke`      | POST   | Run the agent and stream events via SSE. |

### Request

```json
{ "messages": [{ "role": "user", "content": "..." }] }
```

Roles: `system` | `user` | `assistant`. Caller-provided `system` messages are
stripped and replaced with the configured `systemPrompt`.

### SSE event taxonomy

```
event: reasoning          data: { text }
event: content_delta      data: { text }
event: tool_call          data: { id, name, args }
event: tool_result        data: { id, output: ToolResult }
event: compaction_start   data: { before: { tokens, messages } }
event: compaction_finished data: { before, after, droppedCount }
event: final              data: { content, structured?, stopReason, steps, truncated }
event: error              data: { code, message, details? }
```

The `tool_result.output` payload is a `ToolResult` envelope:

```ts
{
  label: string,
  status: 'succeeded' | 'error' | 'denied' | 'approval_required',
  content: string,         // post-summarization for oversized results
  return_code: number | null,
  args: unknown,
  duration_ms: number,
  truncated?: boolean,     // true when content is the summary + head/tail
}
```

Truncation is signalled in-band via `output.truncated: true`; there is no
separate `tool_result_truncated` event.

Each step is a single LLM call. Parallel tool calls within one step are
supported and emit concurrent `tool_call` / `tool_result` pairs. Closing
the HTTP connection aborts the loop server-side.

### Last-step guarantee

On the final step (`maxSteps`), the agent sends the model `toolChoice: 'none'`,
forcing a natural-language answer. If the model still hallucinates a tool call
anyway, an `error` event with `code: "tool_call_on_final_step"` is emitted and
the stream closes.

## Safety features

| Feature | Trigger | Action | Event(s) |
|---|---|---|---|
| **Conversation compaction** | `countMessagesTokens(messages) > safety.compaction.triggerTokens` | LLM-summarize earlier turns; keep `keepRecentMessages` verbatim | `compaction_start`, `compaction_finished` |
| **Tool output summarization** | A tool returns output whose token count exceeds `safety.toolOutput.triggerTokens` | Replace `output.content` with an LLM summary plus head/tail excerpts and set `output.truncated: true`; the summarized form, not the raw output, is what the next reasoning step sees | `tool_result` (with `output.truncated: true`) |
| **Startup-time MCP validation** | Service start | Connect to every configured MCP server, list tools, and reject duplicate tool names. Initialization failure is fatal — the process exits non-zero before accepting traffic | — |

Token counts use `gpt-tokenizer` (o200k_base). This is an approximation for
Anthropic/Google — it generally over-counts, which is safe for threshold checks.

## Development

```bash
pnpm dev             # tsx watch
pnpm test            # vitest
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome check
pnpm lint:fix        # biome check --write
pnpm build           # tsc -> dist/
pnpm start           # node dist/index.js
```

## Docker

```bash
docker build -t eggai-configurable-agent:latest .
docker run --rm \
  -e ANTHROPIC_API_KEY=... \
  -e TAVILY_API_KEY=... \
  -v "$PWD/example.config.yaml:/etc/configurable-agent/config.yaml:ro" \
  -p 3000:3000 \
  eggai-configurable-agent:latest
```

## Kubernetes

Manifests in `k8s/`:

- `configmap.yaml` — the agent's YAML, mounted at `/etc/configurable-agent/config.yaml`
- `secret.example.yaml` — template for provider keys consumed via `envFrom`
- `deployment.yaml` — hardened pod spec (non-root, read-only rootfs, dropped caps)
- `service.yaml` — ClusterIP on port 80

```bash
kubectl create namespace configurable-agent
kubectl -n configurable-agent create secret generic configurable-agent-provider-keys \
  --from-literal=ANTHROPIC_API_KEY=... \
  --from-literal=TAVILY_API_KEY=...
kubectl -n configurable-agent apply -f k8s/
```

Real deployments should not commit keys — populate `configurable-agent-provider-keys` via
Vault Secrets Operator, External Secrets Operator, Vault Agent Injector, or
another secret-sync mechanism. The pod stays Vault-agnostic and only reads
env vars.

### Local ollama from a kind pod

`k8s/deployment.yaml` includes a `hostAliases` entry mapping
`host.docker.internal → 172.23.0.1` (the kind network gateway on Linux), so
a pod can reach an ollama running on the developer's laptop. Point the
config at it:

```yaml
model:
  provider: ollama
  name: gemma4:31b
  baseUrl: http://host.docker.internal:11434/v1
```

Ensure ollama is listening on `0.0.0.0:11434` (e.g. via `OLLAMA_HOST=0.0.0.0`).

## Observability

- **Logs**: pino to stdout. `LOG_LEVEL` env var controls verbosity.
- **Traces**: OpenTelemetry SDK auto-starts when `OTEL_EXPORTER_OTLP_ENDPOINT`
  (or `OTEL_ENABLED`) is set. HTTP and fetch are auto-instrumented.

## Repository rules

See `CLAUDE.md`.
