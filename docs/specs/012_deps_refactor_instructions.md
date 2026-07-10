# 012 — Dependency upgrade, migration & code-quality pass (instructions)

## Original request

Update all dependencies to the most recent ones and migrate the code if needed,
reduce complexity and bloat, fix bugs & issues & code smells, and ensure proper
error handling and logging. Do the work on a new branch and open a PR. Use the
AI SDK skill where helpful and multiple agents; choose model and reasoning as
appropriate.

## Clarification given during the work

The repo's `pnpm-workspace.yaml` carried `minimumReleaseAge: 10080` (7 days),
which silently held some packages one or more versions behind the newest
published release (e.g. TypeScript resolved to 6.0.3 instead of 7.0.2, `ai` to
7.0.18 instead of 7.0.19). The user did not recognise where that gate came from
and asked to **ignore it and use the most recent versions**.

## Constraints (from repo + global rules)

- Package management via `pnpm` only; never hand-edit `package.json`
  dependencies. (Note: the global `pnpm` 9.9.0 cannot parse this repo's
  workspace config keys — use `corepack pnpm`, which honours the pinned
  `packageManager` 11.1.2.)
- Keep documentation and tests aligned with the implementation.
- Do not violate or unilaterally change the specs in `docs/specs/`.
- Commit frequently in small, logically-scoped commits, staging files by name.
