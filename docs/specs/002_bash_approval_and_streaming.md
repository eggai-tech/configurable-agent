# Bash tool: approval flow + output streaming

## Context

Today the bash tool at `wally/src/agent/tools/bash.ts` runs `execFile('/bin/sh', ['-c', command])` with no sandboxing, no approval, no streaming, and full pod env inherited (including provider API keys). The system prompt at `gaia/core-agent/config.yaml:76-77` *asks* the model to confirm commands, but nothing enforces it — the model can mutate the cluster unilaterally since the Gaia core-agent runs as cluster-admin (acknowledged POC-only limitation in `gaia/README.md:138-143`).

This change adds (a) a policy-gated approval flow carried by the existing `POST /invoke` API (keeping Wally stateless) and (b) realtime output streaming. Audit logging and secret redaction are deliberately deferred as follow-ups.

## Approach

### Stateless approval flow

**Hard constraint: Wally holds no state between API calls.** The client (Gaia frontend, or any caller) owns all conversation + approval state. Approvals ride on the next `POST /invoke`, not a side-channel endpoint.

**`POST /invoke` request schema grows two optional fields**:
```
{
  messages: [...],                              // existing; full history
  approvals?: [                                 // NEW: one entry per previously-pending tool call
    { toolCallId: string,
      decision: 'allow_once' | 'allow_session' | 'deny',
      rule?: string                             // required when decision === 'allow_session'
    }
  ],
  sessionAllowRules?: string[]                  // NEW: client-accumulated rules from prior allow_session decisions
}
```

**Parallel tool calls are first-class.** The agent may emit multiple tool_uses in a single assistant turn. Each is classified independently; each unapproved `ask` call gets its own `tool_approval_requested` event; the client collects decisions for all of them and sends them back in one `approvals[]` array on the next request.

**Per-request flow inside Wally (still fully stateless across requests):**

1. Parse request. Build in-request approval map `Map<toolCallId, Decision>` from `approvals[]`. Union `sessionAllowRules[]` with built-ins into an in-request allow set.
2. Scan `messages` for any assistant tool_use that has no matching tool_result (this happens when a prior request ended with pending approvals). For each such pending tool_use:
   - Look up its toolCallId in the approval map.
   - If decision is `allow_once` or `allow_session`: execute the tool now, synthesize a tool_result, append to messages. (`allow_session` also already seeded `sessionAllowRules` from the client.)
   - If `deny`: synthesize `{ denied: true, reason: 'user_denied' }` and append.
   - If no approval is provided for a pending tool_use and approval is **enabled**: emit `tool_approval_requested` again and keep it pending (don't enter the model loop until all pending calls have a tool_result, matching the AI SDK's expectation).
   - If no approval is provided and approval is **disabled**: synthesize `{ denied: true, reason: 'no_human_approver' }` immediately.
3. Call `streamText` with the now-complete message history.
4. Inside `execute()` for newly-issued tool calls, run the same classify + approve/reject/ask logic. New `ask` calls that lack a decision in the current request context emit `tool_approval_requested` and return a sentinel that causes the loop to stop after this batch (the stream ends; the client is responsible for the next POST).

**Termination of a request**: the HTTP/SSE response closes either when (a) the model emits a final natural-language turn, or (b) there is at least one pending-approval tool call that can't be resolved from the request's `approvals[]`. In case (b) the client has everything it needs — SSE events for each pending call, and the assistant message with unresolved tool_uses — to drive the next POST.

### Interactive vs autonomous mode

One config flag: `tools.bash.policy.approval.enabled`. Default **`false`**.

- **`enabled: false` (autonomous, default)**: `ask`-tier commands are rejected synchronously inside `execute()` with:
  ```
  { denied: true, reason: 'no_human_approver', policy: 'ask',
    matchedRule: '<rule>' | null, hint: 'This command requires approval but
    approval is disabled for this deployment. Use a read-only alternative.' }
  ```
  No event is emitted, no waiting, no reliance on the client. This is the common case for unattended agents. The model gets a clean, structured result and can adapt.

- **`enabled: true` (interactive)**: `ask`-tier calls that don't already have an approval in the current request emit `tool_approval_requested` and stop the loop; client collects decisions and re-POSTs with `approvals[]`.

**`deny` tier is unaffected by this flag** and uses reason `'policy_deny'`. Distinct reasons let the model distinguish "never allowed" from "would need a human but none available" from "human said no".

### Policy engine

**Config** (add to `wally/src/config/schema.ts` under `tools.bash`):
```
policy: {
  approval: { enabled: boolean (default false) },
  allowCompound: boolean (default false),
  disableBuiltinAllow: boolean (default false),
  allow: string[] (default []),
  ask: string[] (default []),
  deny: string[] (default []),
}
```

**Pattern syntax: token-prefix matching**, not regex, not glob. Tokenize both pattern and command with `shell-quote`; pattern matches iff its tokens equal the leading tokens of the command. Regex is a known security-boundary footgun; prefix is what humans mean when they write `kubectl get`.

