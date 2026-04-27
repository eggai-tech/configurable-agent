# Repository rules for Claude

## Package management

- **Use `pnpm`, not `npm`.** All package commands (`install`, `add`, `remove`, `run`, `test`, etc.) go through `pnpm`.
- **Never edit `package.json` by hand to add/remove/upgrade dependencies.** Always use `pnpm add <pkg>` (or `pnpm add -D <pkg>` for dev deps) and `pnpm remove <pkg>`. This keeps `pnpm-lock.yaml` in sync and pins the correct resolved version.
