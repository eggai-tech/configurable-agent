# 004 — Configurable Agent CLI: instructions

> **Revision note (2026-04-19):** The original contract below listed `toolCalls` and `steps` on the stdout record. A follow-up decision reduced the record to `{ ok, finalText, error }` — Mo treats configurable-agent as a black box, so per-tool visibility lives in OTEL spans, not stdout. See `004_configurable_agent_cli_plan.md` for the final design.

## Task

Add a CLI to configurable-agent. Today it's an HTTP server (`POST /invoke` with SSE streaming). A new sibling component, Mo, runs evals against a configurable-agent config by spawning configurable-agent as a subprocess. For this to work, configurable-agent needs a CLI that accepts a conversation on stdin and emits a structured run record on stdout.

## Rules

- pnpm only; never hand-edit `package.json` to add deps. Use `pnpm add <pkg>`.
- Biome + Vitest + TypeScript + ESM. Match the existing style.
- No pop-culture naming references in committed files.

## Reuse, don't reinvent

Configurable Agent's agent loop already exists — wrap it behind a CLI. Do not duplicate it.

- Agent loop: `configurable-agent/src/agent/loop.ts`
- HTTP entrypoint that uses the loop today: `configurable-agent/src/api/server.ts`. The CLI should call the same building blocks.
- Config loader: `configurable-agent/src/config/load.ts` + `configurable-agent/src/config/schema.ts`. The schema already has an optional `evals` field — leave it alone.
- OTEL setup: `configurable-agent/src/observability/tracing.ts`. Already reads `OTEL_EXPORTER_OTLP_ENDPOINT`. The CLI must also honor `TRACEPARENT` as the parent span context.
- Tests: `configurable-agent/tests/*.test.ts` — Vitest with `MockLanguageModelV2`. Match this style.

## Contract

Invocation:

```
configurable-agent run --config <path-to-configurable-agent-config.yaml>
```

The binary name is `configurable-agent`. Add a `bin` entry in `configurable-agent/package.json`. The HTTP server must remain intact — keep it behind `configurable-agent serve`.

**Input (stdin):** single JSON object, no streaming:

```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "system", "content": "..." }
  ]
}
```

**Output (stdout):** a single JSON object on the last line of stdout. NDJSON progress events may be emitted on earlier lines, but the last line must be a valid JSON object matching:

```ts
{
  ok: boolean,           // true if the agent loop completed normally
  finalText: string,     // the assistant's final textual response
  toolCalls: Array<{     // tool calls made during the run
    name: string,
    input?: unknown,
    output?: unknown,
  }>,
  steps: number,         // number of agent-loop iterations
  error: string | null   // error message if ok=false, else null
}
```

Diagnostic logs go to stderr, not stdout. Mo parses the last stdout line as JSON.

**Env vars:**
- `TRACEPARENT` — W3C trace context (`00-<32-hex>-<16-hex>-<2-hex>`). If set, all OTEL spans the run emits must be children of this context.
- `OTEL_EXPORTER_OTLP_ENDPOINT` — where to send spans. Already supported by configurable-agent.

**Exit code:** `0` when the agent loop ran to completion (regardless of whether the output is "correct"). Non-zero when the process failed to run — crash, config error, unhandled exception. Mo treats exit≠0 as "the agent couldn't even run," which is different from "it ran but gave a bad answer."

## Reference

`mo/tests/configurable-agent-runner.test.ts` contains shell-based fakes of this contract — they show the exact stdout shape Mo expects.

## Out of scope

- Anything in `/mo` or `/gaia`.
- Changes to the HTTP interface's behavior beyond what's needed for the CLI dispatcher.
- Langfuse SDK integration in configurable-agent. Configurable Agent only emits OTEL; Mo is responsible for Langfuse.
- EggAI SDK / message-bus integration.

## Verify

- `pnpm typecheck` and `pnpm lint` clean.
- `pnpm test` — new Vitest coverage for the CLI `run` command: stdin parsing, stdout shape, exit codes, env-var handling. Use `MockLanguageModelV2`.
- Manual E2E: `echo '{"messages":[{"role":"user","content":"hi"}]}' | node dist/index.js run --config example.config.yaml`. Last line of stdout parses as the contract.
- HTTP server still works: `pnpm dev` / `pnpm start` boots and responds on `/invoke`.

## Decisions (confirmed with user)

- Bare `configurable-agent` prints usage and exits `2`. Explicit subcommand required. Dockerfile `CMD` updated to `["node", "dist/index.js", "serve"]`.
- `toolCalls[].output` is the tool envelope's **content string**, not the full envelope. Minimal per contract.
