# Repository rules for Claude

## Package management

- **Use `pnpm`, not `npm`.** All package commands (`install`, `add`, `remove`, `run`, `test`, etc.) go through `pnpm`.
- **Never edit `package.json` by hand to add/remove/upgrade dependencies.** Always use `pnpm add <pkg>` (or `pnpm add -D <pkg>` for dev deps) and `pnpm remove <pkg>`. This keeps `pnpm-lock.yaml` in sync and pins the correct resolved version.

## Specs workflow

For any non-trivial task (feature, refactor, migration), persist both sides of the conversation as versioned specs in this repo's `docs/specs/` folder.

This checkout stores Configurable Agent specs at the repo root:

- all work in this repo → `docs/specs/`

Use a shared numeric prefix to pair the two files for the same task:

- `NNN_<slug>_instructions.md` — the user's original instructions (their request, verbatim or lightly cleaned).
- `NNN_<slug>_plan.md` — the plan Claude produced (from plan mode, or synthesized from the conversation).

Pick `NNN` as the next free number in `docs/specs/` (zero-padded to 3 digits). The slug should be short and descriptive (e.g. `approval_flow`, `standard_tool_output`).

When a task spans multiple repos or components, save one pair in each affected repo's own `docs/specs/` folder, using the same `NNN` and slug where possible so they're easy to correlate. In this repo, always write the local pair under `docs/specs/`.

## Commit cadence

Commit frequently while working — don't let a session end with one giant diff. Guidelines:

- After each logically complete step (new feature area, bug fix, refactor pass, spec file write-up), make a commit. Don't wait for the whole task to finish.
- Scope each commit tightly to the files related to that step. Do NOT sweep in unrelated pre-existing modifications that happened to be in the working tree — stage files by name, never `git add -A` / `git add .`.
- Follow the existing message style: `<component>: <short imperative subject>`, with a 1–3 sentence body explaining the *why*. Include the `Co-Authored-By` trailer on commits you author.
- Commit automatically as you finish each logically complete step — don't wait for the user to ask. The user wants a clean commit trail without having to prompt for it each time. Still stage files by name (never `git add -A`), still split into small logical commits, still leave unrelated pre-existing working-tree modifications alone, and still never push unless asked.
