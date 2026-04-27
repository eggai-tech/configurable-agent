I want tool outputs to be standardised. This is because it'll make it easier for a potential UI to treat all tools the same.

Tool responses should be wrapped and contain:
 
- `label`: A human readable label for the tool call. For http, this could be `fetch <url>`. For bash, this is likely the bash command used.
- `status`: One of `succeeded`, `error`, `approval_denied`
- `content`: string.
- `return_code`: for bash tool, this would be the exit code. For http, the http_status code, etc.
- `args`: the original args
- `duration_ms`: the tool call duration in milliseconds

The bash tool should merge both stderr/stdout. This should be done at the command invocation time, piping stderr into stdout. It is important that stderr/stdout are intermingled based on the time they were emitted, just like they would be in a terminal.