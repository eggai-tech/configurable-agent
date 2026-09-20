# 016 — Request system prompt context (plan)

- Keep the existing Handlebars renderer. Accept an optional object named
  `system_prompt_context` alongside `messages` in HTTP and CLI input.
- Carry the object through `runAgent` options and expose it to templates as
  `{{system_prompt_context.field}}`, including nested objects. Keep this
  namespace separate from built-ins and configured `promptVars`; do not store
  request context in the config or compiled-template cache.
- Use strict Handlebars rendering: a referenced missing value fails the run
  with an `invalid_prompt_context` error before any model call. This also
  applies to missing configured template variables. At startup, precompile
  templates to validate syntax without requiring request data.
- Add HTTP integration coverage from YAML loading through the model prompt
  and SSE response, including missing context and separation across requests.
  Cover shared request validation and CLI forwarding as well.
- Document the input and template syntax, error behavior, and resubmission of
  context for follow-up requests and approval resumes. Run tests, type checking,
  lint, and build; commit and push the requested branch.
