# 019 — Deploy manifests drifted from the config schema: plan

## Audit summary

Typecheck, lint and all 113 tests pass on `main`. The source is small and
well guarded. The one concrete defect found is in the shipped deployment
configs, not the code:

Commit 58d7c94 ("safety: replace the local token estimator with real
provider usage") renamed `safety.toolOutput.triggerTokens` to
`triggerChars`. The schema is `strictObject`, so the old key is rejected.
Three shipped configs were never updated:

| File                 | Problem                                                       |
|----------------------|---------------------------------------------------------------|
| `helm/values.yaml`   | default `config` has `toolOutput.triggerTokens` → chart fails validation at startup |
| `k8s/configmap.yaml` | same key, plus a stale top-level `tools:` block the schema rejects |
| `descriptor.yaml`    | `configSchema` and the example still describe `triggerTokens`   |

Verified by running the real loader against each file: Helm defaults and the
k8s manifest both throw `ConfigError` ("Unrecognized key"). A pod deployed
from either exits 1 before serving.

## Changes

1. `helm/values.yaml`: `triggerTokens: 4000` → `triggerChars: 16000` (the
   schema default, roughly the same budget at ~4 chars/token).
2. `k8s/configmap.yaml`: drop the `tools:` block, `triggerTokens: 2000` →
   `triggerChars: 8000`.
3. `descriptor.yaml`: rename the key in `configSchema` and the example,
   update the description.
4. New `tests/manifests.test.ts`: load every shipped config sample
   (`example.config.yaml`, Helm `config`, k8s ConfigMap `config.yaml`,
   each `descriptor.yaml` example) through `loadConfig` so schema changes
   cannot silently break the deploy artifacts again.
5. CHANGELOG `Unreleased / Fixed` entry.

## Out of scope (noted)

- `descriptor.yaml` provider enum omits `azure` and `openai-compatible`.
- `/invoke` has no overall request deadline; worth a follow-up.
