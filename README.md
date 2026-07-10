# Configurable Agent

Turn a single YAML file into a running LLM agent with an HTTP API. You define the
system prompt, model, tools, and safety limits; the service runs the tool-use
loop and streams every step back to your client over Server-Sent Events.

Works with Anthropic, OpenAI, Google, or any OpenAI-compatible endpoint
(including local [ollama](https://ollama.com)), connects external tools via the
[Model Context Protocol](https://modelcontextprotocol.io), and is built to drop
into Kubernetes — config in a `ConfigMap`, API keys in a `Secret`.

## Quick start

```bash
pnpm install
export ANTHROPIC_API_KEY=...          # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
CONFIG_PATH=./example.config.yaml pnpm dev
```

Send a request and watch the response stream:

```bash
curl -N -X POST http://localhost:3000/invoke \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"search the web for eggai and summarize"}]}'
```

## Documentation

The full **[User Guide](docs/user-guide.md)** covers:

- [Features](docs/user-guide.md#features)
- [Running](docs/user-guide.md#running)
- [Configuration](docs/user-guide.md#configuration)
  - [Model and providers](docs/user-guide.md#model-and-providers)
  - [Prompt templating](docs/user-guide.md#prompt-templating)
  - [Tools](docs/user-guide.md#tools)
  - [Structured output](docs/user-guide.md#structured-output)
  - [Safety: compaction, summarization, and approval](docs/user-guide.md#safety)
- [HTTP API](docs/user-guide.md#http-api)
  - [Endpoints](docs/user-guide.md#endpoints)
  - [Request format](docs/user-guide.md#request-format)
  - [Streaming events (SSE)](docs/user-guide.md#streaming-events-sse)
  - [Resolving a tool approval](docs/user-guide.md#resolving-a-tool-approval)
- [Deployment](docs/user-guide.md#deployment) — Docker & Kubernetes
- [Observability](docs/user-guide.md#observability)
- [Environment variables](docs/user-guide.md#environment-variables)

## Development

```bash
pnpm dev         # run with reload
pnpm test        # run the test suite
pnpm typecheck   # type-check
pnpm lint        # lint / format check
pnpm build       # compile to dist/
```
