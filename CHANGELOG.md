# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
