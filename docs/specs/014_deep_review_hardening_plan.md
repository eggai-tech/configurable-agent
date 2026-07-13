# 014 — Deep review: complexity reduction, OTel log correlation, PII hardening (plan)

## Process

A workflow of 29 agents ran four phases: (1) research of the installed AI SDK
v7.0.19 API surface from `node_modules/ai/docs` and `.d.ts` (never from
memory), (2) a functional-requirements map over specs 001–013 + README +
user-guide, (3) three review dimensions (correctness/stability/perf,
logging/OTel/PII, complexity/custom-code-vs-builtins), (4) adversarial
verification of every finding ≥ medium. 21 findings confirmed, 3 refuted.
All fixes verified with the full suite (`typecheck`, `test`, `lint`, `build`).

## Complexity reduction (AI SDK built-ins replace custom code)

- **Single-call agent loop** (`src/agent/loop.ts`): the manual per-step
  `for`-loop (one `streamText` per step, `stopWhen: isStepCount(1)`, manual
  message accumulation, manual usage totals, manual last-step
  `toolChoice: 'none'`) is replaced by ONE `streamText` call using
  `stopWhen: stepCountIs(maxSteps)`, `prepareStep` (per-step compaction via the
  documented `messages` override, which carries forward; final-step
  `toolChoice: 'none'`), and `totalUsage`.
- **Native structured output**: the post-loop `generateObject` pass (with its
  injected "format the answer" user message) is replaced by
  `output: Output.object({ schema: jsonSchema(config.output.schema) })` on the
  same call (`generateObject` is deprecated in v7). `structured_output_failed`
  is still emitted when `await stream.output` rejects on schema mismatch.
  Structured-output tokens now count toward `final.usage`.
- **`toModelOutput` as a first-class `tool()` option**, shared via
  `toolResultToModelOutput` in `events.ts`; the spread + `as unknown as Tool`
  bolt-ons in `todowrite.ts`/`mcp.ts` are gone.
- **`gpt-tokenizer` removed** (55 MB): threshold gates use a chars/4 estimate.
- **zod v4 idioms** in `config/schema.ts`: `z.url()`, no `.optional()` before
  `.default()`, `.prefault({})` instead of triple-duplicated literal defaults.
- Verified **keep**: Handlebars (documented template semantics), ajv +
  ajv-formats (startup validation of `output.schema`; no builtin replacement),
  the 4-line glob matcher (no SDK/glob dep available), `util.ts` helpers.

## Bug fixes

- **Compaction never fired in tool loops** (critical): `chooseSplitIndex`
  required a user message inside the recent window; agentic histories have
  none after the first turn, so context grew unbounded. New rule: the recent
  window must merely not START on a `tool` message (protecting assistant
  tool-call ↔ tool-result pairing). The summary is injected as a **user**
  message (was: system) because the window may now start with an assistant
  message and providers (Anthropic) reject assistant-first conversations.
- **Approval resume was broken end-to-end**: serve mode is stateless and the
  paused step's assistant message (tool-call + tool-approval-request parts +
  signature) was discarded, so the documented "same messages + decision"
  resume always failed. New `run_paused` SSE event
  (`{ reason: 'tool_approval', messages }`) hands the client the run's
  response messages to append verbatim. Approve + deny paths covered by
  integration tests through the real SDK.
- **`tailChars: 0`** leaked the entire raw tool output (`slice(-0)`).
- **Abort detection** used `message.includes('abort')`, swallowing real
  failures; it now checks the abort signal.
- **CLI record truncation**: `writeRunRecord` resolves on flush before
  `process.exit`; an approval-paused run writes the spec-004 record
  `error: 'run halted waiting for tool approval (CLI is non-interactive)'`.
- **Serve shutdown** killed in-flight SSE streams; it now drains connections
  and force-closes after `SHUTDOWN_TIMEOUT_MS` (default 10 s), guards against
  re-entrant signals, and exits non-zero on shutdown failure.
- `READINESS_PROBE_TIMEOUT_MS` is validated; already-aborted client signals
  abort immediately; `OTEL_ENABLED=0/false` disables tracing.

## PII / secret hardening

- **SSE error sanitization**: raw `part.error` / `APICallError` (which
  serializes `requestBodyValues` = full prompts + system prompt, response
  body/headers, provider URL) is never emitted. 429 → whitelisted rate-limit
  headers only; other errors → `{ name, statusCode? }`.
- **Log sanitization**: a whitelist `err` serializer (type/message/stack/
  statusCode/cause) replaces pino's default, which logs all enumerable error
  props.
- **Span content control**: AI SDK telemetry records prompts/outputs by
  default — kept (spec 004: eval tooling reads tool details from traces) but
  now opt-out via `OTEL_RECORD_CONTENT=0`, threaded through a shared
  `telemetryOptions()` helper.
- **stdio MCP child env**: children no longer inherit the full process env
  (provider API keys, `TOOL_APPROVAL_SECRET`); they get the configured `env`
  plus the transport's minimal safe defaults (PATH/HOME/…). Explicit
  passthrough via `${VAR}` expansion in the config. *Spec amendment*: spec 008
  said `env` is "merged with process.env at spawn time" — superseded here for
  security; `${VAR}` covers the legitimate uses.

