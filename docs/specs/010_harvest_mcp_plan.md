# 010 — Harvest MCP integration & auth — plan / outcome

## Context

Harvest ships an official remote MCP server at `https://api.harvestapp.com/mcp`
(streamable HTTP transport). The configurable-agent supports remote MCP servers
via `mcpTools[].transport: http` with a `url` and **static** `headers` only
(`src/config/schema.ts`, `src/agent/tools/mcp.ts`). It connects to all MCP
servers headlessly at startup — there is no interactive OAuth flow.

## Authentication findings

- A Harvest **Personal Access Token (PAT)** works for the classic API v2 but is
  **rejected by the MCP endpoint**: `Token was not issued for the MCP server`.
- The MCP endpoint is an OAuth-protected resource. Discovered via standard
  metadata:
  - `https://api.harvestapp.com/.well-known/oauth-protected-resource/mcp`
    → `resource: https://api.harvestapp.com/mcp`, auth server `https://id.getharvest.com`.
  - `https://id.getharvest.com/.well-known/oauth-authorization-server`
    → authorize `https://id.getharvest.com/oauth2/authorize`,
      token `https://id.getharvest.com/api/v2/oauth2/token`,
      grants `authorization_code` + `refresh_token`, `client_secret_post`, PKCE S256.
- The key is the **RFC 8707 resource indicator**: requests must include
  `resource=https://api.harvestapp.com/mcp` so the issued token is scoped to the
  MCP server. ("MCP scope" in the error = the resource/audience, not a scope string.)

## What was done

1. **config.yaml** — added the `harvest` HTTP MCP server with the OAuth Bearer
   token in `headers` (token obtained out-of-band, see below). `config.yaml` is
   **not** committed (contains a live token).

2. **scripts/harvest-oauth.mjs** — standalone Node helper (built-ins only) that
   runs the full authorization-code + PKCE flow: local server on
   `http://localhost:3000` to catch the redirect, token exchange with the
   `resource` indicator, then an MCP `initialize` smoke test that prints the
   ready-to-paste `Authorization: "Bearer ..."` line. Gitignored (holds secret).

3. **Dependency upgrade** — startup failed with a `ZodError` (`expected object,
   received null`) inside `@ai-sdk/mcp@0.0.16`'s streamable-HTTP transport: it
   tried to parse the empty/null body Harvest returns when ack'ing the
   `notifications/initialized` notification. Upgraded the whole AI SDK family to
   latest majors:
   - `ai` 5 → 6, `@ai-sdk/mcp` 0 → 1, `@ai-sdk/{anthropic,google,openai,
     openai-compatible}` and `@ai-sdk/provider` to latest.
   - `@ai-sdk/mcp@1` adds `const isNotification = !("id" in message); if
     (isNotification) return;` before parsing — fixing the crash.
   - Migrated test mocks to the V3 language-model spec: `MockLanguageModelV3`,
     structured `LanguageModelV3Usage`, object-form `LanguageModelV3FinishReason`.
   - `src/` needed no changes (the `experimental_*` MCP aliases still exist).
   - Result: typecheck clean, 70/70 tests pass, lint clean, build OK.

## Known limitations / follow-ups

- The OAuth **access token in `config.yaml` expires** (`expires_in`). The static
  headers have no refresh logic, so the token must be regenerated (re-run the
  script, or exchange the `refresh_token`) when it lapses.
- Proper fix for an always-on service: add OAuth (authorization_code +
  persisted refresh_token, auto-refreshing bearer) to the HTTP MCP transport, or
  run a sidecar OAuth proxy. Not implemented in this task.

## Side answers

- **File input to the agent:** no upload endpoint. `POST /invoke` takes JSON
  `{messages:[{role,content}]}`; `content` is `z.unknown()` and passed straight
  to the AI SDK as `ModelMessage[]`, so file/image content parts can be inlined
  (base64/URL) if the model supports them — but this is unvalidated, not a
  designed feature.
- **Start the server:** `serve` subcommand. Dev:
  `CONFIG_PATH=./config.yaml ANTHROPIC_API_KEY=... pnpm dev serve`; built:
  `pnpm build && CONFIG_PATH=./config.yaml ANTHROPIC_API_KEY=... pnpm start`.
  Env: `CONFIG_PATH` (default `/etc/configurable-agent/config.yaml`), `PORT`
  (3000), and the provider key (`ANTHROPIC_API_KEY`).
