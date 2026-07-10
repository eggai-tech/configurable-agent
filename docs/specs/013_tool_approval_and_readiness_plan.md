# 013 — Tool approval flow + readiness rethink (plan)

## Tool approval (AI SDK v7 native)

The AI SDK v7 provides first-class approvals via the `toolApproval` option on
`streamText`. An approval rule returns `'not-applicable' | 'approved' | 'denied'
| 'user-approval'`. On `user-approval` the SDK emits a `tool-approval-request`
stream part instead of executing, and the caller resolves it by appending a
`tool-approval-response` (`tool`-role message) to the history and calling again.
This maps cleanly onto the existing stateless `POST /invoke` design (client owns
history) and onto spec 003's envelope statuses.

### Config (`src/config/schema.ts`)

```yaml
safety:
  approval:
    mode: none | all | selected   # default none
    tools: []                      # glob patterns, used when mode: selected
```

### Policy (`src/agent/approval.ts`, new)

`toolNeedsApproval(name, approval)`:
- `none` → false; `all` → true; `selected` → any glob pattern matches (`*`
  wildcard, regex metachars escaped). `todowrite` is always exempt (internal,
  side-effect-free). Unit-tested in `tests/approval.test.ts`.

### Loop (`src/agent/loop.ts`)

- Build a generic `toolApproval` function from config (undefined when
  `mode: none`) and pass it, plus `experimental_toolApprovalSecret` from
  `TOOL_APPROVAL_SECRET`, to `streamText`.
- Handle two new stream parts:
  - `tool-approval-request` → emit a new `tool_approval_requested` event
    (`id`, `approvalId`, `name`, `args`, `signature?`) **and** a `tool_result`
    with `status: 'approval_required'` (spec 003). Mark the step as paused.
  - `tool-output-denied` → emit a `tool_result` with `status: 'denied'`,
    `denied_reason: 'user_denied'` (our policy only ever asks for user approval,
    so any denial is a human decision).
- After a step that produced an approval request, **return** without emitting a
  `final` — the turn is paused; the client re-POSTs with the approval response.

### Events (`src/agent/events.ts`)

Add `tool_approval_requested` to the `AgentEvent` union. The `denied` /
`approval_required` statuses and `denied_reason` already existed (spec 003) and
now have a producer.

### Security

`TOOL_APPROVAL_SECRET` (optional) → passed as `experimental_toolApprovalSecret`.
The server HMAC-signs each request and rejects forged/tampered approvals — needed
because the `/invoke` history is client-controlled. The signature rides on the
event and must be echoed back. Zero-config and backward-compatible when unset.

## Readiness (`src/agent/model.ts`, `src/api/server.ts`)

- `probeModel(cfg, signal)` issues one minimal `generateText` (`maxOutputTokens:
  1`) and returns `{ ok, error? }`. Catches wrong/revoked keys, unreachable or
  malformed `baseUrl`, and unknown model names — none of which a presence check
  can see.
- `/ready` runs the probe when `?deep=1` or `READINESS_DEEP_PROBE=1`, with a
  timeout from `READINESS_PROBE_TIMEOUT_MS` (default 5000). Default `/ready`
  stays the cheap presence check so k8s polling doesn't hit the provider.

## Version

Bumped to **0.3.0** (single-sourced via `src/version.ts`; the CLI banner and
OTEL resource pick it up automatically). New feature → minor bump.

## Tests & docs

- `tests/approval.test.ts` — matcher unit tests.
- `tests/loop.test.ts` — loop-level: a gated call pauses (tool not executed, no
  `final`, approval event emitted) driven through the real SDK; `mode: none`
  executes normally.
- `vitest.config.ts` — sets `LOG_LEVEL=silent` so expected warn/info lines stay
  out of test output.
- README: approval config + flow section, `tool_approval_requested` event,
  `denied_reason` field, `/ready` deep-probe note, a consolidated environment-
  variables table. `example.config.yaml`: `safety.approval` block.

## Verification

`typecheck`, `build` (tsc 7), `lint`, and the full suite (85 tests) all pass.

## Not done / follow-ups

- `experimental_toolApprovalSecret` is a v7-experimental API; revisit when it
  stabilizes.
- Automatic-deny policy tiers (e.g. a `deny` list yielding `policy_deny`) were
  not added — current modes only ever ask for user approval. Easy to layer on
  later if a deny tier is wanted.
