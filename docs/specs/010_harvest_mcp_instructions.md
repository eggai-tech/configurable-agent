# 010 — Harvest MCP integration & auth

## User request (verbatim / lightly cleaned)

> Come posso aggiungere questo MCP e farlo funzionare con l'autenticazione?
> https://support.getharvest.com/hc/en-us/articles/46293697226381-Harvest-MCP
>
> Voglio aggiungerlo a questo progetto (configurable agent), tramite il file di
> configurazione (`config.yaml`). Usa questi header:
> - `Harvest-Account-ID: 2029314`
> - `Authorization: Bearer <PAT>`
> - `User-Agent: configurable-agent`

Follow-up questions during the session:

- L'attuale API può ricevere un file in input da dare all'agent?
- Con che comando parte il server?
- Errore: `Token was not issued for the MCP server. Re-authorize via Claude Code
  (or your MCP client) with the MCP scope.` → ho creato un'app OAuth in Harvest,
  generami uno script node per tutto il flusso (client id/secret + redirect
  `http://localhost:3000`).
- Errore `ZodError ... expected object, received null` allo startup
  (`mcp registry initialization failed`) → aggiorna tutti i package `@ai-sdk` e
  `ai` alle versioni più recenti.
