# 010 — Playwright MCP integration (plan)

## Goal

Ship the Microsoft Playwright MCP as a first-class MCP server in the local
docker-compose stack and reference it from `example.config.yaml`, so the
out-of-the-box agent can drive a real browser.

## Decisions

- **Transport: SSE, not Streamable HTTP.**
  `@ai-sdk/mcp@0.0.16`'s Streamable-HTTP transport (`type: 'http'`) does not
  round-trip sessions correctly against Playwright MCP: connection + tool
  discovery succeed, but the first `tools/call` returns
  `HTTP 404: Session not found`. The error text itself recommends SSE, and
  Playwright MCP exposes `/sse` on the same port for exactly this reason.
- **Schema gets a third transport variant (`sse`).**
  The existing discriminated union (`stdio | http`) had no room for SSE.
  We add `McpSseServerSchema` (same shape as the HTTP variant: `url`,
  optional `headers`) and a third arm to the discriminated union. The
  transport string is forwarded verbatim to `@ai-sdk/mcp`'s
  `createMcpTransport`, which already supports both `'http'` and `'sse'`.
- **`--allowed-hosts=*` on Playwright MCP.**
  By default Playwright MCP rejects any `Host` header other than
  `localhost:PORT`, which breaks Docker service-name addressing. The flag
  disables that check; we pair it with `--host=0.0.0.0` to bind across
  interfaces and `--headless --isolated --browser=chromium` to keep the
  container ephemeral.

## Changes

| File | Change |
| ---- | ------ |
| `src/config/schema.ts` | Add `McpSseServerSchema`; extend `McpServerSchema` discriminated union to `[stdio, http, sse]`. |
| `src/agent/tools/mcp.ts` | In `createClientForServer`, forward `server.transport` (`'http' \| 'sse'`) as the transport `type` to `createMCPClient`. |
| `descriptor.yaml` | List `sse` in the `transport` enum and document the `/sse` URL form. |
| `tests/config.test.ts` | Add a YAML parsing test for the SSE variant. |
| `tests/mcp-tools.test.ts` | Add a discovery test asserting the SSE transport object is passed through to the MCP client unchanged. |
| `docker-compose.yml` | New `playwright-mcp` service using `mcr.microsoft.com/playwright/mcp:latest` with the flags above; `agent.depends_on` includes it so the fail-fast MCP registry build (`src/agent/tools/mcp.ts:19`) catches connectivity issues at startup. |
| `example.config.yaml` | Register `playwright` under `mcpTools` with `transport: sse` and `url: http://playwright-mcp:8931/sse`. |

## Verification

- `pnpm exec vitest run tests/config.test.ts tests/mcp-tools.test.ts` — green.
- `pnpm exec tsc --noEmit` — clean.
- `docker compose build agent && docker compose up -d` — agent boot log shows
  `tools: 23, servers: 1`.
- `curl -X POST http://localhost:3000/invoke -d '{"messages":[{"role":"user","content":"search the web for eggai and summarize"}]}'`
  — agent performs `browser_navigate` + `browser_snapshot` calls against Bing,
  GitHub, and docs.egg-ai.com, then returns a real summary citing
  repo stats from the live page (not training data).

## Out of scope

- Tuning the system prompt to prefer certain search engines (Google currently
  hits a CAPTCHA challenge; Bing works). Left to a follow-up if it becomes
  worth a special case.
- Exposing Playwright MCP behind authentication for non-local deployments. The
  current `--allowed-hosts=*` is appropriate inside the compose network but
  shouldn't be copied verbatim to a public deployment.
