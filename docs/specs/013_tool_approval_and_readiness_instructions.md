# 013 — Tool approval flow + readiness rethink (instructions)

## Original request

Follow-up to 012. During review two items were deliberately left unimplemented
(the `denied`/`approval_required` tool statuses had no producer; `/ready` only
checked env-var presence). The user asked to:

1. **Implement the approval flow.** Suggested looking at the AI SDK v7 tool
   approvals docs (https://ai-sdk.dev/docs/agents/tool-approvals).
2. **Rethink the readiness check.** Presence-of-env-var is weak — the values may
   be present but wrong (bad auth key, invalid/unreachable URL, unknown model).
   Wanted better verification.
3. **Bump the version.**
4. **Keep the documentation (README, example config, specs) fully aligned** and
   extend it where useful.

## Decisions captured from the user

- **Approval config surface:** a `safety.approval` block with
  `mode: none | all | selected` and, for `selected`, a list of glob-style tool
  name patterns (e.g. `delete_*`, `send_email`).
- **Readiness:** keep the cheap presence check as the default `/ready`, and add
  an **opt-in active provider probe** (`?deep=1`, or `READINESS_DEEP_PROBE=1` to
  make it the default) so k8s readiness polling stays free but a real
  auth/connectivity/model check is available.

## Constraints

- Reconcile with existing specs: spec 003 defines the `denied`/`approval_required`
  envelope statuses; spec 002 described a bash-tool approval protocol, but this
  repo has **no bash tool** — its tools are dynamic MCP tools + `todowrite`, so
  approval applies to MCP calls via the AI SDK's native mechanism.
- Use the bundled, version-matched AI SDK docs; `pnpm` via `corepack`; keep tests
  and docs aligned; small logically-scoped commits.
