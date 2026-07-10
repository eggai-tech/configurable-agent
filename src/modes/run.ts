import { context, type SpanContext, trace } from '@opentelemetry/api';
import type { LanguageModel, ModelMessage } from 'ai';
import { type AgentEvent, runAgent } from '../agent/loop.js';
import { buildMcpRegistry } from '../agent/tools/mcp.js';
import { InvokeRequestSchema } from '../api/request.js';
import { parseTraceparent, type RunRecord, readAllStdin, writeRunRecord } from '../cli/stdio.js';
import { ConfigError, loadConfig } from '../config/load.js';
import type { AgentConfig } from '../config/schema.js';
import { shutdownTracing, startTracing } from '../observability/tracing.js';
import { errorMessage as errMsg } from '../util.js';

const USAGE = `Usage: configurable-agent run --config <path-to-config.yaml>

Reads a JSON conversation from stdin. Writes a single-line JSON run record on
the last line of stdout. Diagnostic logs go to stderr.

Env:
  TRACEPARENT                    W3C trace parent — spans nest under this context.
  OTEL_EXPORTER_OTLP_ENDPOINT    where to send spans.
`;

export interface RunCliOptions {
  argv: string[];
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  modelOverride?: LanguageModel;
}

export async function runCli(opts: RunCliOptions): Promise<number> {
  const configPath = parseConfigFlag(opts.argv);
  if (!configPath) {
    opts.stderr.write(USAGE);
    return 2;
  }

  let stdinRaw: string;
  try {
    stdinRaw = await readAllStdin(opts.stdin);
  } catch (err) {
    opts.stderr.write(`failed to read stdin: ${errMsg(err)}\n`);
    return 2;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(stdinRaw);
  } catch (err) {
    opts.stderr.write(`stdin is not valid JSON: ${errMsg(err)}\n`);
    return 2;
  }

  const validated = InvokeRequestSchema.safeParse(parsedBody);
  if (!validated.success) {
    opts.stderr.write(
      `stdin failed schema validation: ${JSON.stringify(validated.error.format())}\n`,
    );
    return 2;
  }

  let config: AgentConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      opts.stderr.write(`config error (${configPath}): ${err.message}\n`);
    } else {
      opts.stderr.write(`failed to load config at ${configPath}: ${errMsg(err)}\n`);
    }
    return 2;
  }

  startTracing();

  const parentSpanCtx = parseTraceparent(opts.env.TRACEPARENT);

  try {
    const record = await executeRun(
      config,
      validated.data.messages as ModelMessage[],
      opts.modelOverride,
      parentSpanCtx,
    );
    writeRunRecord(opts.stdout, record);
    return 0;
  } catch (err) {
    opts.stderr.write(`configurable-agent run crashed: ${errMsg(err)}\n`);
    return 2;
  } finally {
    // OTEL export is best-effort. A flush / connection failure here must never
    // turn a successful run into a non-zero exit for Mo.
    try {
      await shutdownTracing();
    } catch (err) {
      opts.stderr.write(`warning: otel shutdown failed: ${errMsg(err)}\n`);
    }
  }
}

async function executeRun(
  config: AgentConfig,
  messages: ModelMessage[],
  modelOverride: LanguageModel | undefined,
  parentSpanCtx: SpanContext | null,
): Promise<RunRecord> {
  const collector = new EventCollector();

  // Build MCP tools once for the run; one-shot, so the registry is torn down
  // before the process exits.
  const registry = await buildMcpRegistry(config);

  const work = () =>
    runAgent(config, messages, (e) => collector.collect(e), undefined, {
      model: modelOverride,
      tools: registry.tools,
    });

  const tracer = trace.getTracer('configurable-agent-cli');
  const baseCtx = parentSpanCtx
    ? trace.setSpanContext(context.active(), parentSpanCtx)
    : context.active();

  try {
    await context.with(baseCtx, async () => {
      await tracer.startActiveSpan('configurable-agent.run', async (span) => {
        try {
          await work();
        } finally {
          span.end();
        }
      });
    });
  } finally {
    await registry.cleanup();
  }

  return collector.toRecord();
}

class EventCollector {
  private finalText: string | undefined;
  private structured: unknown;
  private errorMessage: string | undefined;

  collect(event: AgentEvent): void {
    switch (event.type) {
      case 'final':
        this.finalText = event.content;
        this.structured = event.structured;
        break;
      case 'error':
        if (this.errorMessage === undefined) this.errorMessage = event.message;
        break;
      default:
        break;
    }
  }

  toRecord(): RunRecord {
    return {
      ok: this.finalText !== undefined && this.errorMessage === undefined,
      finalText: this.finalText ?? '',
      ...(this.structured !== undefined ? { structured: this.structured } : {}),
      error: this.errorMessage ?? null,
    };
  }
}

function parseConfigFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') return argv[i + 1] ?? null;
    if (a?.startsWith('--config=')) return a.slice('--config='.length);
  }
  return null;
}
