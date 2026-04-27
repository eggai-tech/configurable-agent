# 004 — Wally CLI: plan

## Context

Wally runs only as an HTTP server (`POST /invoke` with SSE in `src/api/server.ts`). Mo will spawn wally as a subprocess during eval runs, using a CLI `wally run --config <path>` that reads a conversation JSON from stdin and emits a single structured run record as the last stdout line (see `mo/tests/wally-runner.test.ts` for the consumer contract). Mo also forwards `TRACEPARENT` and `OTEL_EXPORTER_OTLP_ENDPOINT` so its spans can re-parent Langfuse traces.

The agent machinery (loop, tools, config, tracing) is intact. This change is purely an adapter around `runAgent()` — no duplication of the loop.

## Scope

- **In:** `src/index.ts`, new `src/modes/*` and `src/cli/*`, CLI tests, `bin` entry in `package.json`, Dockerfile CMD.
- **Out:** `mo/`, `gaia/`, Langfuse SDK, the agent loop, tools, config schema, HTTP interface behavior.

## Design

### Subcommand layout

- `wally serve` → existing HTTP server.
- `wally run --config <path>` → new CLI mode.
- Bare `wally` or any unknown token → usage to stderr, exit 2.

`Dockerfile` `CMD` changes from `["node", "dist/index.js"]` to `["node", "dist/index.js", "serve"]`. k8s manifests inherit image `CMD`, so no manifest edit is needed.

Hand-rolled argv parsing — no new dep.

### File layout

- `src/index.ts` — dispatcher only. Shebang `#!/usr/bin/env node`.
- `src/modes/serve.ts` — extracted current `index.ts` body (start tracing, load config, buildServer, listen, signals, shutdown). No behavior change.
- `src/modes/run.ts` — new CLI run mode.
- `src/cli/stdio.ts` — helpers: `readAllStdin`, `parseTraceparent`, final-record writer.

### Run mode (`modes/run.ts`)

Exported for tests:

```ts
export async function runCli(opts: {
  argv: string[];
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  modelOverride?: LanguageModel;
}): Promise<number>;
```

Steps:

1. Parse `--config <path>`. Missing → stderr + exit 2.
2. `startTracing()` (existing behavior: only if `OTEL_EXPORTER_OTLP_ENDPOINT` set).
3. Read stdin to buffer. Parse JSON. Validate with `InvokeRequestSchema` (`src/api/request.ts`).
4. `loadConfig(configPath)` from `src/config/load.ts`.
   — failures in 1–4 → exit 2 with stderr message.
5. If `env.TRACEPARENT` matches `00-<32hex>-<16hex>-<2hex>`, build a remote `SpanContext` and establish it via `trace.setSpanContext(context.active(), parent)`. Wrap the agent call in `tracer.startActiveSpan('wally.run', ...)` inside `context.with(parentCtx, ...)`. All child spans nest under this root, which nests under Mo's span via the TRACEPARENT link.
6. Collector emit:
   - `final` → capture `content` → `finalText`.
   - `error` → capture first `message`.
   - `tool_approval_requested` → set a flag so an approval halt without `final` surfaces as a structured `error`.
   - All other events: ignored. Wally is a black box to Mo — per-tool details are visible via OTEL, not stdout.
7. `runAgent(config, messages, emit, undefined, { approvals, sessionAllowRules, model: modelOverride })`.
8. Build the record:
   ```ts
   {
     ok: finalSeen && !errorSeen,
     finalText: finalText ?? '',
     error: errorMsg ?? null,
   }
   ```
   If `tool_approval_requested` halted without `final`, set `ok:false`, `error:'run halted waiting for tool approval (CLI is non-interactive)'`. Matches the autonomous-mode feedback memory: agents running unattended need a structured rejection, not a silent hang.
9. Write the single JSON line (plus `\n`) to stdout.
10. `shutdownTracing()` inside a try/catch — OTEL flush is best-effort and must never turn a successful run into exit 2.
11. Exit `0` when 5–10 completed (even `ok:false`). `2` for 1–4 failures or unhandled exceptions.

