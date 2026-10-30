# Plan: `/invoke` abort listener leak

## Finding

`/invoke` adds an `abort` listener to `c.req.raw.signal` and never removes it. The signal outlives the request: a
heap snapshot retains it through undici's `requestFinalizer` registry, and the listener's closure pins the Hono
context, the cached body text and the parsed messages. The heap grows by about 3.5x the bytes served, whatever the
concurrency, until V8 hits its limit.

## Fix

Name the listener and remove it in the `finally` that closes the request. Covered by a test in
`tests/server.test.ts`.

## Not addressed

Concurrent large bodies still need real memory: each in-flight request holds several copies of its body. Sizing is a
deployment decision, not part of this change.
