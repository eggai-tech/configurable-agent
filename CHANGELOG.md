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

### Changed
- Upgraded the `ai` SDK family to v7 and all other dependencies to their latest
  releases (zod v4, OpenTelemetry v2, TypeScript 7, Biome 2, Vite 8, Vitest 4.1,
  commander 15, pino 10)
- AI SDK telemetry now flows through `@ai-sdk/otel`, registered at startup
- Logs are written to stderr (stdout is reserved for the CLI `run` record)
- README reorganized into a short landing page plus the user guide

### Fixed
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
