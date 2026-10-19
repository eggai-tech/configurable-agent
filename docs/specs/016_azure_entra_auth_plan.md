# 016 — Azure Foundry with Entra ID auth (plan)

## Principle

Add one provider, `azure`, that always authenticates with Microsoft Entra ID.
No API keys and no custom auth code: `@ai-sdk/azure` sends the bearer token,
`@azure/identity` gets and refreshes it. The same code runs on Container
Apps, AKS and a dev laptop.

## Why code is needed

Without code changes, the only way to send an Entra token is a static token
in `OPENAI_API_KEY` with `provider: openai` and the Azure v1 `baseUrl`. The
`openai` provider sends it as `Authorization: Bearer`, which the Azure v1
endpoint accepts. However, the token expires, and nothing in the process can
refresh it. A proxy that adds the token (APIM or a sidecar) adds an infra
component and moves the auth problem to the agent → proxy hop. Neither is fit
for production.

## Smoke test before implementing

Use the static-token path to check network, RBAC, the deployment name and
Responses API support, with no code changes:

```sh
export OPENAI_API_KEY=$(az account get-access-token \
  --resource https://cognitiveservices.azure.com --query accessToken -o tsv)
# config: provider: openai, name: <deployment>,
#         baseUrl: https://<name>.openai.azure.com/openai/v1
CONFIG_PATH=./config.yaml pnpm dev serve &
curl -s 'localhost:3000/ready?deep=1'   # {"status":"ok","probe":"passed"}
```

## Config

```yaml
model:
  provider: azure
  name: <deployment-name>        # Foundry deployment name, not the model name
  baseUrl: https://<name>.openai.azure.com/openai
```

- `baseUrl` is the `/openai` prefix. The SDK appends `/v1/...` and
  `?api-version=v1`. The latest `@ai-sdk/azure` also accepts this form, so
  configs survive an SDK upgrade.

- `baseUrl` is required for `azure` (schema refine with a clear error).
- No other new keys. The token scope is fixed to
  `https://cognitiveservices.azure.com/.default`, the scope for
  `*.openai.azure.com`.

## Changes

- **Dependencies:** `pnpm add @ai-sdk/azure@4.0.11 @azure/identity`.
  `@ai-sdk/azure` 4.0.11 is the release that matches the installed
  `@ai-sdk/openai` 4.0.11 and the pinned `@ai-sdk/provider` 4.0.3. Newer
  releases bring a newer `@ai-sdk/provider` and fail typecheck. Upgrading all
  `@ai-sdk/*` packages together is a separate task.
- **`src/config/schema.ts`:** add `azure` to `ModelProvider` and its error
  message; refine `model` so `provider: azure` requires `baseUrl`.
- **`src/agent/model.ts`:**
  - `case 'azure'` returns
    `createAzure({ baseURL: cfg.baseUrl, tokenProvider })(cfg.name)`. This
    uses the Responses API, the same as the current `openai` provider.
  - `tokenProvider` is
    `getBearerTokenProvider(new DefaultAzureCredential(), scope)`. It is
    created lazily on first use and kept in a module-level variable, so the
    token cache is shared by the main loop, compaction, tool summaries and
    the `/ready` probe.
  - `requiredEnvVarFor('azure')` returns `null`. There is no key to check.
    `/ready?deep=1` checks the real path: token, then endpoint, then
    deployment.
- **Credential selection** is done by `DefaultAzureCredential`, with no code
  per environment:
  - Container Apps: `ManagedIdentityCredential`. For a user-assigned
    identity, set `AZURE_CLIENT_ID`.
  - AKS: `WorkloadIdentityCredential`, using env vars injected by the
    Workload Identity webhook.
  - Local dev: `AzureCliCredential`, after `az login`.
  - Optional in production: `AZURE_TOKEN_CREDENTIALS=prod` skips the dev
    credentials, for faster and predictable startup.

## Azure setup (documented, not code)

- Give the Container App a managed identity. User-assigned is recommended
  because it can be reused in AKS.
- Assign that identity the **Cognitive Services OpenAI User** role on the
  Foundry / Azure OpenAI resource.
- AKS later: enable Workload Identity, add a federated credential on the same
  identity for the pod's ServiceAccount, annotate the ServiceAccount with the
  client ID, and label the pod `azure.workload.identity/use: "true"`.

## Docs

- `docs/user-guide.md`:
  - Add `azure` to the provider lists.
  - Add a short "Azure Foundry (Entra ID)" subsection covering config, the
    role assignment, `AZURE_CLIENT_ID`, `AZURE_TOKEN_CREDENTIALS` and local
    `az login`.
  - Add the Azure env vars to the env table.
  - Note that `/ready` has no key check for `azure`.

## Tests

- `tests/config.test.ts`: `provider: azure` is accepted with `baseUrl` and
  rejected without it.
- `tests/model.test.ts`:
  - Mock `@azure/identity` with a fake credential that returns a fixed token.
  - Assert that `buildModel` returns an Azure model.
  - Assert that a call through a stub `fetch` sends
    `Authorization: Bearer <token>`, sends no `api-key` header, and uses the
    configured `baseUrl`.
  - Assert that `requiredEnvVarFor('azure')` is `null`.
- `tests/server.test.ts`: `/ready` returns 200 for `azure` with no API-key
  env vars set.

## Out of scope / follow-ups

- **MCP over HTTP with Entra.** HTTP MCP servers behind Entra will need a
  per-request bearer token in `mcpTools[].headers`. When needed, reuse the
  same `DefaultAzureCredential` with a per-server scope
  (e.g. `api://<app-id>/.default`). Specify this separately.
- **Non-OpenAI Foundry models** (Mistral, Llama, …) need Chat Completions
  (`azure.chat(...)`) instead of Responses. Add an option when such a model
  is actually used.
- **Claude on Foundry** is not covered by `@ai-sdk/azure`.
- **API-key auth for `azure`.** Not needed while key auth is disabled.
