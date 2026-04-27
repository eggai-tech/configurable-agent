# MCP follow-up instructions for coding agents

Read `CLAUDE.md` first and follow the repo rules there.

## Goal

Address three follow-up findings from the current MCP integration:

1. MCP tool conflicts should fail at startup, not per request.
2. Tool-output summarization must be restored for MCP tool results.
3. MCP test coverage needs to be expanded substantially.

This is an implementation task, not just a docs task. Make the code changes, add tests, and update any stale docs that describe the old behavior.

## Scope

Focus on these areas:

- `src/agent/tools/mcp.ts`
- `src/agent/loop.ts`
- `src/api/server.ts`
- `src/modes/serve.ts`
- `src/agent/safety/tool-summary.ts`
- `tests/mcp-tools.test.ts`
- `tests/loop.test.ts`
- `README.md`
- `example.config.yaml`

You may touch nearby files if the cleanest fix requires it, but keep the change tightly scoped to MCP startup validation, MCP tool-result summarization, and MCP tests.

## Task 1: Fail MCP conflicts at startup

### Problem

The spec says MCP name conflicts should fail at startup, but the current implementation builds MCP clients inside `runAgent()`. That means:

- conflicts are detected only when a request arrives
- broken MCP connectivity is discovered only at request time
- `/ready` can report healthy while the tool layer is unusable

### Required outcome

Move MCP discovery/validation out of the request path and into startup-time lifecycle management.

The service must validate configured MCP servers before it starts serving traffic. If tool discovery fails, the process should fail startup rather than accept requests and error later.

### Constraints

- Do not keep the current "build tools on every request" behavior.
- Do not implement a `/ready`-only check and call that sufficient. The finding is specifically about startup failure.
- Preserve cleanup on shutdown.
- Keep the design understandable. Avoid introducing a large abstraction tree unless it materially improves lifecycle handling.

### Acceptance criteria

- Tool name conflicts across servers fail before the server starts accepting requests.
- MCP discovery failures also fail startup.
- The resolved tool registry is reused across requests.
- Shutdown still closes MCP clients cleanly.
- The behavior is covered by automated tests.

## Task 2: Restore tool-output summarization for MCP results

### Problem

`maybeSummarizeToolOutput()` still exists, but MCP tool results emitted from the loop are not passing through it. The config and README still claim large tool outputs are summarized, but the loop currently emits the raw MCP result envelope.

### Required outcome

Restore tool-output summarization for MCP tool results so that oversized results are reduced before they are appended to conversation history and before downstream reasoning steps consume them.

### Important requirement

Do not implement summarization as a UI-only transform. The summarized version must be what the model sees on the next step, otherwise the safety feature is mostly cosmetic.

### Constraints

- Reuse the existing summarization helper if possible instead of creating a second summarization path.
- Preserve the existing envelope-based contract with `truncated: true`.
- Do not reintroduce a separate `tool_result_truncated` event unless there is a strong reason and the rest of the codebase is updated consistently. The current codebase already trends toward envelope-based truncation.
- Update stale docs so the documented behavior matches the implementation.

### Acceptance criteria

- Small MCP tool outputs pass through unchanged.
- Large MCP tool outputs are summarized using the configured thresholds.
- The result emitted to clients includes `truncated: true`.
- The summarized form, not the raw oversized form, is what the next reasoning step receives.
- The behavior is covered by automated tests.

## Task 3: Expand MCP tests

The current MCP-specific test coverage is too shallow. Add direct tests for the MCP builder/lifecycle and at least one loop-level test proving summarization behavior.

## Scenarios to test

Implement a clear set of tests covering these scenarios:

1. Empty config:
   `buildMcpTools()` returns an empty tool set and cleanup succeeds.

2. Successful stdio discovery:
   a configured stdio server is connected, its tools are discovered, and the returned tool map includes the expected tool names.

3. Successful HTTP discovery:
   a configured HTTP MCP server is connected, its tools are discovered, and the returned tool map includes the expected tool names.

4. Duplicate tool names across servers:
   startup validation fails with a clear error when two servers expose the same tool name.

5. Stdio startup/discovery failure:
   startup validation fails if a configured stdio server cannot be started or cannot complete tool discovery.

6. HTTP startup/discovery failure:
   startup validation fails if a configured HTTP server cannot be reached or cannot complete tool discovery.

7. Cleanup behavior:
   closing the MCP registry/client layer does not throw and closes all discovered clients, even if one close call fails.

8. Small tool result passthrough:
   a tool result below the summarization threshold is emitted unchanged and is not marked truncated.

9. Large tool result summarization:
   a tool result above the threshold is summarized, includes head/tail excerpts, and is marked `truncated: true`.

10. Summarized history, not raw history:
    prove that the agent loop carries the summarized tool output into the next model step instead of the original oversized result.

11. Startup-time validation wiring:
    prove the service startup path validates MCP configuration before serving requests. A broken or conflicting MCP config should fail startup rather than wait for `/invoke`.

12. No per-request MCP rebuild:
    prove the validated/shared MCP tool layer is reused rather than recreated for each invocation.

## Implementation notes

- If the cleanest design is to introduce a small startup-owned MCP registry object, do that.
- If you need test doubles for MCP clients/transports, keep them local to the test suite and avoid coupling tests to internal implementation details more than necessary.
- Prefer deterministic unit/integration tests over brittle end-to-end process tests.
- Use `pnpm` for any package command.

## Deliverables

- Code changes implementing startup-time MCP validation and reuse.
- Code changes restoring MCP tool-output summarization in the real loop path.
- New/updated tests covering the scenarios above.
- README and config example updates if behavior or event semantics changed.

## Verification

At minimum, run:

```bash
pnpm test
pnpm typecheck
```

If you add or change docs describing SSE events or tool truncation semantics, make sure they match the actual emitted events and envelopes.