**Evaluation order** (first match wins, tiers go deny → ask → allow):
1. **Compound command** (`;`, `&&`, `||`, `|`, `$()`, backticks, redirections) with `allowCompound=false` → `ask` with reason `"compound command"`. Detected via `shell-quote.parse()` — any operator sentinel in the output means compound. This is the key defense against `kubectl get pods; rm -rf /` bypassing a prefix allowlist.
2. Any token matches `deny` → `deny`.
3. Any token matches `ask` → `ask` (overrides builtin allow so operators can tighten).
4. Matches builtin read-only list, user `allow`, or `sessionAllowRules` → `allow`.
5. Default → `ask`.

**Builtin read-only allowlist** (hardcoded constant in new `wally/src/agent/tools/bash-policy.ts`):
`ls, pwd, whoami, id, date, uname, cat, head, tail, wc, file, stat, grep, rg, find, ps, df, du, jq, kubectl get, kubectl describe, kubectl logs, kubectl top, kubectl version, kubectl config current-context, kubectl config get-contexts, helm list, helm status, helm get values, git status, git log, git diff, git show, git branch`.

**Deliberate exclusions**: `env`, `printenv`, `set`, `export`, `history` — these leak the pod's provider API keys into the transcript. `find -exec` and `cat > file` are caught by the compound check.

**Session rules are client-owned.** When an approval is `allow_session` with a rule, the client adds that rule to its local `sessionAllowRules[]` and sends the accumulated list on every subsequent request. Wally never persists session state.

### Output streaming

Swap `execFile` for `spawn('/bin/sh', ['-c', command], { signal: abortSignal })`. Attach `data` listeners to `stdout`/`stderr`; per chunk emit new `tool_stdout_chunk { id, stream, text, seq }` event. Use `StringDecoder` for UTF-8-safe boundaries.

**Buffer overrun**: enforce `maxBufferBytes` on the model-visible buffer only. On overrun, set `truncated=true`, stop appending to the model buffer, but keep streaming to the client (operator still sees the tail). Don't kill the process unless new `killOnBufferOverflow` flag is set (default false).

