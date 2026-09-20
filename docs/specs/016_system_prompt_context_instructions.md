# 016 — Request system prompt context (instructions)

Add an optional `system_prompt_context` field to the input, which can then be
used by the system prompt defined in the YAML config. If I remember well, the
system prompt already uses jinja2 as template format? In this case, implement
pass through of the optional context data and pass it to the system prompt.
Add one nominal integration test and one 'failure' where the system prompt
tries to access context info that is not present.

Make sure these changes are in a branch, then committed and pushed to origin.
The branch should be `nicolas/required-improvements-for-control-plane`.

Follow-up: Let's rename `system_prompt_context` to only `context`.

Follow-up: `promptVars` should be available to the system prompt template under
the `config.` prefix. `context` in the request should be available to the system
prompt template under the `request.` prefix. For example, `promptVars: { team:
foobar }` and a request with `context: { weather: "sunny" }` should make both
`config.team` and `request.weather` available.
