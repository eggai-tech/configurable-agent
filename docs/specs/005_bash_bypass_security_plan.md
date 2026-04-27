# Bash tool: bypassSecurityChecks escape hatch

## Context

Today the bash tool runs every command through `classify()` in
`configurable-agent/src/agent/tools/bash-policy.ts`: builtin read-only allowlist, user
allow/ask/deny rules, and a hard compound-command gate that forces `ask` on
any command containing `;`, `&&`, `||`, `|`, `$()`, backticks, or
redirections. For `ask`-tier verdicts, `gateCommand()` in
`configurable-agent/src/agent/tools/bash.ts` either (a) requires a human approval when
`policy.approval.enabled=true`, or (b) denies synchronously with
`no_human_approver` otherwise.

The Gaia core-agent runs autonomously inside a cluster and needs to issue
arbitrary shell commands to clone the GitOps repo, write files via heredoc,
run `git push`, `kubectl apply`, `helm upgrade`, etc. All of these are
either `ask`-tier (compound/`git commit -c ... commit -m ...`, `kubectl
apply`) or outright unknown to the builtin list. Under the current policy
it can't operate without a human in the loop, which defeats the point of
the core agent.

We need a single config flag that disables the security gate entirely for
deployments that trust the LLM fully. This is explicitly a POC-posture
escape hatch.

## Approach

Add `tools.bash.policy.bypassSecurityChecks: boolean` (default `false`) to
the configurable-agent agent config. When `true`:

- `classify()` short-circuits and returns `{ decision: 'allow', reason:
  'bypassSecurityChecks', matchedRule: null, isCompound: false,
  suggestedRules: [] }` before running any of the existing logic.
- `gateCommand()` therefore returns `null` (no gate), and the command runs
  directly via `runBashStreaming()`.
- All existing tiers (compound check, deny rules, ask rules, builtin
  allowlist, user allow rules, session rules) are skipped. Deny rules are
  skipped too — bypass means bypass. A partial bypass would be a footgun.

The approval gate is unaffected in shape but unreachable while the bypass
is on (nothing ever returns `ask`).

Place the short-circuit inside `classify()` rather than at the top of
`gateCommand()`. Reason: `classify()` is the one function exercised by
unit tests in `configurable-agent/tests/bash-policy.test.ts`, so the bypass gets tested
directly without standing up `gateCommand`'s approval-state plumbing.

## Files to change

| File | Change |
|---|---|
| `configurable-agent/src/config/schema.ts` | Add `bypassSecurityChecks: z.boolean().default(false)` inside the `tools.bash.policy` object and in its two `.default(...)` blocks. |
| `configurable-agent/src/agent/tools/bash-policy.ts` | Add `bypassSecurityChecks: boolean` to `BashPolicyConfig`. At the top of `classify()`, if `cfg.bypassSecurityChecks` is true, return an `allow` verdict immediately. |
| `configurable-agent/src/agent/tools/bash.ts` | No structural change — `BashToolConfig.policy` already extends `BashPolicyConfig`, so the new field flows through. |
| `configurable-agent/src/agent/tools/index.ts` | Thread `bypassSecurityChecks: policy.bypassSecurityChecks` into the object passed to `createBashTool`. |
| `configurable-agent/src/agent/loop.ts` | Thread `bypassSecurityChecks` in `bashConfigFromAgentConfig()` and extend the inline return type. |
| `configurable-agent/tests/bash-policy.test.ts` | Add a describe block covering: bypass allows unknown command; bypass allows compound; bypass overrides deny; `bypassSecurityChecks=false` keeps current behavior. |

## Gaia side

Set the flag for the core agent in `gaia/core-agent/config.yaml`:

```yaml
tools:
  bash:
    enabled: true
    timeoutMs: 60000
    maxBufferBytes: 2097152
    policy:
      bypassSecurityChecks: true
```

`policy.approval.enabled` is dropped from the core-agent config at the same
time — with the bypass on, the approval gate is unreachable and leaving the
flag in is misleading. If someone later flips `bypassSecurityChecks: false`
and wants interactive approval back, they can add it back.

## Verification

- `pnpm test` in `configurable-agent/` — existing bash-policy tests plus the new bypass
  cases.
- No runtime verification against a live Gaia cluster as part of this
  change; the config update takes effect on the next pod restart with a
  configurable-agent image that contains this code.

## Out of scope

- Per-command bypass (e.g. bypass for specific prefixes only). If that's
  ever needed, the existing `allow` list already covers it.
- Audit logging of bypassed commands. Follow-up when audit log lands.
- UI surfacing of "this deployment has the bypass on." Ops concern,
  separate ticket.
