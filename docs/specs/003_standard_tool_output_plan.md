# Standardize tool outputs

## Context

Today each tool in Configurable Agent returns its own ad-hoc shape (`BashRunResult`, `BashDenyResult`, `HttpResult`, raw websearch/todowrite objects), with a parallel `TruncatedToolOutput` wrapper applied only when outputs are too large. Clients of the SSE stream (and the model) have to special-case every tool.

This spec introduces a single envelope `{ label, status, content, return_code, args, duration_ms }` so a UI can render any tool uniformly. The bash tool also merges stderr into stdout so the model/UI sees one interleaved stream, like a terminal.

## Decisions

- Envelope applies to BOTH the LLM tool message and the SSE `tool_result` event.
- `status` has 4 values: `'succeeded' | 'error' | 'denied' | 'approval_required'`, plus a `denied_reason` field with detail.
- `content` is tool-specific plaintext (not JSON-stringified): bash → merged output; http → status line + body; websearch → formatted list; todowrite → raw JSON.
- `return_code` is always present; `null` where not applicable.
- `args` are passed through verbatim (no redaction — that's a separate concern).
- `duration_ms` wraps the whole `execute()` call (for `approval_required` it's tiny; when the tool is later approved and re-run, the fresh duration replaces it).
- `label` is produced by each tool via a per-tool labeler.
- Oversized outputs fold into `content` + an envelope-level `truncated: true` boolean (the separate `tool_result_truncated` event is removed).
- Bash merge: Node-level buffer merge (not shell `2>&1`) — append decoded chunks from both pipes into one buffer in order received; ordering is approximate but acceptable.
- On `approval_required`, the loop HALTS — the LLM never sees a placeholder result. The UI gets both `tool_approval_requested` and a new `tool_result` envelope with `status=approval_required`.
- Full cutover (no legacy compat shim).

## Envelope type

New file: `configurable-agent/src/agent/tools/result.ts`

```ts
export type ToolStatus = 'succeeded' | 'error' | 'denied' | 'approval_required';
export type DeniedReason = 'policy_deny' | 'user_denied' | 'policy_compound';

export interface ToolResult {
  label: string;
  status: ToolStatus;
  content: string;
  return_code: number | null;
  args: unknown;
  duration_ms: number;
  truncated?: boolean;       // set when content has been summarized
  denied_reason?: DeniedReason; // only when status === 'denied'
}
```

Also export a small helper `wrapToolExecute(toolName, labeler, handler)` that:
1. Captures `Date.now()` at entry.
2. Invokes the tool-specific handler (which returns a partial envelope: `status`, `content`, `return_code`, plus any `denied_reason`/`truncated`).
3. Fills in `label` via the labeler, `args` from the input, `duration_ms` from the clock.
4. On thrown errors: returns `{ status: 'error', content: String(err?.message ?? err), return_code: null }` with `label`/`args`/`duration_ms` populated.

This keeps each tool focused on its own logic; the wrapper owns the envelope.

## Per-tool changes

### `configurable-agent/src/agent/tools/bash.ts`

- Delete `BashRunResult` and `BashDenyResult` (replaced by `ToolResult`).
- `gateCommand` now returns either a `ToolResult` (denied / approval_required) or `null` (proceed).
  - `policy_deny` → `{ status: 'denied', denied_reason: 'policy_deny', content: hint, return_code: null }`
  - `user_denied` → `{ status: 'denied', denied_reason: 'user_denied', content: hint }`
  - `policy_compound` → `{ status: 'denied', denied_reason: 'policy_compound', content: hint }`
  - `no_human_approver` → `{ status: 'denied', denied_reason: 'policy_deny', content: hint }` (collapses into generic policy deny — no distinct enum value)
  - `approval_pending` → `{ status: 'approval_required', content: hint, return_code: null }`
- `runBashStreaming`: switch to a single `output` buffer + single byte counter. On every chunk (from either pipe), emit `tool_output_chunk` (renamed), append to `output` (respecting `maxBufferBytes`), and increment the counter. Keep one shared `seq` (already the case today). Stdout and stderr streams are both still opened (`spawn('/bin/sh', ['-c', command])` with default stdio) — we just merge app-side.
- Result of a successful run: `{ status: 'succeeded', content: output, return_code: exitCode }` (non-zero exit is still `succeeded` — the code conveys the failure; `error` status is reserved for exceptions).
  - Exception: `timedOut` still forces `return_code: 124` (matches today).
- Labeler: `label: args.command`.

### `configurable-agent/src/agent/tools/http.ts`

- Delete `HttpResult`.
- Return `{ status: 'succeeded', content: \`${httpStatus} ${statusText}\n${body}\`, return_code: httpStatus }` on a completed fetch (any HTTP status).
- Thrown fetch errors go through `wrapToolExecute`'s catch → `status: 'error'`.
- Headers and `truncated` are dropped from the envelope.
- Labeler: `fetch ${args.method ?? 'GET'} ${args.url}`.

### `configurable-agent/src/agent/tools/websearch.ts`

- Format `content` as:
  ```
  Answer: <answer>

  1. <title>
     <url>
     <snippet>

  2. <title>
     ...
  ```
- `return_code: null`, `status: 'succeeded'`.
- Thrown errors → `status: 'error'`.
- Labeler: `search "${args.query}"`.

### `configurable-agent/src/agent/tools/todowrite.ts`

- `content: JSON.stringify({ todos, count }, null, 2)` (raw JSON).
- `return_code: null`, `status: 'succeeded'`.
- Labeler: `update todos (${count})`.

## Summarization refactor

`configurable-agent/src/agent/safety/tool-summary.ts`:
- `maybeSummarizeToolOutput` now accepts an already-built `ToolResult` and returns a possibly-rewritten `ToolResult`.
- When `content`'s token count exceeds `triggerTokens`, it replaces `content` with a formatted block:
  ```
  <summary>

  --- HEAD (first N chars) ---
  <headExcerpt>

  --- TAIL (last M chars) ---
  <tailExcerpt>
  ```
  and sets `truncated: true` on the envelope.
- Delete `TruncatedToolOutput` interface and the `emit({ type: 'tool_result_truncated', ... })` call.
- Wiring: `wrapToolExecute` calls `maybeSummarizeToolOutput` AFTER the partial envelope is assembled but BEFORE return, so every tool benefits uniformly.

## Event schema (`configurable-agent/src/agent/events.ts`)

- Rename `tool_stdout_chunk` → `tool_output_chunk`; drop the `stream` field. Shape: `{ type: 'tool_output_chunk'; id: string; text: string; seq: number }`.
- `tool_stream_end`: keep as-is (bash-only streaming metadata, distinct from the envelope's terminal fields).
- `tool_result.output` is now typed as `ToolResult`.
- Delete the `tool_result_truncated` variant.
- `tool_approval_requested` unchanged.

## Loop / approval flow (`configurable-agent/src/agent/loop.ts`)

Today `isPendingApprovalOutput` filters pending-approval results out of the SSE `tool_result` event but the AI SDK still inserts that tool output into the next model turn. New behavior:

- Replace `isPendingApprovalOutput` with a check on the envelope: `output.status === 'approval_required'`.
- When at least one tool in the current step returned `approval_required`:
  1. Emit a `tool_result` SSE event with the envelope (UI sees it).
  2. Do NOT append a tool message to the conversation history.
  3. Break out of the agent loop — return the partial `final` event with a `stopReason` like `approval_required` so the client knows to re-invoke with approvals.
- When the client re-invokes with `approvals`, the tool runs for real; the fresh envelope (with real `duration_ms`, `return_code`, `content`) is what the model sees and what's streamed.

Verify the AI SDK's `generateText`/`streamText` behavior: if a tool `execute()` returns, the SDK tries to feed it back to the model. We may need to throw a sentinel error from `execute()` when status is `approval_required` and catch it at the loop layer, or use the `prepareStep`/step-stop hook. During implementation, confirm the SDK's exact contract and pick the cleanest interception point.

## Tests

All tests in `configurable-agent/tests/`:

- `bash-policy.test.ts` — no changes (classifier untouched).
- Any bash execute test needs updating to assert on the envelope shape (not `BashRunResult`).
- `tool-summary.test.ts` — rewrite assertions to check envelope's `content` + `truncated: true`; remove assertions on the `tool_result_truncated` event.
- `loop.test.ts` — add a case asserting that an `approval_required` result halts the loop and is NOT fed to the model.
- `sse.test.ts` — update `tool_result` payload assertions; rename `tool_stdout_chunk` → `tool_output_chunk` assertions; drop `stream` field.
- `compaction.test.ts` — review for any tool-output shape assumptions.

## Critical files (touch list)

- `configurable-agent/src/agent/tools/result.ts` — NEW
- `configurable-agent/src/agent/tools/bash.ts`
- `configurable-agent/src/agent/tools/http.ts`
- `configurable-agent/src/agent/tools/websearch.ts`
- `configurable-agent/src/agent/tools/todowrite.ts`
- `configurable-agent/src/agent/tools/index.ts` — wire the new `wrapToolExecute` helper into tool construction
- `configurable-agent/src/agent/safety/tool-summary.ts`
- `configurable-agent/src/agent/events.ts`
- `configurable-agent/src/agent/loop.ts` (approval halt)
- `configurable-agent/src/api/request.ts` / `configurable-agent/src/api/server.ts` — verify no hardcoded assumptions about old shapes
- `configurable-agent/tests/bash-policy.test.ts`
- `configurable-agent/tests/tool-summary.test.ts`
- `configurable-agent/tests/loop.test.ts`
- `configurable-agent/tests/sse.test.ts`
- `configurable-agent/tests/compaction.test.ts`

## Verification

1. `pnpm test` — all unit tests pass.
2. `pnpm tsc --noEmit` (or equivalent) — no type errors.
3. Manual SSE smoke test against the dev server:
   - Send a request that triggers a bash call with `echo hi; echo err >&2` — confirm `tool_output_chunk` events arrive in order, `tool_result` envelope has `content` containing both lines interleaved, `status: 'succeeded'`, `return_code: 0`.
   - Send a request that triggers a policy-denied bash command — confirm `tool_result` envelope has `status: 'denied'`, `denied_reason: 'policy_deny'`.
   - Send a request that triggers an ask-tier bash command with approval enabled — confirm `tool_approval_requested` + `tool_result` (status=approval_required) both fire, loop halts, `final` event has `stopReason: 'approval_required'`. Re-invoke with approvals → confirm real execution and a fresh envelope with real `duration_ms`.
   - Send an http call — confirm `content` starts with `200 OK\n` (or the actual status) and `return_code` matches.
   - Force an oversized output — confirm envelope's `content` is the summary+excerpts block and `truncated: true`; confirm no `tool_result_truncated` event.
4. Check that an existing UI consumer (if any) renders the new envelope cleanly; otherwise flag the schema change in the spec doc.

## Known caveats / follow-ups

- **AI SDK history on approval halt.** When a tool returns `status: 'approval_required'`, the AI SDK still appends the envelope to `response.messages`, so it ends up in the conversation history the server just built. The loop halts before the next LLM turn, so the model never reads it *in this request*. But the client contract must be: on re-invoke, send the conversation state BEFORE the halted step (not the server's post-halt history) along with fresh `approvals`. If a future client ever resends the post-halt history, the LLM would observe the placeholder. Possible hardening: emit an explicit `stopReason: 'approval_required'` in the `final` event (we currently return silently from the loop on pending approvals).
- **SSE smoke tests not run.** The verification section above was not executed end-to-end against a live dev server during the refactor. Unit tests + typecheck + lint pass; the HTTP/bash/summary paths were not exercised against a real model. Run the smoke tests in the verification list before declaring shipped.
