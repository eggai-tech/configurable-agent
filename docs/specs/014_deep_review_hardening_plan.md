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

## Verification

`corepack pnpm typecheck`, `test` (91 tests, incl. new compaction tool-loop,
tailChars 0, approval approve/deny resume, structured-output loop, and 429
whitelist tests), `lint`, and `build` all pass.
