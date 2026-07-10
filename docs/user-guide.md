# Configurable Agent — User Guide

Everything you need to configure, run, and operate the agent. For a one-minute
introduction and install steps, see the [project README](../README.md).

## Contents

- [Features](#features)
- [Running](#running)
- [Configuration](#configuration)
  - [Model and providers](#model-and-providers)
  - [Prompt templating](#prompt-templating)
  - [Tools](#tools)
  - [Structured output](#structured-output)
  - [Safety](#safety)
- [HTTP API](#http-api)
  - [Endpoints](#endpoints)
  - [Request format](#request-format)
  - [Streaming events (SSE)](#streaming-events-sse)
  - [Resolving a tool approval](#resolving-a-tool-approval)
- [Deployment](#deployment)
- [Observability](#observability)
- [Environment variables](#environment-variables)

## Features

- **One-file configuration** — prompt, model, tools, and safety knobs in YAML.
- **Any major provider** — Anthropic, OpenAI, Google, or any OpenAI-compatible
  endpoint (including local [ollama](https://ollama.com)).
- **External tools via MCP** — connect any Model Context Protocol server over
  stdio or HTTP; the agent discovers and uses its tools.
- **Streaming** — reasoning, text, tool calls, and results stream live over SSE.
- **Structured output** — optionally validate the final answer against a JSON
  Schema.
- **Human-in-the-loop approval** — require a person to approve sensitive tool
  calls before they run.
- **Built-in safety** — automatic conversation compaction and tool-output
  summarization keep long runs within context limits.

## Running

```bash
pnpm install
export ANTHROPIC_API_KEY=...          # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
CONFIG_PATH=./example.config.yaml pnpm dev
```

Send a request and watch the response stream:

```bash
curl -N -X POST http://localhost:3000/invoke \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"search the web for eggai and summarize"}]}'
```

For containers and clusters, see [Deployment](#deployment).

## Configuration

The agent is configured by a single YAML file, loaded once at startup from the
path in `CONFIG_PATH` (default `/etc/configurable-agent/config.yaml`). If the
file is missing or invalid, the process exits immediately with an error.

Any `${VAR}` reference in a string value is replaced with that environment
variable at load time, so secrets (API tokens, header values) stay out of the
file itself.

```yaml
systemPrompt: |
  You are a helpful assistant...

model:
  provider: anthropic           # anthropic | openai | google | ollama | openai-compatible
  name: claude-sonnet-4-6
  temperature: 0.2
  # topP, maxOutputTokens also supported
  # baseUrl: http://host.docker.internal:11434/v1   # for ollama / openai-compatible

agent:
  maxSteps: 10                  # hard cap on the tool-use loop

mcpTools:                       # external MCP servers (optional)
  - name: accounts
    transport: stdio
    command: accounts-mcp
    env:
      ACCOUNTS_URL: http://accounts:8080
  # - name: files
  #   transport: http
  #   url: https://files.internal/mcp
  #   headers:
  #     X-Tenant: acme

safety:
  compaction:                   # summarize old turns when the history grows large
    triggerTokens: 100000
    keepRecentMessages: 6
  toolOutput:                   # summarize oversized tool results
    triggerTokens: 4000
    headChars: 500
    tailChars: 500
  approval:                     # require human approval for tool calls
    mode: none                  # none | all | selected
    tools: []                   # name patterns when mode: selected, e.g. ["delete_*"]

output:
  structured: false
```

### Model and providers

Set `model.provider` to one of `anthropic`, `openai`, `google`, `ollama`, or
`openai-compatible`, and `model.name` to a model the provider offers. Each
hosted provider reads its API key from an environment variable (see
[Environment variables](#environment-variables)).

For `ollama` and `openai-compatible`, point `model.baseUrl` at your endpoint
(these often need no API key). See
[Connecting to a local ollama](#connecting-to-a-local-ollama) for a Kubernetes
tip.

### Prompt templating

`systemPrompt` is a [Handlebars](https://handlebarsjs.com) template. These
variables are always available:

- `{{today}}` — current date (`YYYY-MM-DD`)
- `{{now}}` — current timestamp (ISO 8601)
- `{{cwd}}` — the process working directory

Add your own values under `promptVars` and reference them the same way:

```yaml
systemPrompt: |
  You are the {{team}} assistant. Today is {{today}}.
promptVars:
  team: Platform
```

### Tools

The model can call tools during a run. One tool is always available; the rest
come from the MCP servers you configure.

#### Built-in: `todowrite`

A scratchpad todo list for a single run. The model uses it to break a complex
request into steps and track progress (`pending` → `in_progress` → `completed`).
It holds no data between requests and never requires approval.

#### MCP servers

List any number of [Model Context Protocol](https://modelcontextprotocol.io)
servers under `mcpTools`. Each is connected at startup and its tools are exposed
to the model:

- **stdio** — a local command: `transport: stdio`, with `command`, optional
  `args`, `cwd`, and `env`.
- **http** — a remote server: `transport: http`, with `url` and optional
  `headers`.

All configured servers are validated at startup: if one can't be reached, or two
servers expose the same tool name, the service fails to start rather than serving
with a broken tool set.

### Structured output

By default the agent replies with free text. To require a machine-readable
answer, set `output.structured: true` and provide a JSON Schema. The final
response is validated against it and returned in the `structured` field of the
final event:

```yaml
output:
  structured: true
  schema:
    type: object
    properties:
      answer: { type: string }
      confidence: { type: number, minimum: 0, maximum: 1 }
    required: [answer]
```

### Safety

These features run automatically to keep long or noisy runs reliable.

#### Conversation compaction

When the conversation grows beyond `compaction.triggerTokens`, older turns are
summarized into a compact note while the most recent `keepRecentMessages` are
kept verbatim. Emits `compaction_start` and `compaction_finished` events.

#### Tool-output summarization

When a tool returns more than `toolOutput.triggerTokens` of output, it is
replaced with a short summary plus the first `headChars` and last `tailChars` of
the raw output. The summarized form (marked `truncated: true`) is what the model
sees on the next step, so one huge result can't blow the context budget.

#### Tool approval (human-in-the-loop)

Require a person to approve tool calls before they execute — useful for tools
that modify data, spend money, send messages, or touch anything sensitive.

Configure it under `safety.approval`:

| `mode` | Behavior |
|--------|----------|
| `none` | No tool ever needs approval (default). |
| `all` | Every tool call needs approval (the built-in `todowrite` is exempt). |
| `selected` | Only tools whose name matches a pattern in `tools`. Patterns are glob-style, where `*` is a wildcard — e.g. `delete_*`, `send_email`. |

When a matching tool is called, it is **not** executed. Instead the run pauses
and emits a `tool_approval_requested` event. Your client decides and resumes the
run — see [Resolving a tool approval](#resolving-a-tool-approval).

> **Security:** because `/invoke` is stateless (your client owns the
> conversation history), set `TOOL_APPROVAL_SECRET` to a strong random value
> (e.g. `openssl rand -base64 32`) whenever approval is enabled. The service then
> signs each approval request and rejects any that were forged or tampered with.
> Every instance that serves requests must share the same secret.

## HTTP API

### Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Liveness — returns 200 as soon as the process is up. |
| `/ready` | GET | Readiness — 200 when the config is loaded and the provider key is present. Add `?deep=1` to also make one tiny provider call that verifies the credentials, URL, and model actually work (returns 503 with the error if not). |
| `/invoke` | POST | Run the agent and stream the result over SSE. |

### Request format

```json
{ "messages": [{ "role": "user", "content": "..." }] }
```

`messages` is the conversation so far. Roles are `user`, `assistant`, and `tool`
(the last is used only to return a [tool approval
decision](#resolving-a-tool-approval)). Any `system` message you send is ignored
in favor of the configured `systemPrompt`.

### Streaming events (SSE)

`/invoke` streams the run as it happens. Each event has a named type and a JSON
`data` payload:

| Event | Payload | Meaning |
|-------|---------|---------|
| `reasoning` | `{ text }` | A chunk of the model's reasoning. |
| `content_delta` | `{ text }` | A chunk of the answer text. |
| `tool_call` | `{ id, name, args }` | The model invoked a tool. |
| `tool_result` | `{ id, output }` | A tool finished; `output` is a [result envelope](#tool-result-envelope). |
| `tool_approval_requested` | `{ id, approvalId, name, args, signature? }` | A tool call is waiting for human approval. |
| `compaction_start` / `compaction_finished` | sizes | Conversation compaction ran. |
| `final` | `{ content, structured?, stopReason, steps }` | The run finished; `structured` is present in structured-output mode. |
| `error` | `{ code, message, details? }` | The run ended with an error. |

Parallel tool calls within a single step are supported and stream concurrently.
Closing the connection cancels the run.

The loop is capped at `agent.maxSteps`. On the final step the agent forces a text
answer instead of another tool call; if the model tries to call a tool anyway,
the run ends with an `error` (`code: tool_call_on_final_step`).

#### Tool result envelope

The `output` of every `tool_result` has this shape:

```ts
{
  label: string,           // tool name
  status: 'succeeded' | 'error' | 'denied' | 'approval_required',
  content: string,         // the result (summarized if it was oversized)
  return_code: number | null,
  args: unknown,           // the input the tool was called with
  duration_ms: number,
  truncated?: boolean,     // true when content was summarized
  denied_reason?: 'policy_deny' | 'user_denied' | 'policy_compound',
}
```

### Resolving a tool approval

When approval is enabled and the model calls a gated tool, the run pauses:

1. You receive a `tool_approval_requested` event and the response ends. The tool
   has **not** run.
2. Get a decision from a human, then send a new `/invoke` request with the **same
   messages** plus a `tool` message carrying the decision:

   ```jsonc
   {
     "role": "tool",
     "content": [{
       "type": "tool-approval-response",
       "approvalId": "<from the event>",
       "approved": true,               // false to deny
       "reason": "optional note"
     }]
   }
   ```

   If `TOOL_APPROVAL_SECRET` is set, also echo back the `signature` from the
   event unchanged.
3. On approval, the tool runs and the agent continues. On denial, the model is
   told the call was declined and adapts its answer.

## Deployment

### Docker

```bash
docker build -t eggai-configurable-agent:latest .
docker run --rm \
  -e ANTHROPIC_API_KEY=... \
  -v "$PWD/example.config.yaml:/etc/configurable-agent/config.yaml:ro" \
  -p 3000:3000 \
  eggai-configurable-agent:latest
```

### Kubernetes

Ready-to-apply manifests live in `k8s/`:

- `configmap.yaml` — the agent config, mounted at `/etc/configurable-agent/config.yaml`
- `secret.example.yaml` — template for provider keys
- `deployment.yaml` — hardened pod (non-root, read-only root filesystem, dropped capabilities)
- `service.yaml` — ClusterIP on port 80

```bash
kubectl create namespace configurable-agent
kubectl -n configurable-agent create secret generic configurable-agent-provider-keys \
  --from-literal=ANTHROPIC_API_KEY=...
kubectl -n configurable-agent apply -f k8s/
```

Don't commit real keys — populate the secret with Vault, External Secrets
Operator, or another secret-sync tool. The pod only reads environment variables
and stays agnostic to how they get there.

### Connecting to a local ollama

`k8s/deployment.yaml` maps `host.docker.internal` to the kind network gateway so
a pod can reach an ollama running on your machine. Point the config at it:

```yaml
model:
  provider: ollama
  name: gemma4:31b
  baseUrl: http://host.docker.internal:11434/v1
```

Make sure ollama listens on all interfaces (`OLLAMA_HOST=0.0.0.0`).

## Observability

- **Logs** — structured JSON via [pino](https://getpino.io), written to stderr.
  Set the level with `LOG_LEVEL`.
- **Traces** — OpenTelemetry starts automatically when
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_ENABLED`) is set. HTTP calls and model
  calls are traced; spans export over OTLP.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONFIG_PATH` | `/etc/configurable-agent/config.yaml` | Path to the agent config. |
| `PORT` | `3000` | HTTP port. |
| `LOG_LEVEL` | `info` | Log level (`trace`…`fatal`, or `silent`). |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GOOGLE_GENERATIVE_AI_API_KEY` | — | Provider credentials, per `model.provider`. |
| `OLLAMA_BASE_URL` · `OPENAI_BASE_URL` | provider default | Base URL for `ollama` / `openai-compatible` when `model.baseUrl` is unset. |
| `TOOL_APPROVAL_SECRET` | — | Signs tool-approval requests. Set this whenever approval is enabled. |
| `READINESS_DEEP_PROBE` | `0` | Set to `1` to make `/ready` run the provider probe by default (otherwise opt in with `?deep=1`). |
| `READINESS_PROBE_TIMEOUT_MS` | `5000` | Timeout for the `/ready` provider probe. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` · `OTEL_ENABLED` | — | Enable OpenTelemetry tracing. |
| `OTEL_SERVICE_NAME` · `OTEL_SERVICE_VERSION` | `configurable-agent` / version | Trace resource attributes. |
