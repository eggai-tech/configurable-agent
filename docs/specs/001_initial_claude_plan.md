# Configurable Agent — configurable agentic service

## Context

The repo currently holds only `instructions.md`. We're building a greenfield Node.js/TypeScript service that runs a configurable LLM agent loop and exposes it over HTTP+SSE, intended to be deployed on Kubernetes with its behavior driven by a YAML `ConfigMap`. One deployment = one agent configuration. Provider API keys come from env vars populated by the ops layer (Vault Agent Injector, Vault Secrets Operator, or plain K8s Secrets); the app itself stays Vault-agnostic.

## Stack

- **Runtime**: Node.js 22 LTS, TypeScript (ESM), `tsx` for dev, `tsc` for build.
- **Package manager**: pnpm.
- **HTTP**: [Hono](https://hono.dev) with its `streamSSE` helper.
- **LLM**: Vercel AI SDK (`ai` + `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`).
- **Validation**: `zod` for request body and config; `json-schema-to-zod` to convert YAML‑inline JSON Schema into Zod for structured output.
- **YAML**: `yaml`.
- **Search**: Tavily REST (`@tavily/core` or plain `fetch`).
- **Observability**: `pino` logs; `@opentelemetry/sdk-node` + auto HTTP instrumentation + manual spans.
- **Tooling**: Biome (lint+format), Vitest (unit/integration).

## Configuration (YAML)

Loaded once at startup from `CONFIG_PATH` (default `/etc/configurable-agent/config.yaml`). Mounted from a `ConfigMap`. Parsed with `yaml` and validated with Zod. If invalid, the process exits non‑zero before the server binds.

```yaml
systemPrompt: |
  You are a helpful assistant...
model:
  provider: anthropic          # anthropic | openai | google
  name: claude-sonnet-4-6
  temperature: 0.2
agent:
  maxSteps: 10                 # default 10
tools:
  bash:
    enabled: true
    timeoutMs: 30000
  websearch:
    enabled: true
output:
  structured: false
  # when structured: true
  # schema: <JSON Schema object>
```

## HTTP API

- `GET /health` — liveness.
- `GET /ready` — readiness (config loaded; required provider env var present).
- `POST /invoke` — SSE stream.

Request body (Zod‑validated):

```json
{ "messages": [{ "role": "user", "content": "..." }] }
```

Roles: `user` | `assistant` | `system` | `tool`. If the caller omits a `system` message, the configured `systemPrompt` is prepended; if they send their own, they are removed, and the configured prompt is prepended (config wins as the outer frame).

No auth: endpoint relies on network policy.

### SSE event taxonomy

```
event: reasoning       data: { text }
event: tool_call       data: { id, name, args }
event: tool_result     data: { id, output?, error? }
event: content_delta   data: { text }
event: final           data: { content, structured?, stopReason, steps, truncated? }
event: error           data: { code, message, details? }
```

Parallel tool calls within a step are supported and emit multiple `tool_call` / `tool_result` pairs concurrently. Client disconnect aborts the loop via `AbortController` wired through the AI SDK and every in‑flight tool call.

## Agent loop

Implemented on top of `streamText` from the AI SDK:

- `stopWhen: stepCountIs(maxSteps)` caps the total steps.
- `prepareStep({ stepNumber }) => stepNumber === maxSteps - 1 ? { toolChoice: 'none' } : {}` — on the **final** step we send the model no tool choice, forcing a natural‑language answer. The caller never chooses this number; it's purely from config.
- After each step we inspect the step's parts; if the **final** step still contains a `tool-call` part (model hallucinated despite `toolChoice: 'none'`), emit an `error` event with `code: tool_call_on_final_step` and the offending call(s) in `details`, then close the stream.
- Otherwise the natural‑language answer of the final step is the final answer.

Structured output: when `output.structured` is true, after the streaming loop ends normally we run one additional `generateObject` call on the accumulated conversation with the Zod schema derived from config, and put its object into the `final` event's `structured` field. Streaming `content_delta` still happens during the loop; `generateObject` is a one‑shot coercion at the end. If that call fails to produce a valid object, emit an `error` event.

## Tools

- **`bash`** — parameters: `{ command: string }`. Runs `child_process.execFile('/bin/sh', ['-c', command], { timeout, maxBuffer, signal })`. Returns `{ stdout, stderr, exitCode }`. Unrestricted within the pod — the pod is the security boundary.
- **`websearch`** — parameters: `{ query: string, maxResults?: number }`. Calls Tavily's `/search` endpoint, returns `{ results: [{ title, url, snippet }], answer? }`.

Both are defined as AI SDK `tool()` values with Zod parameter schemas. Disabled tools are simply not registered.

## Reasoning events

For providers that expose reasoning/thinking deltas (Anthropic extended thinking, OpenAI reasoning models), the AI SDK surfaces them as `reasoning` parts in `fullStream`. We forward them as `reasoning` SSE events.

## File layout

```
src/
  index.ts                       # entrypoint: init tracing, load config, start server
  config/
    schema.ts                    # Zod schema for the YAML config
    load.ts                      # read file, parse yaml, validate, build Zod schema from JSON Schema
  api/
    server.ts                    # Hono app + route wiring
    sse.ts                       # typed SSE event writer
    request.ts                   # request-body Zod schema
  agent/
    loop.ts                      # streamText orchestration (prepareStep, stopWhen, final-step guard)
    model.ts                     # provider → AI SDK model factory
    tools/
      bash.ts
      websearch.ts
      index.ts                   # registry, gated by config
  observability/
    logger.ts                    # pino
    tracing.ts                   # OTel SDK init
k8s/
  configmap.yaml                 # example agent YAML mounted at /etc/configurable-agent/config.yaml
  deployment.yaml                # pod spec; envFrom: secretRef for provider keys
  service.yaml
  secret.example.yaml            # template only; real secrets come from Vault/VSO
Dockerfile                       # multi-stage: pnpm fetch → build → slim runtime
biome.json
tsconfig.json
package.json
pnpm-lock.yaml
example.config.yaml
tests/
  config.test.ts
  loop.test.ts                   # mocked model; asserts final-step-no-tools + hallucination error
  sse.test.ts
```

## Critical files to create

- `src/config/schema.ts`, `src/config/load.ts` — the YAML → runtime-validated config pipeline.
- `src/agent/loop.ts` — the heart: `prepareStep` gating + final-step hallucination guard + event translation.
- `src/api/server.ts` + `src/api/sse.ts` — route + SSE framing.
- `src/agent/tools/*.ts` — bash + websearch.
- `k8s/*` + `Dockerfile` — makes the "deployable to K8s" requirement concrete.

## Verification

1. **Static**: `pnpm biome check .` and `pnpm tsc --noEmit` pass.
2. **Unit tests** (`pnpm test`):
   - Config loader rejects invalid YAML and invalid JSON Schemas; accepts the example.
   - Agent loop: with `maxSteps: 3`, a mocked model that always tool-calls produces exactly 2 tool-using steps plus a final step with no `tool_call` events; if the mocked model still emits a tool call on step 3, an `error` event is produced.
   - SSE writer emits correct `event:` / `data:` framing and ordering.
3. **Integration**: run `pnpm dev`, then
   ```
   curl -N -X POST localhost:3000/invoke \
     -H 'content-type: application/json' \
     -d '{"messages":[{"role":"user","content":"search for eggai and summarize"}]}'
   ```
   and confirm the event sequence (`reasoning*`, `tool_call`, `tool_result`, `content_delta*`, `final`). Also confirm aborting the curl aborts the loop server-side.
4. **Structured output**: toggle `output.structured: true` with a schema in `example.config.yaml`; confirm `final.structured` validates against the schema.
5. **Container**: `docker build -t eggai-configurable-agent .` then `docker run -e ANTHROPIC_API_KEY=… -e TAVILY_API_KEY=… -v $PWD/example.config.yaml:/etc/configurable-agent/config.yaml -p 3000:3000 eggai-configurable-agent` and repeat the curl.
6. **Kubernetes** (kind/minikube): `kubectl apply -f k8s/`, wait for ready, port-forward, curl, confirm logs/traces.
