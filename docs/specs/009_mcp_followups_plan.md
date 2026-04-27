# Plan: MCP startup validation, summarization restoration, and test coverage

## Objectives

1. Validate/discover MCP tools during service startup, not during each request.
2. Restore real tool-output summarization for MCP results before they are fed back into the model.
3. Add meaningful MCP tests around discovery, conflicts, failures, cleanup, and summarization.

## Recommended approach

### 1. Introduce a startup-owned MCP registry

Create a small lifecycle object that:

- builds MCP clients from `config.mcpTools`
- discovers tool definitions once
- detects duplicate tool names during startup
- exposes the resolved tool map for reuse by `runAgent()`
- provides `cleanup()` for shutdown

The startup path should initialize this registry before the HTTP server begins serving traffic. If initialization fails, startup should fail immediately.

Possible shape:

- `src/agent/tools/mcp.ts`
  - keep `buildMcpTools()` or rename it to something lifecycle-oriented
  - return a reusable registry/toolset object
- `src/modes/serve.ts`
  - initialize the registry before `serve(...)`
  - wire cleanup into shutdown
- `src/api/server.ts`
  - accept the prebuilt tool registry or tool map instead of making `runAgent()` rebuild it
- `src/agent/loop.ts`
  - consume injected tools instead of constructing them

### 2. Restore summarization in the real MCP execution path

Current issue: the loop wraps tool outputs into envelopes, but does not route them through `maybeSummarizeToolOutput()`.

Important detail: the summarized output must be what is appended to the message history for the next step. If the raw tool result stays in `response.messages`, the safety feature is incomplete.

Recommended direction:

- wrap MCP tools at creation time so each tool's `execute()` returns the final envelope after summarization
- keep `label`, `status`, `args`, `duration_ms`, and `truncated` in the returned envelope
- ensure the loop emits that same envelope to SSE

This is preferable to trying to patch `response.messages` after `streamText()` has already recorded the raw tool result.

### 3. Tighten docs to the implemented contract

The repo currently has stale docs around tool truncation. Bring the docs back in line with the actual event model:

- if truncation is represented only as `tool_result.output.truncated`, document that
- remove references to events that are no longer emitted

## Test plan

### MCP builder / registry tests

- empty config returns empty tools and cleanup succeeds
- stdio server discovery succeeds
- HTTP server discovery succeeds
- duplicate tool names fail with a clear error
- stdio startup/discovery failure surfaces as startup failure
- HTTP startup/discovery failure surfaces as startup failure
- cleanup closes all clients and tolerates close errors

### Loop / summarization tests

- small tool output is passed through unchanged
- large tool output is summarized and marked truncated
- the next model step receives the summarized content, not the raw content

### Startup wiring tests

- startup initialization runs before the service begins serving
- broken/conflicting MCP config fails startup
- validated MCP tools are reused across multiple invocations rather than rebuilt per request

## Risks

- AI SDK MCP tool objects may need wrapping carefully so input schemas and execute behavior remain intact.
- Startup-owned clients change lifecycle semantics; shutdown and test cleanup need to stay robust.
- It is easy to make summarization visible in SSE while still leaving raw tool data in model history. Guard specifically against that regression.

## Done criteria

- MCP conflicts and discovery failures fail startup.
- Tool registry is shared across requests.
- Oversized MCP tool results are summarized before the next reasoning step.
- Tests cover the key success and failure paths.
- README/example config match the implemented behavior.
