# Plan — Tool call legibility (configurable-agent side)

## Context

The core agent is producing bash scripts that redirect mo's `--json` output
to files and post-process with jq, which hides the raw JSON from the UI.
Every script also leads with `set -eu`, which dominates the tool card
preview. Adding a dedicated `mo_run` tool removes one class of
hide-output-in-a-file pattern entirely, and adding an `intent` field to
every tool input gives durable "why is this call happening" legibility
across the board.

## Changes

### 1. Shared intent field

New export in `configurable-agent/src/agent/tools/result.ts`:

```ts
export const intentField = {
  intent: z.string().min(1).describe(
    "One short sentence (≤ 140 chars) describing WHY this tool call is being made. Written for the human watching the UI, not the model. Be specific: 'Round 2 of eval after tightening the urgent-category prose' not 'Running tool'."
  ),
};
```

Each tool's Zod input schema spreads `...intentField` alongside its own
fields. Tool `execute()` functions ignore `intent` — it's metadata, not a
parameter. No protocol change; intent lives in `tool_call.args`.

Tools updated: bash, http, websearch, todowrite, mo_run.

### 2. New `mo_run` tool

`configurable-agent/src/agent/tools/mo.ts`, patterned on bash.ts streaming.

Input:
- `configPath: string`
- `filter?: string` → mo's `--filter`
- `concurrency?: number` → mo's `--concurrency` (default 4)
- `intent: string`

Behavior:
- Spawn `mo run --config <configPath> --json [--filter ...] [--concurrency N]`.
- Stream stdout chunk-by-chunk as `tool_output_chunk` events (with
  `await emit(...)`, seq counter, decoder-tail flush).
- On close, parse full stdout as mo's `RunSummary` (see
  `mo/src/runner/run.ts:28-40`).
- Return ToolResult:
  - rc 0 or 1 → `status: 'succeeded'`, `return_code: rc`, `content`: the
    parsed JSON pretty-printed so the model has structured totals + per-case
    results without jq.
  - rc 2 → `status: 'error'`, include stderr in content.

Config: `configurable-agent/src/config/schema.ts` adds `moRun: { enabled: boolean }`
alongside existing tools. Default off. `buildTools()` in `tools/index.ts`
conditionally includes it.

### 3. Bash streaming bug fixes

`configurable-agent/src/agent/tools/bash.ts`:
- Lines 142 + 180: `void emit(...)` → `await emit(...)`.
- Lines 175-177: emit the decoder-tail string as a final
  `tool_output_chunk` before `tool_stream_end` (currently counted in
  `totalBytes` but never streamed).

## Files

New:
- `configurable-agent/src/agent/tools/mo.ts`

Modified:
- `configurable-agent/src/agent/tools/result.ts` — `intentField` export
- `configurable-agent/src/agent/tools/bash.ts` — intent + two streaming fixes
- `configurable-agent/src/agent/tools/http.ts` — intent
- `configurable-agent/src/agent/tools/websearch.ts` — intent
- `configurable-agent/src/agent/tools/todowrite.ts` — intent
- `configurable-agent/src/agent/tools/index.ts` — register mo_run
- `configurable-agent/src/config/schema.ts` — `tools.moRun.enabled`

## Verification

1. `pnpm --filter configurable-agent build` passes.
2. A unit test that spawns `mo_run` against a fixture config asserts
   (a) `tool_output_chunk` events carry the JSON stdout,
   (b) `ToolResult.content` parses as `RunSummary`,
   (c) rc=2 surfaces as `status: 'error'`.
3. End-to-end: gaia core-agent runs an eval loop, and the `mo_run` card
   in the UI streams the JSON live (not only on completion).

## Iron rules

- Do not add dedicated tools for `git`, `kubectl`, `jq`, etc. They stay
  in bash. Dedicated tools only for first-party binaries with
  stereotyped usage.
- No migrations. Per CLAUDE.md POC rules, update callers directly.

## Spec pair

`gaia/docs/specs/015_tool_call_legibility_*` covers the UI rendering of
`intent` and the core-agent prompt changes.
