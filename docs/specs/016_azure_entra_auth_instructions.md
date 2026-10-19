# 016 — Azure Foundry with Entra ID auth (instructions)

## Original request

> We are running the configurable agent on Azure, now as a Container App,
> later in AKS. OpenAI key authentication is turned off. Let's first plan:
> what do we need to add to this project to be able to auth to Azure Foundry?

Follow-ups during planning:

> Currently the app is calling OpenAI directly. In Azure I see a
> `<name>.openai.azure.com` URL for the OpenAI API.

> Keep MCP as a separate step, but keep it in mind — we will probably need
> that later.

> Write plan and instructions to add Entra / Entra token support, in the
> simplest way possible.

## Context

- Today the agent only authenticates with API keys from env vars
  (`OPENAI_API_KEY`, …). The Foundry resource has key auth disabled, so the
  agent must use Microsoft Entra ID tokens.
- Runtime identity: managed identity on Azure Container Apps now, AKS
  Workload Identity later.
- `@ai-sdk/azure` (≥ 4.0) supports Entra natively via a `tokenProvider`
  option; `@azure/identity` supplies the token.
