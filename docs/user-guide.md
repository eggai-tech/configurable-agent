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
  - [ACS Guardian](#acs-guardian)
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
- **Streaming** — progress and answers are delivered over SSE; ACS mode releases
  checked tool events and buffers the answer until approved.
- **Structured output** — optionally validate the final answer against a JSON
  Schema.
- **Human-in-the-loop approval** — require a person to approve sensitive tool
  calls before they run.
- **External ACS Guardian** — enforce remote decisions with signed ACS v0.1
  checks for inputs, tools, responses, and compaction.
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
file itself. To keep a literal `${VAR}` in the text (e.g. a shell example in
the prompt), escape it as `$${VAR}`. Unknown keys anywhere in the file are
rejected, so a typo'd setting fails at startup instead of silently using a
default.

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
    triggerTokens: 100000       # provider-reported tokens, not an estimate
    keepRecentMessages: 6
  toolOutput:                   # summarize oversized tool results
    triggerChars: 16000
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

`model.baseUrl` works for every provider: for `ollama` and `openai-compatible`
it points at your endpoint (these often need no API key); for the hosted
providers it routes traffic through a gateway or proxy instead of the default
API endpoint. See
[Connecting to a local ollama](#connecting-to-a-local-ollama) for a Kubernetes
tip.

### Prompt templating

`systemPrompt` is a [Handlebars](https://handlebarsjs.com) template with the
following values:

| Template expression | Source |
|---------------------|--------|
| `{{config.team}}` | `promptVars.team` in the YAML config. |
| `{{request.weather}}` | `context.weather` in the request body. |
| `{{today}}` | Current date (`YYYY-MM-DD`). |
| `{{now}}` | Current timestamp (ISO 8601). |
| `{{cwd}}` | The process working directory. |

For example, configure a prompt and its variables in YAML:

```yaml
systemPrompt: |
  You are the {{config.team}} assistant. The weather is {{request.weather}}.
promptVars:
  team: foobar
```

Send the request context alongside the conversation:

```json
{
  "messages": [{ "role": "user", "content": "Help me plan the day." }],
  "context": { "weather": "sunny" }
}
```

The rendered system prompt is:

```text
You are the foobar assistant. The weather is sunny.
```

`config` contains the YAML `promptVars`; `request` contains the input `context`.
Both support nested data, such as `{{config.team.name}}` or
`{{request.tenant.name}}`. Omitting either object supplies an empty namespace.
The built-in date, timestamp, and working directory are always available.
Request context applies to one invocation; resend it on follow-up requests and
tool approval resumes. HTTP `/invoke` and CLI stdin accept the same input.

Templates render in strict Handlebars mode: referencing a missing variable,
including a missing context field, fails before the model is called. Over HTTP,
the response has HTTP status 200 and is an SSE stream with an `error` event whose
code is `invalid_prompt_context`, and no `final` event. The CLI returns a run record with
`ok: false` and an error message. Use a conditional for optional data, for example
`{{#if request.locale}}{{request.locale}}{{else}}en{{/if}}`.
Template syntax is checked at startup; variable availability is checked when
each request is rendered.

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
  `args`, `cwd`, and `env`. The child process receives only the configured
  `env` plus a minimal safe set (`PATH`, `HOME`, …) — never the service's full
  environment, which holds provider API keys. To pass a specific variable
  through, reference it explicitly, e.g. `MY_TOKEN: ${MY_TOKEN}`.
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

When the provider reports that a step's input exceeded `compaction.triggerTokens`,
older turns are summarized into a compact note while the most recent
`keepRecentMessages` are kept verbatim. The trigger compares the **real token
usage from the provider's response** — there is no local token estimation.
Because usage arrives with each response, compaction never fires before the
first step, and it stays off if a provider does not report usage. Emits
`compaction_start` and `compaction_finished` events with exact sizes
(`messages`, `chars`).

#### Tool-output summarization

When a tool returns more than `toolOutput.triggerChars` characters of output,
it is replaced with a short summary plus the first `headChars` and last
`tailChars` of the raw output. The summarized form (marked `truncated: true`)
is what the model sees on the next step, so one huge result can't blow the
context budget.

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
> conversation history), an unsigned approval could be forged by any client.
> The server therefore **refuses to start** when approval is enabled and
> `TOOL_APPROVAL_SECRET` is not set. Use a strong random value (e.g.
> `openssl rand -base64 32`); the service signs each approval request and
> rejects any that were forged or tampered with. Every instance that serves
> requests must share the same secret.

### ACS Guardian

Set an optional `acs` block to enforce decisions from an external ACS Guardian:

```yaml
acs:
  guardianUrl: https://guardian.example.com/acs
  agentId: configurable-agent
  keyId: agent-key
  secretEnv: ACS_SHARED_SECRET
  timeoutMs: 10000
```

The Guardian owns policy; the agent applies `allow`, validated `modify`, and
`deny`. Both `ask` and `defer` immediately count as `deny`. Tool denials let the
model try another permitted approach, while other denials and Guardian failures
end the invocation. Set `safety.approval.mode: none` when ACS is enabled.

The request remains `{ messages, context? }`. Each invocation has its own session,
whose ID equals `x-request-id` for HTTP. ACS mode buffers answer text until it is
checked, suppresses raw reasoning, and emits `acs_decision` audit metadata.
Read the [ACS guide](acs.md) for configuration, signing vectors, payload mapping,
compaction conventions, and the supported subset of ACS v0.1.

## HTTP API

### Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Liveness — returns 200 as soon as the process is up. |
| `/ready` | GET | Readiness — 200 when the config is loaded and the provider key is present. Add `?deep=1` to also make one tiny provider call that verifies the credentials, URL, and model actually work (503 on failure; the provider error appears in the server logs, not the response). Probe results are cached briefly, so frequent polling can't hammer the provider. |
| `/invoke` | POST | Run the agent and stream the result over SSE. Bodies larger than the configured limit are rejected with 413. |

### Request format

```json
{
  "messages": [{ "role": "user", "content": "Help me plan the day." }],
  "context": { "weather": "sunny" }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `messages` | Yes | Nonempty array containing the conversation so far. |
| `context` | No | Object exposed as `request` in the [system prompt template](#prompt-templating). |

Omitting `context` supplies an empty `request` namespace. Unknown top-level
fields and non-object context values, including `null`, are rejected with HTTP 400.

`messages` is the conversation so far. Roles are `user`, `assistant`, and `tool`
(the last is used only to return a [tool approval
decision](#resolving-a-tool-approval)). Any `system` message you send is ignored
in favor of the configured `systemPrompt`.

### Streaming events (SSE)

`/invoke` streams the run as it happens. Each event has a named type and a JSON
`data` payload:

| Event | Payload | Meaning |
|-------|---------|---------|
| `acs_decision` | `{ sessionId, requestId, method, decision, effectiveDecision, chainHash }` | ACS enforcement metadata, when enabled. |
| `reasoning` | `{ text }` | A chunk of the model's reasoning. |
| `content_delta` | `{ text }` | A chunk of the answer text. |
| `tool_call` | `{ id, name, args }` | The model invoked a tool. |
| `tool_result` | `{ id, output }` | A tool finished; `output` is a [result envelope](#tool-result-envelope). |
| `tool_approval_requested` | `{ id, approvalId, name, args, signature? }` | A tool call is waiting for human approval. |
| `run_paused` | `{ reason, messages }` | The run paused (e.g. for approval); `messages` are appended to the history when resuming. |
| `compaction_start` / `compaction_finished` | sizes | Conversation compaction ran. |
| `final` | `{ content, structured?, stopReason, steps, usage }` | The run finished; `structured` is present in structured-output mode, `usage` carries `inputTokens`/`outputTokens`. |
| `error` | `{ code, message, details? }` | The run ended with an error. |

Parallel tool calls within a single step are supported and stream concurrently.
Closing the connection cancels the run. In ACS mode, tool events follow Guardian
checks, `reasoning` is suppressed, and text mode emits one approved
`content_delta` before `final`. Guardian failures never release unreviewed content.

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
  // ACS uses 'policy_deny'; local human approval uses 'user_denied'
  denied_reason?: 'policy_deny' | 'user_denied' | 'policy_compound',
}
```

### Resolving a tool approval

When approval is enabled and the model calls a gated tool, the run pauses:

1. You receive a `tool_approval_requested` event, then a `run_paused` event
   whose `messages` array contains everything the agent produced so far this
   run (including the assistant message that carries the approval request),
   and the response ends. The tool has **not** run.
2. Get a decision from a human, then send a new `/invoke` request with the
   **same messages**, followed by the `messages` from the `run_paused` event
   verbatim, followed by a `tool` message carrying the decision. Include the
   original `context` again if one was supplied:

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

ACS mode disables AI SDK telemetry to prevent raw content and exception messages
from leaving before review. Invocation spans and ACS decision logs remain
available. See [ACS events and telemetry](acs.md#client-events-and-telemetry).

- **Logs** — structured JSON via [pino](https://getpino.io), written to stderr.
  Set the level with `LOG_LEVEL`. Every line carries `service.name` /
  `service.version` and, when a trace is active, the OpenTelemetry correlation
  fields `trace_id`, `span_id`, and `trace_flags` — so logs can be joined with
  traces in your backend.
- **Traces** — OpenTelemetry starts automatically when
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_ENABLED`) is set. Each `/invoke`
  request gets its own span (parented on an incoming `traceparent` header, and
  echoed as an `x-request-id` response header), with the model-call spans
  nested inside. Model spans record prompts, tool arguments, and outputs by
  default so eval tooling can inspect runs; set `OTEL_RECORD_CONTENT=0` to
  export metadata (model, token usage, latency) only.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONFIG_PATH` | `/etc/configurable-agent/config.yaml` | Path to the agent config. |
| `PORT` | `3000` | HTTP port. |
| `LOG_LEVEL` | `info` | Log level (`trace`…`fatal`, or `silent`). |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GOOGLE_GENERATIVE_AI_API_KEY` | — | Provider credentials, per `model.provider`. |
| `OLLAMA_BASE_URL` · `OPENAI_BASE_URL` | provider default | Base URL for `ollama` / `openai-compatible` when `model.baseUrl` is unset. |
| `TOOL_APPROVAL_SECRET` | — | Signs tool-approval requests. Required (server refuses to start without it) whenever approval is enabled. |
| `MAX_REQUEST_BODY_BYTES` | `10485760` (10 MiB) | Maximum `/invoke` request body size; larger bodies get 413. |
| `MCP_DISCOVERY_TIMEOUT_MS` | `30000` | Per-server timeout for MCP connect + tool discovery at startup. |
| `READINESS_DEEP_PROBE` | `0` | Set to `1` to make `/ready` run the provider probe by default (otherwise opt in with `?deep=1`). |
| `READINESS_PROBE_TIMEOUT_MS` | `5000` | Timeout for the `/ready` provider probe. |
| `READINESS_PROBE_CACHE_MS` | `10000` | How long a `/ready` deep-probe result is cached before the provider is called again. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` · `OTEL_ENABLED` | — | Enable OpenTelemetry tracing (`OTEL_ENABLED=0`/`false` count as off). |
| `OTEL_SERVICE_NAME` · `OTEL_SERVICE_VERSION` | `configurable-agent` / version | Service identity, shared by traces and log lines. |
| `OTEL_RECORD_CONTENT` | `1` | Set to `0` to strip prompts/tool contents from exported spans (metadata only). |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | How long a shutdown waits for in-flight requests before force-closing connections. |
