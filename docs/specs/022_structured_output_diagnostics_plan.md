# Plan: say why structured output failed

## Finding

"No object generated: could not parse the response." is the AI SDK's `NoObjectGeneratedError` for a final text that is
not JSON. With a provider's native JSON-schema output the model does not write malformed JSON; the text is empty. Two
provider answers end that way, and both reached the client and the log as the same bare message:

- A content filter stops the response (Azure OpenAI: `response.incomplete`, `incomplete_details.reason:
  content_filter`, which the SDK maps to finishReason `content-filter`). `diagnoseStep` only knew `length`, so the run
  fell through to parsing the empty text.
- The model refuses. The OpenAI Responses provider drops the refusal content part, so the step ends with finishReason
  `stop` and no text.

The error carries `text`, `finishReason` and `cause`, but the loop kept only `message`, and the server's `agent error`
log line only `code` and `message`.

Replicated against a fake Responses endpoint that answers like Azure: on `main` both cases log exactly the bare message.

## Fix

- `diagnoseStep`: finishReason `content-filter` ends the run with `code: content_filtered`, like `length` →
  `max_tokens_reached`.
- `structured_output_failed` carries `details`: `finishReason`, `rawFinishReason` (when the provider gives one),
  `textLength`, and the cause's error name. Not the text, and not the cause's message: a JSON parse error quotes the
  text, and the text can carry user data.
- The server's `agent error` log line includes the event's `details`.

## Not addressed

A refusal is still reported as `structured_output_failed`; it shows as finishReason `stop` with `textLength: 0`. The
refusal text itself is not surfaced by the provider package.
