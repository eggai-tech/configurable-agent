# 015 — Remove the local token estimator (instructions)

## Original request

Follow-up on the compaction analysis (spec 014 / PR #17 discussion):

> In the PR we removed the gpt token count thing. We still have the chars/4
> approximation (`countTextTokens`). Do we need it, or should we only rely on
> real API settings and responses? In the best case, we do not need to
> calculate/estimate tokens on our own as it is not reliable enough.
>
> If possible without breaking functionality, factor out the token estimator
> and clean up.

## Context

The chars/4 estimator fed two threshold gates:

- the conversation-compaction trigger (`safety.compaction.triggerTokens`),
  where the ~20% under-count on code meant the effective trigger was
  ~120k real tokens instead of the configured 100k;
- the tool-output summarization trigger (`safety.toolOutput.triggerTokens`),
  which never needed tokens at all — it gates the size of a single string.

The wider compaction findings (tool-output configurability, dedicated
summarizer model, hysteresis) were reported but explicitly not in scope here.
