# 011 — Harvest MCP mock — instructions

## Original request (lightly cleaned)

The configuration of this agent includes an integration with the Harvest MCP server.
I want to integrate a mock to test various scenarios.

The mock must pull its data from a JSON file in the `examples/harvest` folder. At the
end of the process this file is generated, which I will (perhaps) feed as input to the mock.

All the calls that the MCP makes have been provided, taken from the agent's SSE output
(`event: tool_call` / `event: tool_result`). The observed tool calls are:

- `list_users` → `{ users, total_count, limit, truncated }`
- `list_projects` with `search` → `{ projects, total_count, limit, truncated }`
- `list_time_entries` with `project_id`, `from`, `to` → `{ time_entries, limit, truncated, next_cursor, scope_limited }`
- (plus `todowrite`, which is an internal tool of the agent, not MCP)

## Decisions made (via questions)

1. **Fixture format**: raw dataset (`users`, `projects`, `time_entries`) + filtering
   logic implemented in the mock. Maximum flexibility to build scenarios by editing
   the dataset.
2. **Transport**: `http` — the mock is a separate HTTP server (like the real Harvest),
   the agent connects to it via `url`.
3. **Generator**: yes — include a script that parses an SSE dump from the agent and
   produces the fixture in the mock's format.
