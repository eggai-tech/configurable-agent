## Harvest oauth integration

1. copy and fill the example env file

2. create an oauth app in harvest
https://id.getharvest.com/developers

3. set the oauth client id and secret in the .env file

4. get the harvest oauth token
```
dotenv -e examples/harvest/.env -- node examples/harvest/harvest-oauth.mjs
```
authorize the app and copy the env var values printed out in the server logs

5. set the token and the account id in the env file

## Mock Harvest MCP server

For testing invoice-validation scenarios without hitting the real Harvest API, a
local mock is provided that speaks the same Streamable-HTTP MCP protocol the agent
uses for `transport: http`. The agent connects to it purely via config/env — no
source changes.

The Harvest `url` in `config.yaml` is `${HARVEST_MCP_URL}`. Switch targets in `.env`:

- real Harvest: `HARVEST_MCP_URL=https://api.harvestapp.com/mcp`
- local mock:   `HARVEST_MCP_URL=http://localhost:8765/mcp`

When using the mock, `HARVEST_ACCESS_TOKEN` / `HARVEST_ACCOUNT_ID` can be any
non-empty placeholder (the mock ignores auth).

### Run the mock

```
node scripts/harvest-mock.mjs
# or with a different scenario / port:
HARVEST_FIXTURE=examples/harvest/scenario.json PORT=8765 node scripts/harvest-mock.mjs
```

It serves `list_users`, `list_projects`, `list_time_entries` from a JSON fixture
(default `examples/harvest/fixture.json`), applying the real filtering semantics
(`search`, `project_id`/`user_id`, `from`/`to` date range). The fixture is re-read
on every request, so you can edit it live to build new scenarios.

### Fixture format

```json
{
  "users":        [{ "id": 5468895, "first_name": "Gianpaolo", "name": "...", "is_active": true }],
  "projects":     [{ "id": 47229968, "name": "...", "code": "XXA002", "client_name": "EggAI", "is_active": true }],
  "time_entries": [{ "id": 1, "spent_at": "2026-05-04", "hours": 8.0, "user_id": 5468895, "project_id": 47229968, "billable": true }]
}
```

### Generate a fixture from a real run

Capture the agent's SSE output (the `event: tool_call` / `event: tool_result`
lines) from a run against the real Harvest, then turn it into a fixture:

```
node scripts/harvest-record.mjs run.sse > examples/harvest/scenario.json
# or from the clipboard:
pbpaste | node scripts/harvest-record.mjs > examples/harvest/scenario.json
```

It extracts the data returned by the Harvest tools, de-duplicates by id, and (if
`list_users` returned nothing) derives the user list from the time entries so the
output is immediately usable by the mock.
