# Wally

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
export TAVILY_API_KEY=...            # only if websearch tool is enabled
CONFIG_PATH=./example.config.yaml pnpm dev
```

Then:

```bash
curl -N -X POST http://localhost:3000/invoke \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"search the web for eggai and summarize"}]}'
```

## Configuration

Loaded once at startup from `CONFIG_PATH` (default `/etc/wally/config.yaml`).
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

tools:
  bash:
    enabled: true
    timeoutMs: 30000
    maxBufferBytes: 1048576
  websearch:                    # Tavily
    enabled: true
    maxResults: 5

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

## HTTP API

| Route          | Method | Purpose |
| -------------- | ------ | ------- |
| `/health`      | GET    | Liveness — always 200 once the process is up. |
| `/ready`       | GET    | Readiness — 200 when the config is loaded and required provider keys are present. |
| `/invoke`      | POST   | Run the agent and stream events via SSE. |

### Request

```json
{ "messages": [{ "role": "user", "content": "..." }] }
```

Roles: `system` | `user` | `assistant`. Caller-provided `system` messages are
stripped and replaced with the configured `systemPrompt`.

### SSE event taxonomy

```
event: reasoning                data: { text }
event: content_delta            data: { text }
event: tool_call                data: { id, name, args }
event: tool_result              data: { id, output?, error? }
event: tool_result_truncated    data: { id, originalTokens, summaryTokens, strategy }
event: compaction_start         data: { before: { tokens, messages } }
event: compaction_finished      data: { before, after, droppedCount }
event: final                    data: { content, structured?, stopReason, steps, truncated }
event: error                    data: { code, message, details? }
```

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
| **Tool output summarization** | A tool returns output whose token count exceeds `safety.toolOutput.triggerTokens` | Replace with `{ summary, headExcerpt, tailExcerpt, originalTokens, truncated: true }` before appending to history | `tool_result_truncated` |

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
docker build -t wally:latest .
docker run --rm \
  -e ANTHROPIC_API_KEY=... \
  -e TAVILY_API_KEY=... \
  -v "$PWD/example.config.yaml:/etc/wally/config.yaml:ro" \
  -p 3000:3000 \
  wally:latest
```

## Kubernetes

Manifests in `k8s/`:

- `configmap.yaml` — the agent's YAML, mounted at `/etc/wally/config.yaml`
- `secret.example.yaml` — template for provider keys consumed via `envFrom`
- `deployment.yaml` — hardened pod spec (non-root, read-only rootfs, dropped caps)
- `service.yaml` — ClusterIP on port 80

```bash
kubectl create namespace wally
kubectl -n wally create secret generic wally-provider-keys \
  --from-literal=ANTHROPIC_API_KEY=... \
  --from-literal=TAVILY_API_KEY=...
kubectl -n wally apply -f k8s/
```

Real deployments should not commit keys — populate `wally-provider-keys` via
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
