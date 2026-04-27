import { type RunProgressEvent, type RunSummary, buildJsonSummary, runEvals } from '@eggai-tech/mo';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentEmitter } from '../events.js';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { type PartialToolResult, intentField, wrapToolExecute } from './result.js';

export interface MoRunToolConfig {
  timeoutMs: number;
  maxBufferBytes: number;
}

interface MoRunArgs {
  configPath: string;
  filter?: string;
  concurrency?: number;
}

export function createMoRunTool(cfg: MoRunToolConfig, ctx: ToolSummaryRuntime) {
  return tool({
    description:
      'Run the mo eval suite against a wally config. Streams per-case progress ' +
      '(▶ case_start, ✓/✗ case_finish) to the UI as tool_output_chunk events and ' +
      'returns the parsed summary (totals + per-case results including ' +
      'missingElements for failures) as the tool result — no jq needed. Use this ' +
      'instead of `bash: mo run ...` inside the eval-driven-deploy loop. ' +
      'return_code 0 = every case passed; 1 = at least one failed or errored ' +
      '(still a valid summary). status: error = mo itself crashed (bad config, ' +
      'missing eval dir, judge env vars not set, etc.).',
    inputSchema: z.object({
      configPath: z.string().min(1).describe('Absolute path to the wally.config.yaml to evaluate'),
      filter: z
        .string()
        .optional()
        .describe('Only run eval cases whose name contains this substring'),
      concurrency: z
        .number()
        .int()
        .positive()
        .max(16)
        .optional()
        .describe("Max parallel eval cases. Defaults to mo's own default (4)."),
      ...intentField,
    }),
    execute: async (args, { abortSignal, toolCallId }) =>
      wrapToolExecute<MoRunArgs>(
        {
          toolName: 'mo_run',
          labeler: (a) => `mo run ${a.configPath}${a.filter ? ` (filter: ${a.filter})` : ''}`,
          handler: async (a, opts) => runMo(a, cfg, ctx.emit, opts.toolCallId, opts.abortSignal),
          ctx,
        },
        args,
        { toolCallId, abortSignal },
      ),
  });
}

async function runMo(
  args: MoRunArgs,
  cfg: MoRunToolConfig,
  emit: AgentEmitter,
  toolCallId: string,
  abortSignal: AbortSignal | undefined,
): Promise<PartialToolResult> {
  let seq = 0;
  let totalBytes = 0;
  let streamedBytes = 0;
  let streamTruncated = false;
  let stopped = false;

  const streamChunk = async (text: string) => {
    if (stopped || text.length === 0) return;
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (streamTruncated) return;
    const remaining = cfg.maxBufferBytes - streamedBytes;
    if (remaining <= 0) {
      streamTruncated = true;
      return;
    }
    const chunk = truncateUtf8ByBytes(text, remaining);
    if (chunk.length === 0) {
      streamTruncated = true;
      return;
    }
    streamedBytes += Buffer.byteLength(chunk, 'utf8');
    if (chunk.length !== text.length) {
      streamTruncated = true;
    }
    await emit({ type: 'tool_output_chunk', id: toolCallId, text: chunk, seq: seq++ });
  };

  let summary: RunSummary;
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
  try {
    const runPromise = runEvals({
      configPath: args.configPath,
      filter: args.filter,
      concurrency: args.concurrency,
      onProgress: async (event) => {
        if (signal.aborted) return;
        await streamChunk(renderEvent(event));
      },
    });
    void runPromise.catch(() => undefined);
    summary = await Promise.race([runPromise, rejectOnAbort(signal, timeoutSignal, cfg.timeoutMs)]);
  } catch (err) {
    stopped = true;
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = timeoutSignal.aborted;
    const exitCode = timedOut ? 124 : signal.aborted ? 130 : 2;
    await emit({
      type: 'tool_stream_end',
      id: toolCallId,
      exitCode,
      timedOut,
      totalBytes,
      truncated: streamTruncated,
    });
    return {
      status: 'error',
      content: `mo crashed: ${message}`,
      return_code: exitCode,
    };
  }

  const jsonText = `${JSON.stringify(buildJsonSummary(summary), null, 2)}\n`;
  await streamChunk(`\n${jsonText}`);

  const exitCode = summary.failed === 0 && summary.errored === 0 ? 0 : 1;
  const content = truncateUtf8ByBytes(jsonText, cfg.maxBufferBytes);
  const truncated = streamTruncated || content.length !== jsonText.length;
  stopped = true;

  await emit({
    type: 'tool_stream_end',
    id: toolCallId,
    exitCode,
    timedOut: false,
    totalBytes,
    truncated,
  });

  return {
    status: 'succeeded',
    content,
    return_code: exitCode,
    ...(truncated ? { truncated: true } : {}),
  };
}

function renderEvent(event: RunProgressEvent): string {
  if (event.type === 'case_start') {
    return `▶ ${event.name}\n`;
  }
  const marker = event.passed ? '✓' : '✗';
  const tail = event.error ? `: ${event.error}` : '';
  return `${marker} ${event.name} (${event.durationMs}ms)${tail}\n`;
}

function rejectOnAbort(
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError(timeoutSignal.aborted, timeoutMs));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(abortError(timeoutSignal.aborted, timeoutMs));
      },
      { once: true },
    );
  });
}

function abortError(timedOut: boolean, timeoutMs: number): Error {
  if (timedOut) {
    return new Error(`mo run timed out after ${timeoutMs}ms`);
  }
  const err = new Error('mo run aborted');
  err.name = 'AbortError';
  return err;
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}
