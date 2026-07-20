# 015 — Remove the local token estimator (plan)

## Principle

Nothing in the codebase estimates tokens anymore. The only consumer that
genuinely needs a token count — the compaction trigger — now uses the number
the provider itself reported; every other consumer needed a *size* gate, and
characters are exact.

## Changes

- **`src/agent/safety/tokens.ts` deleted.** `stringifyMessageContent` (still
  needed to build the compaction summary prompt) moved into `compaction.ts`,
  its only consumer.
- **Compaction triggers on real usage** (`src/agent/loop.ts`,
  `src/agent/safety/compaction.ts`): `prepareStep` receives the prior steps
  from the SDK; `steps.at(-1)?.usage.inputTokens` — the provider-counted size
  of the previous step's prompt — is passed to `maybeCompactMessages` as
  `lastInputTokens` and compared against `safety.compaction.triggerTokens`.
  The config key keeps its name and default (100 000) but now means what it
  says. Consequences, accepted by design:
  - Compaction never fires before the first step (nothing has been sent yet),
    so an oversized *incoming* history is the provider's to reject — "rely on
    real API responses" taken seriously.
  - The gate is one step stale (usage describes the previous prompt, not the
    tool results appended since). Irrelevant at 100k-vs-200k headroom.
  - Providers that report no usage never compact. All five supported
    providers report usage.
- **Tool-output gate is chars-based** (`src/agent/safety/tool-summary.ts`):
  `safety.toolOutput.triggerChars` (default **16 000**) replaces
  `toolOutput.triggerTokens` (default 4 000 pseudo-tokens = 16 000 chars —
  the same effective threshold, so behavior is unchanged). The old key was
  fake precision: it was chars/4 wearing a token costume.
- **Events report exact sizes**: `SizeSnapshot` is now
  `{ messages: number; chars: number }` (was `{ tokens, messages }` with
  estimated tokens).

## Breaking-change notes

- YAML configs using `safety.toolOutput.triggerTokens` fail at startup with a
  clear strict-schema error (better than silently reinterpreting the number).
- Lib consumers (QualOps adapter hardcodes the safety block) get a
  compile-time error on upgrade; the fix is a one-line rename.
- `compaction_start`/`compaction_finished` payloads changed shape.

## Tests

- `tests/compaction.test.ts`: gate driven by `lastInputTokens` (under-trigger,
  over-trigger, and usage-unavailable cases); event assertions on exact chars.
- `tests/loop.test.ts`: new end-to-end test through the real SDK — the mock
  model reports `inputTokens: 5`, `triggerTokens: 4` fires compaction in
  `prepareStep` of step 2; asserts step 1 saw verbatim history, step 2 saw the
  summary, tool-call/result pairing survived, and events carry exact sizes.
- Fixtures across the suite renamed to `triggerChars`.

## Out of scope (tracked findings from the compaction analysis)

Tool-output `mode: summarize | truncate | off` + per-tool rules, a dedicated
cheap summarizer model, a cap on the compaction summarizer's own input,
re-trigger hysteresis, and summary memoization — to be specced separately if
wanted.
