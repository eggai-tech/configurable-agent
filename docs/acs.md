# ACS Guardian integration

Configurable Agent can act as an observed agent for an external [Agent Control Standard](https://agentcontrolstandard.org/) Guardian. The Guardian owns policy evaluation and audit-chain storage. The agent sends observations, applies decisions, and executes permitted work.

## Configuration

Add an `acs` block to the YAML configuration:

```yaml
acs:
  guardianUrl: https://guardian.example.com/acs
  agentId: configurable-agent
  keyId: production-agent-key
  secretEnv: ACS_SHARED_SECRET
  timeoutMs: 10000

safety:
  approval:
    mode: none
```

`guardianUrl`, `agentId`, `keyId`, and `secretEnv` are required. `secretEnv` is the **name** of an environment variable containing the shared UTF-8 secret; supply its value to both deployments through secret management. `timeoutMs` defaults to 10,000 and accepts positive integers up to 300,000. Each negotiated timeout is capped at this value. HTTP and HTTPS are supported; use HTTPS across untrusted networks. Redirects and automatic retries are disabled. Request and response envelopes are bounded at 10 MiB.

ACS is enabled whenever the block is present. Without it, runs use the configured local safety settings. ACS configurations require `safety.approval.mode: none`. A missing secret refuses execution with `acs_configuration_error`.

See [example.acs.config.yaml](../example.acs.config.yaml) for a complete configuration.

## Invocation and decisions

The input for HTTP, CLI, and library runs is:

```json
{
  "messages": [{ "role": "user", "content": "What should we do today?" }],
  "context": { "weather": "sunny" }
}
```

A fresh ACS session is created for each invocation. For HTTP, its UUID equals the response's `x-request-id`. Library callers may supply a unique UUID through `RunAgentOptions.sessionId`; otherwise the runtime generates one. Sessions do not persist between requests.

| Guardian decision | Agent behavior |
| --- | --- |
| `allow` | Proceed with the checked operation. |
| `modify` | Apply the edits, validate the resulting payload, and proceed. |
| `deny` | Block the operation. |
| `ask` | Apply `deny` immediately. |
| `defer` | Apply `deny` immediately. |

A denied tool request never executes. A denied tool result never reaches the reasoning model, summarizer, or client. Both cases produce a generic `tool_result` with `status: denied` and `denied_reason: policy_deny`, so the model can try another permitted approach within `agent.maxSteps`.

Denials at other enforcement points end the invocation with `acs_denied`. Invalid modification instructions also count as denials. Transport failures and timeouts end the invocation with `acs_unavailable`; invalid signatures, envelopes, versions, and response IDs produce `acs_protocol_error`. A failure cannot turn into an allowed operation or a recoverable tool result.

No approval requests, resume operations, or deferred polling run in ACS mode. Incoming tool-approval request/response history is rejected. Session and turn closure are attempted on success, failure, and cancellation, with at most one second per closure request. A closure failure is logged and does not retract an approved answer. Cancellation prevents further dispatch and signals in-flight work; effects from already executed tools cannot be rolled back.

## Client events and telemetry

Progress events continue during execution. Tool events are emitted after the relevant check, and tool-call arguments reflect the values actually passed to the executor. Denied operations expose no blocked arguments or output.

Answer text is buffered until `steps/agentResponse` permits delivery. Text mode emits one approved `content_delta` followed by `final`; structured mode emits the approved, schema-validated object in `final.structured`. Raw reasoning and intermediate assistant text are not streamed. Error events contain no unreviewed partial answer or provider diagnostics.

The `acs_decision` event records enforcement decisions without payload content:

```json
{
  "sessionId": "<invocation UUID>",
  "requestId": "<ACS hook UUID>",
  "method": "steps/toolCallRequest",
  "decision": "ask",
  "effectiveDecision": "deny",
  "chainHash": "<64 lowercase hexadecimal characters>"
}
```

These decision records also go to the structured logger. The Guardian holds the authoritative audit chain. ACS mode disables AI SDK telemetry, including raw exception recording, irrespective of `OTEL_RECORD_CONTENT`. Outer invocation spans, durations, decision records, and final token usage remain available. MCP servers and library-supplied tool implementations manage their own logging; their process output is outside this agent's event and telemetry controls.

## Guardian interoperability

The integration targets the [ACS v0.1.0 schemas at commit bfdb898](https://github.com/GenAI-Security-Project/agent-control-standard/tree/bfdb898be4a9bcaedd90529b480ae5b62e94f29a/specification/v0.1.0). The [vendored snapshot](../src/acs/vendor/README.md) records normalization and the post-compaction adaptation. This implementation advertises no conformance profiles and does not claim full ACS-Core conformance.

The agent sends `handshake/hello` first. The Guardian must select `0.1.0`, the configured HTTP(S) transport, `HMAC-SHA256`, `on_decision_failure: deny`, and evaluation coverage for every advertised hook. Provenance-dependent policies and required conformance profiles are refused. `provenance_producer: none` indicates no general field-level lineage support; the mandatory post-compaction summary provenance is emitted with deterministically accumulated summary lineage only.

Each enforcement request has a fresh UUID in both JSON-RPC `id` and `params.request_id`, a timestamp, agent/session identity, and the last verified chain head when available. Guardian exchanges are serialized within a session; sessions remain independent. Every hook response must echo the UUID, use `type: final` and `acs_version: 0.1.0`, and carry a signed `chain_hash`. Response acceptance is limited to the outstanding request and its timeout. Request replay protection and durable auditing are Guardian responsibilities.

| Method | Payload and boundary |
| --- | --- |
| `steps/sessionStart` | Empty payload after negotiation. |
| `steps/agentTrigger` | `trigger_type: user_message`; `trigger_source` contains the complete `{ messages, context? }` request before prompt rendering/model use. This platform-specific source shape covers supplied history of every role. |
| `steps/turnStart` | One turn per invocation, with `turn_id` and `triggered_by: user_message`. The model's tool-use steps belong to this turn. |
| `steps/toolCallRequest` | `tool.name` and `arguments`, where each argument is wrapped as `{ value }`. Covers MCP tools and the built-in `todowrite` tool. |
| `steps/toolCallResult` | Tool identity, originating `request_id_ref`, exit status, duration, and `outputs: [{ value: rawResult }]`, before conversion/summarization. A generated summary or fallback excerpt is checked again with `operation: summarize`. |
| `steps/agentResponse` | `content: [{ type: text, value: answer }]`. A structured answer uses its JSON serialization as `value`. |
| `steps/preCompact` | Conservative `entries_to_compact` dependency set and `triggered_by: size_threshold`; the `messages` extension supplies the exact region to summarize. |
| `steps/postCompact` | Summary and its provenance, dependencies, and last verified pre-compaction chain hash. |
| `steps/turnEnd` | Turn ID, outcome, and observed hook count. |
| `steps/sessionEnd` | Termination `reason` and last verified chain hash. |

Compaction dependencies use content-bearing hook request IDs as step references. The conservative set includes the invocation's input observation, tool observations, and earlier compacted summaries. Inputs and tool outputs carry no field-level provenance; summary `derived_from` references prior emitted summary provenance nodes. The Guardian must use request IDs as step IDs for this integration.

The published `postCompact` request schema requires `post_compact_chain_hash`, even though only the Guardian can calculate that future hash. This client omits that field and adopts the signed response's `chain_hash`. A compatible Guardian must accept this request shape. It must also accept the explicit deny treatment of `ask` and `defer`.

MCP discovery and initialization are deployment setup. Tool invocations use transport-independent `steps/*` hooks; raw MCP protocol wrapping, provider-side tools, remote execution sandboxes, Inspect/AgBOM, Trace profiles, `system/ping`, and approval orchestration are not implemented. Library-supplied tools must have a local `execute` function; streaming input callbacks are disabled to keep side effects behind the tool gate. Model/provider I/O is part of the runtime, not exposed as tools.

### Modifications

`redactions` use JSON pointers rooted at the hook payload, for example `/arguments/query/value`, `/outputs/0/value/content/0/text`, or `/content/0/value`. Replacement defaults to `[REDACTED]`. Paths must exist and be disjoint. Prototype traversal, overlapping parent/child paths, and overlap with parameter overrides are rejected.

`parameter_overrides` is supported on tool requests and is keyed by argument name, e.g. `{ "query": "approved query" }`. The agent wraps each replacement value and validates the complete input against the tool schema. Tool identity cannot change.

`modified_content` is interpreted as a JSON string encoding an entire replacement hook payload. It cannot combine with structured edits. The replacement must satisfy the hook schema and runtime shape. Context/input modifications are applied before system-prompt rendering, and edited structured answers must satisfy `output.schema`.

Lifecycle hooks and `preCompact` accept no modifications in this subset. Invalid or unsupported edits never fall back to the original content. Audit-only closure responses must be `allow`.

### Signing convention

ACS specifies HKDF-derived session keys but leaves the HKDF parameters to the deployment. This agent and its Guardian use:

- HKDF-SHA256 input keying material: the UTF-8 bytes of the secret environment variable.
- Salt: the UTF-8 bytes of the session UUID, exactly as sent.
- Info: the UTF-8 bytes of `acs/0.1.0/hmac`.
- Derived key length: 32 bytes.
- Signature: HMAC-SHA256 over the RFC 8785 canonical UTF-8 JSON of the **whole JSON-RPC envelope**, removing only `params.signature` for a request or `result.signature` for a response; standard padded base64 encoding.
- Signature object: `{ algorithm: "HMAC-SHA256", key_id: "<configured keyId>", value: "<base64>" }`.

The handshake is signed in both directions using the same session key. The agent rejects unsigned or incorrectly signed responses, including the ServerHello. Share the [independently calculated signing vectors](acs-signing-vectors.json) with the Guardian implementation to verify exact agreement.
