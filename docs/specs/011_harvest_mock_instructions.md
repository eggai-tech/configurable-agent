# 011 — Harvest MCP mock — instructions

## Original request (lightly cleaned)

Nella configurazione di questo agent c'è un'integrazione del server MCP di Harvest.
Voglio integrare un mock per testare vari scenari.

Il mock deve pescare i dati da un file JSON nella cartella `examples/harvest`. Alla
fine del processo si genera questo file, che (forse) darò in input al mock.

Sono state fornite tutte le chiamate che l'MCP fa, prese dall'output SSE dell'agente
(`event: tool_call` / `event: tool_result`). Le tool call osservate sono:

- `list_users` → `{ users, total_count, limit, truncated }`
- `list_projects` con `search` → `{ projects, total_count, limit, truncated }`
- `list_time_entries` con `project_id`, `from`, `to` → `{ time_entries, limit, truncated, next_cursor, scope_limited }`
- (più `todowrite`, che è un tool interno dell'agente, non MCP)

## Decisioni prese (via domande)

1. **Formato fixture**: dataset grezzo (`users`, `projects`, `time_entries`) + logica
   di filtraggio implementata nel mock. Massima flessibilità per costruire scenari
   editando il dataset.
2. **Transport**: `http` — il mock è un server HTTP separato (come il vero Harvest),
   l'agente ci si collega via `url`.
3. **Generatore**: sì — includere uno script che parsa un dump SSE dell'agente e
   produce la fixture nel formato del mock.
