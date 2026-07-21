# 010 — Harvest MCP integration & auth

## User request (verbatim / lightly cleaned)

> How can I add this MCP and make it work with authentication?
> https://support.getharvest.com/hc/en-us/articles/46293697226381-Harvest-MCP
>
> I want to add it to this project (configurable agent), via the
> configuration file (`config.yaml`). Use these headers:
> - `Harvest-Account-ID: 2029314`
> - `Authorization: Bearer <PAT>`
> - `User-Agent: configurable-agent`

Follow-up questions during the session:

- Can the current API accept a file as input to give to the agent?
- What command starts the server?
- Error: `Token was not issued for the MCP server. Re-authorize via Claude Code
  (or your MCP client) with the MCP scope.` → I created an OAuth app in Harvest,
  generate a node script for me covering the whole flow (client id/secret + redirect
  `http://localhost:3000`).
- Error `ZodError ... expected object, received null` at startup
  (`mcp registry initialization failed`) → update all `@ai-sdk` and `ai` packages
  to the latest versions.
