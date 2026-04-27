# Make tool calls from the core agent more legible

The user's complaint: tool-output streaming from wally to the gaia UI "doesn't
work great." After investigation, the actual issue is how the core agent
composes tool calls, not the streaming layer.

Two symptoms:

1. **Critical output is hidden inside shell scripts.** The core agent runs
   mo via bash like `mo run --config ... --json > /tmp/mo-result.json`, then
   inspects the file with jq. The JSON (the most informative artifact)
   never reaches stdout, so the UI only shows the jq summaries.

2. **Every bash command starts with `set -eu`,** so the tool card's
   at-a-glance preview is dominated by boilerplate rather than what the
   call is actually about.

Scope for wally:

- Add a dedicated `mo_run` tool that streams mo's JSON as
  `tool_output_chunk` events (so the user sees it live) and returns a
  parsed envelope (so the model can reason on totals directly, no jq).
- Add an `intent: string` field to every tool's input schema. The model
  fills it with a short "why" that the UI renders under the tool-card
  header. Durable legibility for all tools, not just mo.
- While we're here, fix two pre-existing bugs in `bash.ts`:
  - `tool_output_chunk` emits are fire-and-forget (`void emit(...)`).
    Should be `await emit(...)` like every other call site.
  - UTF-8 decoder tail bytes are counted in `totalBytes` but never
    emitted as a final chunk before `tool_stream_end`.

Dedicated tools are only for first-party binaries with stereotyped usage
(`mo`). Do NOT generalize the pattern to git / kubectl / jq.

Paired gaia spec: `gaia/docs/specs/015_tool_call_legibility_*`.
