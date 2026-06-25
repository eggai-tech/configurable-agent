# 011 — Harvest MCP mock — plan

## Goal

A local mock of the Harvest MCP server that the agent can talk to over the same
`http` transport it uses for the real server, serving data from a JSON fixture so
that invoice-validation scenarios can be exercised without hitting Harvest.

## How the agent connects to MCP (relevant code)

- `src/agent/tools/mcp.ts` → `createClientForServer()` builds an `@ai-sdk/mcp`
  client. For `transport: http` it uses the **Streamable HTTP** transport
  (`{ type: 'http', url, headers }`).
- `src/config/load.ts` → `expandEnvVars()` expands `${VAR}` in *any* config string,
  including `url`. This is the switch point: make the Harvest `url` env-driven.

### Streamable-HTTP client behaviour (from `@ai-sdk/mcp` 1.0.46)

- On connect it does a best-effort `GET` for an inbound SSE stream. A `405` is
  treated as "no inbound stream" and ignored → the mock answers `GET` with `405`.
- Requests are `POST` JSON-RPC with `Accept: application/json, text/event-stream`.
  The mock always replies with `Content-Type: application/json` and a single
  JSON-RPC response object — no SSE framing needed.
- Latest protocol version advertised by the client is `2025-11-25`; supported set
  also includes `2025-06-18`, `2025-03-26`, `2024-11-05`. The `initialize` result
  must echo a version in that set → mock echoes the requested version if supported,
  else falls back to `2025-06-18`.
- `DELETE` is sent on close → mock answers `200`.

## Deliverables

1. **`examples/harvest/harvest-mock.mjs`** — zero-dependency `node:http` Streamable-HTTP MCP
   server. Implements `initialize`, `notifications/*`, `ping`, `tools/list`,
   `tools/call`. Tools: `list_users`, `list_projects`, `list_time_entries`, with the
   real filtering semantics:
   - `list_projects`: `search` matches `name`/`code`/`client_name` (case-insensitive,
     substring). Also `is_active` filter.
   - `list_time_entries`: filters by `project_id`, `user_id`, and `from`/`to` on
     `spent_at` (inclusive). Sorted by `spent_at` desc, like the real API.
   - `list_users`: returns all users; optional `is_active` filter.
   Env: `HARVEST_FIXTURE` (path, default `examples/harvest/fixture.json`),
   `PORT` (default `8765`), `HARVEST_MOCK_LATENCY_MS` (optional simulated latency).
   The fixture is re-read on every request so scenarios can be edited live.

2. **`examples/harvest/fixture.json`** — default scenario built from the provided SSE
   dump: the two projects, Gianpaolo's May-2026 time entries, and a populated `users`
   list (the real run returned 0 users, but a populated list is the more useful
   default — documented in the file's `_comment`).

3. **`examples/harvest/harvest-record.mjs`** — SSE-dump → fixture generator. Reads a file (or
   stdin) of `event: tool_call` / `event: tool_result` lines, extracts
   `users`/`projects`/`time_entries` from the recorded results, de-duplicates by `id`,
   and writes a fixture. If `list_users` recorded nothing, it derives `users` from the
   `user_id`/`user_name` present on time entries so the output is immediately usable.

4. **Config wiring** — `examples/harvest/config.yaml` `url` → `${HARVEST_MCP_URL}`.
   `.example.env` / `.env` gain `HARVEST_MCP_URL`, defaulting to the real Harvest URL;
   set it to `http://localhost:8765/mcp` to use the mock. Auth headers stay (the mock
   ignores them; dummy values satisfy `expandEnvVars`).

5. **Docs** — `examples/harvest/README.md` gains a "Mock" section.

## Out of scope

- No source changes to the agent itself — the mock plugs in purely via config/env.
- No write tools (`create_time_entry`, …); only the read tools the prompt uses.