## Observability (OTel log/trace correlation)

- `logger.ts`: pino mixin injects `trace_id`/`span_id`/`trace_flags` of the
  active span; ISO timestamps; level labels; base fields `service.name` /
  `service.version` shared with the trace resource via
  `observability/resource.ts` (single source, `OTEL_SERVICE_NAME`/`_VERSION`
  aware).
- `/invoke` opens a span per request (`configurable-agent.invoke`), parented
  on an incoming `traceparent` header (reusing `parseTraceparent`, moved from
  `cli/stdio.ts` to `observability/tracing.ts`), so serve-mode logs and AI SDK
  gen-ai spans share one trace. The request id rides on the span and an
  `x-request-id` response header.

## Spec clarifications recorded here (gaps found by the review)

1. **Compaction contract** (previously unspecified): trigger =
   `countMessagesTokens > safety.compaction.triggerTokens` using a chars/4
   estimate; the base system prompt is always preserved; earlier turns are
   LLM-summarized into a single `[COMPACTED CONTEXT]` **user** message; the
   most recent `keepRecentMessages` are kept verbatim except the window may
   not start on a `tool` message; summarizer outage degrades to
   drop-with-placeholder; a client abort during summarization aborts the run.
2. **Approval pause/resume contract**: pause emits `tool_approval_requested`
   (per gated call) + `tool_result` with `status: 'approval_required'` + one
   `run_paused` event with the run's response messages; resume = original
   messages + `run_paused.messages` + a `tool` message with
   `tool-approval-response` parts. CLI `run` reports the halt per spec 004.
3. **Error taxonomy** (SSE `error.code`): `rate_limit_tokens`,
   `stream_error`, `max_tokens_reached`, `tool_call_on_final_step`,
   `structured_output_failed`, `agent_failed`, `internal_error`. `details`
   never contains provider request/response bodies.
4. **`final.truncated`**: retained as a constant `false` field (001 requires
   the field; nothing currently produces `true`).
5. Superseded spec text NOT edited in place (002/003/005/006/007/008 stale
   passages); this spec is the amendment record, per the review's
   contradiction list (spec 012/013 style).

## Dependency hygiene

Audited every `src`/`tests` import against `package.json`:

- **dependencies** = exactly the packages statically imported by `src/`
  (AI SDK family, Hono, OpenTelemetry stack, ajv(+formats), commander,
  handlebars, pino, yaml, zod). No phantom imports, no unused entries.
- **Removed dead deps**: `shell-quote` + `@types/shell-quote` (orphaned by the
  spec-008 bash-tool removal) and `msw` (no test imports it) — also dropped
  from the Dockerfile rebuild line and `pnpm-workspace.yaml` allowBuilds.
  Removed `vite` (vitest ships its own compatible vite; it was never imported).
- **devDependencies** = tooling only, each wired to a script: biome (lint),
  typescript (typecheck/build), tsx (dev), vitest (test), `@vitest/coverage-v8`
  (new `test:coverage` script), `@types/node`.
- **optionalDependencies**: deliberately none — every runtime import is
  static/unconditional. All provider SDKs stay required because the provider is
  chosen by config at runtime; making them optional would need dynamic imports
  and error paths for a marginal install-size win on a Docker-deployed service.
- **peerDependencies**: not applicable — this is an app/CLI package; `./lib`
  consumers receive everything transitively.
- `@ai-sdk/provider` stays pinned at the exact `4.0.3` on purpose: it matches
  `ai@7.0.19`'s own exact pin, guaranteeing one deduped instance for
  `APICallError.isInstance` checks.

## Type system & zod alignment

- **Types derive from zod schemas** wherever a schema exists: `AgentConfig`,
  `McpServerConfig`, `InvokeRequest` (already inferred) plus `TodoItem`/
  `TodoStatus`/`TodoWriteInput`, now inferred from the todowrite tool's input
  schema — one source of truth, no parallel interface to drift.
- **The request boundary reuses the AI SDK's `modelMessageSchema`**
  (`z.ZodType<ModelMessage>`): `/invoke` and CLI stdin accept exactly what
  `streamText` accepts (verified against text, multimodal, tool-call/-result,
  approval-request/-response fixtures), the `as ModelMessage[]` casts are
  gone, and malformed messages fail at the boundary with a clear message
  instead of mid-stream. Supersedes the "envelope-only, content: unknown"
  note from spec 012 — the SDK's own schema cannot wrongly reject what the
  SDK itself accepts.
- **Zod error ergonomics**: every config constraint carries a descriptive
  message naming the path and accepted values; validation failures report via
  `z.prettifyError` (humans: CLI stderr, ConfigError message, API `message`)
  and `z.treeifyError` (machines: API `details`), replacing deprecated
  `.format()`.
- **No `any` anywhere; `unknown` only at real boundaries** (thrown errors,
  YAML input, MCP wire results, tool args passed through per spec 003).
  Remaining casts are documented interop seams: ajv-formats CJS default,
  version.ts package.json read, MCP schema normalization, hono ServerType.
