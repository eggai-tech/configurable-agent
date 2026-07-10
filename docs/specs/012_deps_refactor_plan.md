# 012 — Dependency upgrade, migration & code-quality pass (plan)

## Approach

Work in three phases on branch `chore/deps-refactor-2026-07`, verifying
`typecheck` + `test` + `lint` (and `build` for compiler bumps) after each group,
committing per logical step. A background review agent audited the pre-existing
code for bugs, error-handling/logging gaps, and smells; findings were triaged
against the specs before acting.

## Phase 1 — dependency upgrades & code migration

All dependencies upgraded to their newest published versions. `minimumReleaseAge`
removed from `pnpm-workspace.yaml` per the clarification.

### AI SDK v6 → v7 (`ai` 7.0.19, `@ai-sdk/*` 4.x/3.x/2.x)

Verified against the bundled migration guide in `node_modules/ai/docs`:

- `stepCountIs` → `isStepCount`.
- `StreamTextResult.fullStream` → `stream`.
- `experimental_telemetry` → `telemetry`; dropped the now-redundant
  `isEnabled: true` and the removed `metadata` field.
- Telemetry is no longer built into `ai`: install `@ai-sdk/otel` and call
  `registerTelemetry(new OpenTelemetry())` in `startTracing()` so the annotated
  model calls still emit spans.
- System messages inside `messages` are rejected by default in v7. The loop
  intentionally injects trusted, server-built system messages (base prompt +
  compaction summary; incoming system messages are stripped in
  `prepareMessages`), so `allowSystemInMessages: true` is set on the
  `streamText`/`generateObject` calls. Behaviour is unchanged.
- `@ai-sdk/mcp` v2 graduated `createMCPClient` / `MCPClient` out of
  `experimental_*`; imports and the test mock updated. HTTP transport now
  defaults `redirect: 'error'` (SSRF-safe) — kept the secure default.

### zod v3 → v4

- `z.record(value)` now requires an explicit key type: `z.record(z.string(), …)`.

### OpenTelemetry 1.x → 2.x

- `new Resource({...})` removed → `resourceFromAttributes()` merged onto
  `defaultResource()`.
- `SemanticResourceAttributes` → `ATTR_SERVICE_NAME` / `ATTR_SERVICE_VERSION`.

### Tooling

- TypeScript 5.7 → **7.0.2** (native compiler); typecheck + build pass unchanged.
- Biome 1 → 2: config migrated to the v2 format (`files.includes`,
  `rules.preset`); autofixes merged duplicate type imports and switched
  `Object.prototype.hasOwnProperty.call` → `Object.hasOwn`.
- Vitest 4.1, Vite 8, tsx 4.23, `@types/node` 26, msw 2.15, commander 15,
  pino 10, hono 4.12, and the remaining runtime deps to latest.

## Phase 2 — bugs, error handling, logging, cleanup

- **Version bug:** the CLI `--version` reported a hard-coded `0.1.0` while
  `package.json` was `0.2.1`, and `tracing.ts` hard-coded another literal.
  Single-sourced via `src/version.ts` (runtime `createRequire` read of
  `package.json`, which stays outside `rootDir`).
- **serve config load** now guarded: log + `shutdownTracing()` + `exit(1)`
  instead of throwing past the top-level handler and leaking the OTEL SDK.
- **MCP discovery failures** are wrapped with the offending server's name and
  transport (and `cause`); per-server connect/ready lifecycle is logged.
- **Graceful degradation:** tool-output summarization and context compaction
  fall back (head/tail truncation, drop-with-placeholder) on a summarizer
  outage rather than turning a successful tool call into an error or aborting a
  healthy run. Consistent with spec 009 ("summarized and marked truncated").
- **/invoke logging:** request-scoped start/finish logs with a request id and
  duration; the emit wrapper logs agent-level errors server-side (previously
  only visible to the SSE client) and swallows post-disconnect write failures
  instead of cascading.
- **Logging destination:** pino now writes to **stderr** so stdout stays
  reserved for the CLI `run` machine-readable record; this also made structured
  logging safe to add in modules shared by both CLI and serve modes.
- **De-duplication:** `safeJson` (×2) and `errorMessage`/`errMsg` consolidated
  into `src/util.ts`.
- **Dead code:** removed the unused `TextPart` / `Content` / `MessageContent`
  request schemas (incomplete — wiring them would wrongly reject valid
  multimodal content); `content` stays `unknown` with the AI SDK validating
  downstream. Named the summarizer input-char-limit constant.

### Deliberately not changed (rationale)

- The `ToolStatus` `denied`/`approval_required` values and `DeniedReason` are
  **spec-mandated** (spec 003); kept despite currently having no producer.
- `/ready` env-var check for `openai-compatible`/`ollama` left as-is: keyless
  endpoints are valid, so requiring `OPENAI_API_KEY` would break them.
- `final.truncated`, the two envelope constructors, per-step re-tokenization,
  and the MCP-seam casts are low value / behaviour- or contract-risky; left for
  a focused follow-up.

## Phase 3 — verification & PR

`typecheck`, `build` (tsc 7), the full `test` suite (78 passing, incl. new
summarization/compaction fallback tests), and `lint` all green. Removed a stray
`package-lock.json` (repo uses pnpm). Opened a PR from the branch.
