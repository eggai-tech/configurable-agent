# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Structured output support for the agentic loop
- Harvest MCP integration example (`examples/harvest/`) with config and auth docs
- Human-in-the-loop tool approval: `safety.approval` (`mode: none | all | selected`
  with glob tool-name patterns). Gated tool calls pause the run via a
  `tool_approval_requested` event and are resolved by the client on the next
  request; optional `TOOL_APPROVAL_SECRET` HMAC-signs approvals
- Active readiness probe: `GET /ready?deep=1` (or `READINESS_DEEP_PROBE=1`) makes
  a minimal provider call to verify credentials, base URL, and model, catching
  failures the env-var presence check cannot
- End-user documentation guide at `docs/user-guide.md`
- `run_paused` SSE event carrying the paused run's messages, so a stateless
  client can faithfully resume after a tool-approval decision
- Log/trace correlation: JSON logs include `trace_id`/`span_id`/`trace_flags`
  of the active span plus `service.name`/`service.version`; each `/invoke`
  request runs in its own span (parented on an incoming `traceparent`) and
  returns an `x-request-id` header
- `OTEL_RECORD_CONTENT=0` strips prompts/tool contents from exported spans
- `SHUTDOWN_TIMEOUT_MS` bounds the graceful-shutdown drain
- `model.baseUrl` now works for the hosted providers too (anthropic, openai,
  google) to route traffic through a gateway or proxy
- `/invoke` request bodies are capped (`MAX_REQUEST_BODY_BYTES`, default 10 MiB)
- MCP connect + discovery is bounded by `MCP_DISCOVERY_TIMEOUT_MS` (default
  30 s) so a hung server can no longer block startup forever
- `$${VAR}` escapes environment expansion in config strings

### Changed
- Upgraded the `ai` SDK family to v7 and all other dependencies to their latest
  releases (zod v4, OpenTelemetry v2, TypeScript 7, Biome 2, Vite 8, Vitest 4.1,
  commander 15, pino 10)
- AI SDK telemetry now flows through `@ai-sdk/otel`, registered at startup
- Logs are written to stderr (stdout is reserved for the CLI `run` record)
- README reorganized into a short landing page plus the user guide
- `serve` refuses to start when tool approval is enabled without
  `TOOL_APPROVAL_SECRET` — unsigned approvals would be forgeable on the
  stateless `/invoke` API
- Config validation is strict everywhere: unknown/typo'd keys in nested
  sections (e.g. safety limits) now fail at startup, and the system-prompt
  template is validated at load time
- `/ready?deep=1` no longer returns provider error text to callers (it is
  logged instead), retries are disabled for the probe, and results are cached
  briefly with single-flight dedup so polling cannot hammer the provider
- The agent loop uses the AI SDK's built-in multi-step execution (`stopWhen` +
  `prepareStep`) in a single `streamText` call; structured output is generated
  natively via `output: Output.object()` instead of a separate `generateObject`
  pass (its tokens now count toward the reported usage)
- Context size is estimated with a chars/4 heuristic; the 55 MB `gpt-tokenizer`
  dependency was removed
- Dependency hygiene: removed unused `shell-quote`, `@types/shell-quote`, and
  `msw`; removed the redundant direct `vite` (vitest provides it); added a
  `test:coverage` script wiring the existing `@vitest/coverage-v8`
- Request validation reuses the AI SDK's `modelMessageSchema`, so `/invoke`
  and CLI stdin accept exactly what the model layer accepts and malformed
  messages fail fast with a readable, field-by-field error (`z.prettifyError`
  / `z.treeifyError`) instead of mid-stream; config validation errors likewise
  name the offending path and the accepted values
- stdio MCP servers receive only their configured `env` (plus a minimal safe
  set such as `PATH`), no longer the full service environment with provider
  API keys — pass specific variables through explicitly with `${VAR}`
- Graceful shutdown: in-flight requests drain (bounded by `SHUTDOWN_TIMEOUT_MS`)
  before the process exits
- The compaction summary is injected as a user message (provider-safe when the
  kept window starts with an assistant message)

### Fixed
- Context compaction now fires for tool-call-heavy histories; previously the
  split point required a user message inside the recent window, so agentic runs
  never compacted and eventually exceeded the provider context limit
- Provider errors are sanitized before reaching SSE clients: no more raw
  request bodies (prompts/system prompt) or provider response bodies/headers;
  the 429 path emits only rate-limit headers. Server logs use a whitelist
  error serializer for the same reason
- `safety.toolOutput.tailChars: 0` no longer leaks the entire raw oversized
  tool output
- The CLI `run` record can no longer be truncated by process exit on a
  backpressured stdout pipe, and an approval-paused run reports an explicit
  "run halted waiting for tool approval" error instead of an empty failure
- Client aborts are detected via the abort signal instead of matching "abort"
  in error messages, which silently swallowed real failures
- A non-numeric `READINESS_PROBE_TIMEOUT_MS` no longer turns every deep
  readiness probe into a 500
- `OTEL_ENABLED=0`/`false` no longer enables tracing
- CLI `--version` now reports the real package version (was hard-coded)
- `serve` handles an invalid config gracefully — it logs and exits instead of
  crashing past the top-level handler and leaking the tracing SDK
- MCP discovery failures now name the offending server
- Tool-output summarization and context compaction degrade gracefully when the
  summarizer is unavailable, instead of failing a successful tool call or
  aborting the whole run
- `/invoke` logs agent errors server-side and no longer cascades when the client
  disconnects mid-stream
- `toModelOutput` and MCP client usage updated for AI SDK v7; MCP tool schemas
  normalized to JSON Schema draft 2020-12
- Signed tool-approval resume no longer fails: the request boundary validated
  messages through the SDK's zod schema and passed the parsed copy on, which
  silently stripped the approval `signature` — validation now passes the
  original messages through, mirroring the SDK's own behavior
- MCP transport-level errors outside a tool call (e.g. a crashed stdio child)
  are now logged instead of being silently swallowed
- The readiness probe requests 16 output tokens instead of 1 — some reasoning
  models enforce a minimum and would report a healthy setup as not ready

## [0.2.1] - 2026-06-15

### Fixed
- fixed npm publish workflow using provenance

## [0.2.0] - 2026-06-15

### Changed
- `model.apiKey` renamed to `model.apiKeyEnvVar` — store the env var name, not the secret value

### Added
- Library entry point (`@eggai/configurable-agent/lib`) exposing `runAgent`, `AgentConfig`, `AgentEvent`, and related types
- `openai-compatible` provider with `baseUrl` and `apiKey` support
- Token usage (`inputTokens`, `outputTokens`) in `final` event
- `diagnoseStep`: exported pure function detecting TPM rate limit exhaustion and max-tokens truncation
- npm publish workflow with provenance (no token required) and changelog enforcement

## [0.1.0] - 2026-06-12

### Added
- Initial release: agentic loop (`runAgent`) built on Vercel AI SDK v5
- Library entry point (`@eggai/configurable-agent/lib`) exposing `runAgent`, `AgentConfig`, `AgentEvent`, and related types
- Providers: Anthropic, OpenAI, Google, OpenAI-compatible (including Ollama)
- Context compaction: LLM-based summarisation triggered at 100k tokens
- Tool output summarisation: results exceeding 4k tokens trimmed inline
- `diagnoseStep`: exported pure function for step-completion error detection (TPM rate limit, max tokens)
- HTTP server mode (`configurable-agent serve`) via Hono
- OpenTelemetry instrumentation on all `streamText` and `generateText` calls
