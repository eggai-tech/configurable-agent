# 016 — Request system prompt context (instructions)

Accept an optional `context` object alongside `messages` in the input.
Make it available to the Handlebars system prompt defined in YAML under the
`request.` prefix. Make YAML `promptVars` available under the `config.` prefix.

For example, `promptVars: { team: foobar }` and a request with
`context: { weather: "sunny" }` make `config.team` and `request.weather`
available to the template.

Add one nominal integration test and one failure case where the system prompt
tries to access context information that is not present.

Make sure these changes are in a branch, then committed and pushed to origin.
The branch should be `nicolas/required-improvements-for-control-plane`.

Document the request fields, template namespaces, examples, and error behavior.