- Tests use typed fakes (`ToolSet`-shaped tools, one `asMcpClient()` seam)
  instead of `as never` casts.

## Verification

`corepack pnpm typecheck`, `test` (91 tests, incl. new compaction tool-loop,
tailChars 0, approval approve/deny resume, structured-output loop, and 429
whitelist tests), `lint`, and `build` all pass.

## Second review pass (2026-07)

A follow-up adversarial pass (two agents: installed-SDK API verification and a
bug/stability/PII review) over the already-hardened branch. Confirmed fixes:

- **Approval gate enforcement (high)**: the SDK skips signature verification
  when `toolApprovalSecret` is unset, so on the stateless `/invoke` a client
  could fabricate an `approved: true` history entry and bypass the human gate.
  `serve` now refuses to start when `safety.approval.mode != none` and
  `TOOL_APPROVAL_SECRET` is unset.
- **`/ready` deep probe**: single-flight + `READINESS_PROBE_CACHE_MS` (10 s)
  cache, `maxRetries: 0`, and the provider error text is logged but no longer
  returned to the (unauthenticated) caller.
- **`/invoke` body cap**: hono's built-in `bodyLimit` middleware,
  `MAX_REQUEST_BODY_BYTES` (default 10 MiB), 413 on overflow.
- **MCP discovery timeout**: `@ai-sdk/mcp` has no protocol-level timeout;
  connect + `tools()` are raced against `MCP_DISCOVERY_TIMEOUT_MS` (30 s) so a
  hung server fails startup by name instead of blocking `/health` forever.
- **`model.baseUrl` honored for hosted providers** via
  `createAnthropic`/`createOpenAI`/`createGoogleGenerativeAI` (was silently
  ignored — traffic went to the default endpoint).
- **Strict nested config**: `z.strictObject` throughout, so typo'd keys (e.g.
  `compation`) fail at startup instead of silently using defaults; the
  system-prompt template is rendered once at load (Handlebars parses lazily) so
  syntax errors fail at boot; compiled templates are cached per process.
- **Env expansion escape**: `$${VAR}` yields a literal `${VAR}` so prompt text
  cannot accidentally pull secrets into the model input/traces.
- **Shutdown deadline** covers MCP/OTEL cleanup, not just the HTTP drain; the
  CLI absorbs `console.info`/`console.debug` (not just `log`) stdout writes.
- **New tests**: endpoint suite for `/health`, `/ready` (presence + deep-probe
  non-leak), `/invoke` (invalid JSON, schema error, 413, SSE happy path via a
  `BuildServerOptions.model` override added for testability), plus
  `expandEnvVars` and strict-schema coverage.

From the installed-SDK verification pass (every claim checked against
`ai@7.0.19` dist types/docs):

- **Signature-stripping fix (critical, pairs with the gate enforcement)**: the
  runtime `modelMessageSchema` models tool-approval-request parts as only
  `{type, approvalId, toolCallId}` — parsing a re-POSTed history through it
  drops the HMAC `signature`, so a signed resume always failed with
  `InvalidToolApprovalSignatureError`. `parseInvokeRequest` now validates and
  returns the ORIGINAL messages (the SDK's `standardizePrompt` does the same);
  regression-tested in `tests/request.test.ts`.
- `stream.totalUsage` (deprecated) → `stream.usage`; MCP clients get
  `onUncaughtError` wired to the logger; the readiness probe asks for 16
  output tokens (some reasoning models enforce a minimum and 400 on 1).
- Verified keep-custom (no SDK equivalent): compaction summarizer
  (`prepareStep` messages-override is the documented seam; `pruneMessages`
  only strips, never summarizes), tool-output summarization
  (`toModelOutput` is the only native hook), the approval glob matcher
  (`toolApproval` maps are exact-name only), and
  `normalizeJsonSchemaDraft2020` (no normalization in `@ai-sdk/mcp`).
- `ToolLoopAgent` migration rejected: `ToolLoopAgentSettings` does not accept
  `experimental_toolApprovalSecret` at 7.0.19, so migrating would lose signed
  approvals while the part→SSE loop would remain anyway. Revisit when the
  secret option lands on the agent class.
- `stream.responseMessages`, the approval/denied stream-part handling,
  `Output.object` + `stream.output`, `prepareStep`'s 0-based `stepNumber`,
  and the `telemetry`/`registerTelemetry` wiring were all confirmed correct
  against the dist types. The `finishReason === 'tool-calls'` check is kept
  as a deliberate guard for providers that ignore `toolChoice: 'none'`.

Recorded as known limitations (deliberate non-fixes):
- stdio MCP child stderr stays `'inherit'`: the transport keeps its child
  process private, so piping stderr would leave the pipe unread and block the
  child once the buffer fills. Child diagnostics pass through unstructured.
- A stream error *after* a `tool-approval-request` in the same step ends the
  run without `run_paused`; the client retries from its own history.
- CLI `readAllStdin` is uncapped — stdin is operator-controlled in the
  one-shot mode.
