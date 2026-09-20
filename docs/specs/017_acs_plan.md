# ACS integration plan

Add optional YAML configuration for a signed HTTP JSON-RPC client, one session per invocation, strict handshake negotiation, schema validation, and bounded timeouts. Preserve the `{ messages, context? }` input and apply enforcement across HTTP, CLI, and library entrypoints.

Guard incoming history/context, every executable tool, raw tool results before summarization, final response delivery, and compaction. Apply and validate modifications, collapse ask/defer to deny, let models recover from tool denials, and terminate for other denials or protocol failures. Buffer answers and suppress unreviewed content in events, errors, logs, and telemetry. Serialize Guardian exchanges per invocation, propagate cancellation, and attempt bounded lifecycle closure.

Use a pinned ACS v0.1 schema snapshot; document deployment signing conventions and known upstream inconsistencies rather than claim full ACS-Core conformance. Reject local human approvals with ACS enabled. Keep Guardian policy, approval orchestration, durable sessions, and control-plane services external.

Test against an HTTP mock Guardian: signatures and negotiation, lifecycle, modification and denial, error/cancellation paths, concurrent invocation isolation, output buffering, compaction and summary fallback. Update configuration/API documentation, example, and signing vectors; run tests, lint, typecheck, build, then commit and push scoped changes.