### Exit code semantics

- `0` — the agent loop ran. `ok:false` is still exit 0.
- `2` — CLI couldn't run: bad `--config`, bad stdin JSON, unreadable/invalid config, unhandled crash.

Mo's runner treats non-zero as "couldn't run," which is the split we want.

### stdout cleanliness

- `logger` (pino, stdout by default) is only used in `index.ts` + `api/server.ts`. Neither is on the run-mode path — no logger change needed.
- Defensive: in run mode, reassign `console.log = console.error` to absorb stray third-party `console.log` calls.
- Only the final-record writer touches stdout. A test case asserts exactly one JSON line on stdout as a regression guard.

### `bin` and build

- Add to `package.json`: `"bin": { "wally": "dist/index.js" }`.
- Add `#!/usr/bin/env node` shebang to `src/index.ts`. TypeScript preserves it.
- `build` script becomes `tsc -p tsconfig.build.json && chmod +x dist/index.js`.

### Reuse

- `InvokeRequestSchema` — stdin validation.
- `loadConfig()` — YAML config.
- `runAgent()` — the loop.
- `AgentEvent` — drives collector.
- `startTracing` / `shutdownTracing` — unchanged. TRACEPARENT is layered on via `@opentelemetry/api` (already a dep).
- `MockLanguageModelV2`, `toolCallStream`, `textStream` patterns from `tests/approval-e2e.test.ts`.

## Files

**Modify:**

- `src/index.ts` — dispatcher + shebang.
- `package.json` — `bin`, extended `build`.
- `Dockerfile` — CMD += `"serve"`.

**Create:**

- `src/modes/serve.ts`
- `src/modes/run.ts`
- `src/cli/stdio.ts`
- `tests/cli.test.ts`

## Tests (`tests/cli.test.ts`)

Drive `runCli()` with injected `stdin`/`stdout`/`stderr` streams (`PassThrough`), disk-backed temp config, `MockLanguageModelV2`.

1. Happy path — text only. `ok:true`, `finalText:'hello'`, empty `toolCalls`, `steps:1`, exit 0.
2. Tool call + final. `toolCalls[0].name === 'bash'`, `input.command` set, `output` is a string, `steps:2`.
3. Invalid stdin JSON → exit 2, stderr set, stdout empty.
4. Missing `--config` → exit 2, usage on stderr.
5. Bad config path → exit 2, stderr names the path.
6. Approval required → exit 0, `ok:false`, `error` mentions approval, `toolCalls` includes the pending call.
7. `tool_call_on_final_step` error → exit 0, `ok:false`, `error` populated.
8. Stdout has exactly one JSON line (regression guard).
9. `parseTraceparent` unit tests — valid, invalid, missing.

Existing HTTP/SSE tests cover `serve` mode unchanged.

## Verification

1. `pnpm --filter wally typecheck`
2. `pnpm --filter wally lint`
3. `pnpm --filter wally test`
4. `pnpm --filter wally build` — `dist/index.js` has shebang + exec bit.
5. Manual E2E:
   ```
   echo '{"messages":[{"role":"user","content":"hi"}]}' \
     | ANTHROPIC_API_KEY=... node dist/index.js run --config example.config.yaml
   ```
   Last stdout line parses as contract, `ok:true`.
6. HTTP regression: `CONFIG_PATH=example.config.yaml node dist/index.js serve`, curl `/invoke`.

## Decisions

- Bare `wally` prints usage and exits 2. `wally serve` required. Dockerfile CMD updated.
- **Black-box run record.** Stdout is `{ ok, finalText, error }` — no `toolCalls`, no `steps`. Mo treats wally as a black box; per-tool visibility comes from OTEL spans, not stdout. (Revised from the original instructions, which listed `toolCalls` and `steps`.)
- OTEL shutdown is wrapped in a try/catch so flush failures on tear-down never turn a good run into exit 2.
