# 014 — Deep review: complexity reduction, OTel log correlation, PII hardening (instructions)

## Original request

Follow-up on the `chore/deps-refactor-2026-07` PR. Do a real deep code review and
full analysis:

- Reduce as much complexity as possible; replace custom code logic with AI SDK
  built-in functions (and features of other installed dependencies) wherever an
  equivalent exists.
- Align the logger with OpenTelemetry: JSON logs carrying OTel fields so log
  lines can be correlated with traces.
- Find and fix bugs, performance and stability issues.
- Ensure proper logging and error handling; prevent leaking confidential or PII
  data.
- Remove bloat and unnecessary code comments.
- Spec updates are allowed where there is unclarity, gaps, or missing pieces.
  Functional completeness must be preserved; the *how* of the implementation is
  free to change as long as the expected functionality stays intact.
- Goal: the PR ends up clean, reduced, production-ready, without gaps or issues.
- Multiple agents, model and reasoning choice at Claude's discretion.

## Process notes

- A multi-agent review workflow (research of the installed AI SDK v7 API surface
  from `node_modules` docs/types, a spec-requirements map over specs 001–013,
  and three review dimensions) produced 43 raw findings; 21 survived adversarial
  verification, 3 were refuted, and several "keep as is" verdicts (Handlebars,
  ajv, the glob matcher, `/ready?deep=1` semantics) were recorded.
- Every dependency-API claim was verified against the installed packages, not
  from memory.
