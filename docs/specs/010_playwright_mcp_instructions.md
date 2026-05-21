# 010 — Playwright MCP integration

> Add the Microsoft Playwright MCP (https://github.com/microsoft/playwright-mcp) as
> an MCP tool to the example configuration, and to docker-compose so the local
> stack ships with browser-automation tools out of the box.
>
> The full config schema lives in `descriptor.yaml` — use it as the source of
> truth for what's allowed in the example config.

## Notes captured during the conversation

- First attempt wired Playwright MCP via `transport: http` against
  `http://playwright-mcp:8931/mcp` (Streamable HTTP). MCP registry initialization
  succeeded (23 tools discovered) but every subsequent tool invocation failed
  with `HTTP 404: Session not found. This server does not support HTTP transport.
  Try using sse transport instead.` This is the AI SDK MCP client's hard-coded
  hint surfaced from `@ai-sdk/mcp@0.0.16`.
- Playwright MCP serves the streamable HTTP transport at `/mcp` and the legacy
  SSE transport at `/sse` on the same port. The SSE path is reliable with the
  AI SDK; the streamable path is flaky.
- The repo schema only allowed `transport: stdio | http`, so SSE could not be
  expressed without a small schema extension.
- Playwright MCP defaults to `Host: localhost:PORT` rejection — needs
  `--allowed-hosts=*` to accept Docker-network hostnames.