**Timeout**: manual `setTimeout` → `child.kill('SIGTERM')` (spawn doesn't have built-in timeout). Cleared on `close`.

**Final `execute()` return value**: awaits `child.on('close')`, returns `{ stdout, stderr, exitCode, timedOut, truncated }`, then passes through existing `maybeSummarizeToolOutput` (`wally/src/agent/safety/tool-summary.ts`). Client sees full realtime stream via `tool_stdout_chunk`; model sees possibly-summarized result via existing `tool_result`.

Emit `tool_stream_end { id, exitCode, timedOut, totalBytes, truncated }` right before returning so the frontend can close the stream view cleanly.

### New SSE event shapes (`wally/src/agent/events.ts`)

Add to the existing `AgentEvent` discriminated union:
```
| { type: 'tool_approval_requested'; id: string; tool: 'bash'; command: string;
    reason: string; policy: 'ask'; suggestedRules: string[] }
| { type: 'tool_stdout_chunk'; id: string; stream: 'stdout' | 'stderr'; text: string; seq: number }
| { type: 'tool_stream_end'; id: string; exitCode: number; timedOut: boolean;
    totalBytes: number; truncated: boolean }
```

No `run_started`, no `tool_approval_resolved`, no `runId` anywhere — those were statefulness smells.

## Files to change

| File | Change |
|---|---|
| `wally/src/config/schema.ts` | Add `tools.bash.policy` sub-schema with defaults (~20 LOC). `approval.enabled` defaults to **false**. |
| `wally/src/agent/events.ts` | Add 3 new `AgentEvent` variants: `tool_approval_requested`, `tool_stdout_chunk`, `tool_stream_end` (~15 LOC) |
| `wally/src/api/request.ts` | Extend the `/invoke` request schema with optional `approvals: ApprovalDecision[]` and `sessionAllowRules: string[]` (~15 LOC) |
| `wally/src/agent/safety/tool-summary.ts` | Extend `ToolSummaryRuntime` with `approvals: Map<toolCallId, Decision>`, `sessionAllowRules: Set<string>`, `pendingApprovals: Set<toolCallId>`. No behavior change to `maybeSummarizeToolOutput` (~8 LOC) |
| `wally/src/agent/tools/bash-policy.ts` *(new)* | Builtin allowlist + `classify(command, cfg, sessionRules)` using `shell-quote` (~120 LOC) |
| `wally/src/agent/tools/bash.ts` | Rewrite: classify → consult in-request approvals → (deny path / execute path / emit `tool_approval_requested` + return pending-sentinel path) → `spawn` with streaming → summarize. Keep external shape `createBashTool(cfg, ctx)` (~180 LOC, up from 70) |
| `wally/src/agent/tools/index.ts` | Thread new cfg subtree and ctx fields (~5 LOC) |
| `wally/src/agent/loop.ts` | Two changes: (1) pre-`streamText` resolver that walks `messages` for pending tool_uses and resolves them using `approvals[]` before entering the loop; (2) stopWhen/abort logic that halts the loop when `pendingApprovals` is non-empty after a batch. Build the per-request `ToolSummaryRuntime` from the request. (~60 LOC) |
| `wally/src/api/server.ts` | Pass `approvals` + `sessionAllowRules` from request into `runAgent`. **No new endpoint.** (~10 LOC) |
| `gaia/core-agent/config.yaml` | Drop the unenforced "ask the user to confirm" lines from the system prompt now that enforcement is real (-2 LOC) |
| `wally/package.json` | Add `shell-quote` + `@types/shell-quote` via `pnpm add` (do not hand-edit per `wally/CLAUDE.md`) |
| `wally/tests/bash-policy.test.ts` *(new)* | Unit tests for `classify()` (~100 LOC) |

Net: ~500 LOC added. No existing tool's external shape changes.

**Reused utilities** (don't reinvent):
- `maybeSummarizeToolOutput` in `wally/src/agent/safety/tool-summary.ts` — final result still flows through it.
- `AgentEmitter` in `wally/src/agent/events.ts` — new events added to the existing union.
- Existing `streamSSE` wiring in `wally/src/api/server.ts`.
- AI SDK's `streamText` stop-condition hooks for halting on pending approvals.

## Follow-ups (explicitly out of scope)

- **Audit log** (persist every invocation with approver/result).
- **Secret redaction** in stdout/stderr.
- **Argv-based variant** alongside the shell-string form.
- **Frontend approval UI** in Gaia — separate ticket; consumes `tool_approval_requested`, renders the prompt, tracks `sessionAllowRules` locally, POSTs the next `/invoke` with `approvals[]`.

## Verification

**Unit tests** in new `wally/tests/bash-policy.test.ts`:
- `kubectl get pods` → allow
- `kubectl delete pod foo` → ask
- `rm -rf /` with `deny: ['rm']` → deny
- `env` → ask, even with user `allow: ['env']` if `ask: ['env']` is also set (precedence)
- **Bypass: `kubectl get pods; rm -rf /` → ask with reason `compound command`**. Repeat for `&&`, `||`, `|`, backticks, `$(...)`, `>`, `<`
- `kubectl get $(whoami)` → ask (command substitution detected)
- Session rule `'kubectl get'` in `sessionAllowRules` → matching call classifies `allow`; compound variant still `ask`

**Integration** against a running Wally dev server. Run in **both** `approval.enabled: true` and `approval.enabled: false` configs:
- Trivial command (`ls /tmp`) in either mode: SSE sequence is `tool_call` → `tool_stdout_chunk`+ → `tool_stream_end` → `tool_result` → `final`. No approval event.
- **Autonomous mode**, `ask`-tier command: tool_result is `{ denied: true, reason: 'no_human_approver' }`; no `tool_approval_requested` event; model continues within `maxSteps`.
- **Interactive mode, first POST**: model issues `kubectl delete pod foo`; `tool_approval_requested` event fires; stream ends with no tool_result for that toolCallId.
- **Interactive mode, second POST**: same messages + `approvals: [{ toolCallId, decision: 'deny' }]`; tool_result is `{ denied: true, reason: 'user_denied' }`; model continues and completes the turn.
- **Interactive mode, allow_once**: second POST with `decision: 'allow_once'`; command runs normally, `tool_stdout_chunk`/`tool_stream_end` events fire.
- **Interactive mode, allow_session**: client sends `sessionAllowRules: ['kubectl delete pod']`; subsequent matching calls auto-allow with no `tool_approval_requested` event.
- **Interactive mode, parallel tool calls**: craft a prompt that makes the model call two `ask`-tier tools in one assistant turn; first POST emits two `tool_approval_requested` events; second POST with two entries in `approvals[]` resolves both and continues.
- **Bypass integration**: model-issued `kubectl get pods; touch /tmp/pwned`; deny from client → `stat /tmp/pwned` fails. With `sessionAllowRules: ['kubectl get']`, the compound check still forces ask (session rules don't bypass the compound gate).
- Buffer overrun: `yes | head -n 100000000` with `maxBufferBytes=1024`; chunks keep arriving, `tool_stream_end.truncated=true`, model's `tool_result` is the summarized truncated payload.
- Abort: client closes SSE mid-stream; child process receives SIGTERM; no orphan processes.

**Manual smoke**: point Gaia dev frontend (once its UI follow-up lands) at this Wally build, run a session that hits all three tiers + parallel tool calls, confirm approval UI correlates by `toolCallId`.

## Open decisions

1. **Pending-tool-call representation between requests.** Options: (a) client sends back messages with the partial assistant turn (tool_uses present, no tool_results) and Wally synthesizes tool_results from `approvals[]` before resuming; (b) client sends messages with placeholder tool_results that Wally rewrites. Recommend (a) — it matches the Vercel AI SDK's documented human-in-the-loop pattern and means messages never contain transient "pending" markers.
2. **Compound-command UX.** Strict v1 means `kubectl get pods | jq ...` prompts. Annoying but correct. v2 could add per-segment evaluation.
3. **Authenticating approvals.** `POST /invoke` is currently unauthenticated (POC posture). When auth lands, the `approvals[]` carrier inherits it for free — no separate endpoint to gate. Flag for when auth work begins.
