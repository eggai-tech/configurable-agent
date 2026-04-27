# Consume mo as an npm workspace dependency

The `mo_run` tool in wally currently spawns the `mo` CLI as a
subprocess, which requires the core-agent image to bake in a separate
mo build stage and a shell wrapper at `/usr/local/bin/mo`. It also
means wally sees mo's output as opaque strings — no types.

Refactor to import mo programmatically as `@eggai-tech/mo` (published
to npmjs.com; paired spec mo/001). Inside this repo we pull it via
pnpm workspace so wally always builds against local mo source.

Scope:

- Turn the repo into a pnpm workspace (root
  `pnpm-workspace.yaml` + root `package.json`). Only `mo` and
  `wally` join the workspace; gaia packages stay outside.
- Add `"@eggai-tech/mo": "workspace:*"` to wally's dependencies.
- Rewrite `wally/src/agent/tools/mo.ts` to call `runEvals({...})`
  directly instead of spawning a subprocess. Hook `onProgress` so
  per-case events stream to the UI as `tool_output_chunk` events;
  emit the final `RunSummary` JSON as one chunk and as the tool
  result `content`.
- Collapse the two Dockerfiles that handle mo:
  - `wally/Dockerfile` — switch build context to repo root, pnpm
    workspace install, `pnpm deploy` for a flat runtime tree.
  - `gaia/core-agent/Dockerfile` — drop the mo-build stage; the
    `/usr/local/bin/mo` wrapper points at wally's
    `node_modules/@eggai-tech/mo` (same binary, one tree).

Paired mo spec: `mo/docs/specs/001_npm_library_export_*`.
