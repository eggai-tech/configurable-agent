# Plan — Consume mo as an npm workspace dependency

## Context

We want wally to depend on `@eggai-tech/mo` as a regular npm package
rather than a subprocess. Single node_modules tree in the core-agent
image, real types for `RunSummary`, and the CLI stays for manual use.

## Changes

### 1. Workspace skeleton

New at the repo root:

**`pnpm-workspace.yaml`**
```yaml
packages:
  - mo
  - wally
```

**`package.json`**
```json
{
  "name": "platform-poc",
  "private": true,
  "packageManager": "pnpm@10.30.2",
  "engines": { "node": ">=22" }
}
```

Delete `mo/pnpm-lock.yaml` and `wally/pnpm-lock.yaml`. A single
`pnpm-lock.yaml` at the repo root replaces them after
`pnpm install`.

Gaia packages (`gaia/backend`, `gaia/ui`) stay outside the workspace —
they don't import mo or wally as npm deps and already have their own
lockfiles.

### 2. Wally package.json

Add `"@eggai-tech/mo": "workspace:*"` to `dependencies`. pnpm resolves
this to the local `mo/` during install; publish tooling (if anyone
ever publishes wally) rewrites it to the concrete version.

### 3. Rewrite `wally/src/agent/tools/mo.ts`

Before: spawn subprocess, capture stdout/stderr, parse JSON at close.
After: import and call `runEvals`.

```ts
import { runEvals, type RunProgressEvent, type RunSummary } from '@eggai-tech/mo';
```

Key loop:
- Hook `onProgress`:
  - `case_start` → emit a `tool_output_chunk` with `▶ <name>\n`.
  - `case_finish` → `✓ <name> (Xms)\n` on pass, `✗ <name> (Xms): <error>\n` on fail.
- Run it:
  ```ts
  const summary: RunSummary = await runEvals({
    configPath: args.configPath,
    filter: args.filter,
    concurrency: args.concurrency,
    onProgress: async (ev) => { await streamChunk(renderEvent(ev)); },
  });
  ```
- After resolution: pretty-print the summary as JSON, emit it as a
  final `tool_output_chunk` (so the UI renders the summary in the
  same pre), emit `tool_stream_end`, and return the JSON as
  `ToolResult.content`.

Error handling:
- `runEvals` throwing (bad env, missing evals dir, config parse
  failure) → `status: 'error'`, content = error message.
- Per-case errors are inside the returned `RunSummary` — overall
  status stays `'succeeded'`, the model reads
  `.cases[].error` and `.totals.errored`.
- AbortSignal: if `runEvals` accepts one (check during implementation),
  pass `opts.abortSignal`. If it doesn't, raise a small follow-up
  with mo; for now the tool loses abort support on its mo call
  (acceptable for the POC).

No more timer; the wally agent loop's abortSignal is the single
cancellation surface.

### 4. Dockerfiles

**`wally/Dockerfile`** — build context moves to the repo root.

Rewrite:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS workspace-deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY mo/package.json ./mo/
COPY wally/package.json ./wally/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter wally... --filter @eggai-tech/mo...

FROM workspace-deps AS build
COPY mo ./mo
COPY wally ./wally
RUN pnpm --filter @eggai-tech/mo build \
 && pnpm --filter wally build
# Flatten wally + its workspace deps into a publish-ready tree.
RUN pnpm --filter wally deploy --prod /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_PATH=/etc/wally/config.yaml
COPY --from=build /out /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js", "serve"]
```

`pnpm deploy` is the key move: it produces a flat `node_modules`
tree with `@eggai-tech/mo` resolved from the workspace, so we don't
need pnpm at runtime.

Build command changes from `docker build wally/` to
`docker build -f wally/Dockerfile .` at the repo root.

**`gaia/core-agent/Dockerfile`** — strip the mo-build stage.

Before: a `mo-build` stage + COPY-from + a `/opt/mo` tree.
After: `FROM ${WALLY_IMAGE}` already contains mo at
`/app/node_modules/@eggai-tech/mo`. The CLI wrapper just points
there:

```dockerfile
RUN printf '#!/bin/sh\nexec node /app/node_modules/@eggai-tech/mo/dist/index.js "$@"\n' \
      > /usr/local/bin/mo \
 && chmod +x /usr/local/bin/mo \
 && mo --version
```

Everything else (kubectl, helm, wally wrapper) stays.

## Files

**New**
- `pnpm-workspace.yaml`
- `package.json` (root)

**Modified**
- `wally/package.json` — add `@eggai-tech/mo` dep.
- `wally/src/agent/tools/mo.ts` — rewrite to use import.
- `wally/Dockerfile` — repo-root context, pnpm workspace install,
  pnpm deploy for runtime.
- `gaia/core-agent/Dockerfile` — drop mo-build stage, point wrapper
  at wally's node_modules.

**Deleted**
- `mo/pnpm-lock.yaml`
- `wally/pnpm-lock.yaml`

## Verification

1. `pnpm install` at repo root generates root `pnpm-lock.yaml` and
   `wally/node_modules/@eggai-tech/mo` symlink to `mo/`.
2. `pnpm --filter @eggai-tech/mo build` emits declarations.
3. `pnpm --filter wally build` type-checks with the real runEvals
   signature (no `any`).
4. Existing `mo` CLI path still works:
   `pnpm --filter @eggai-tech/mo exec mo --help`.
5. `docker build -f wally/Dockerfile -t wally:dev .` from repo root
   succeeds; `/app/node_modules/@eggai-tech/mo/dist/` is present.
6. `docker build -f gaia/core-agent/Dockerfile -t gaia-core-agent:dev .`
   succeeds; `mo --version` runs inside the built image.
7. Runtime smoke: `pnpm --filter wally start` with a test config
   that enables `moRun`, trigger a tool call, confirm per-case
   progress streams + final JSON arrives.
8. Core-agent config.yaml still validates against wally's schema
   (unchanged since the previous round).
