import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { type PartialToolResult, intentField, wrapToolExecute } from './result.js';

export interface HttpToolConfig {
  timeoutMs: number;
  maxResponseBytes: number;
}

interface HttpArgs {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: string;
}

export function createHttpTool(cfg: HttpToolConfig, ctx: ToolSummaryRuntime) {
  return tool({
    description:
      'Make an HTTP request to an arbitrary URL. Supports GET/POST/PUT/PATCH/DELETE/HEAD, ' +
      'custom headers, query parameters, and a string body (the caller is responsible for ' +
      'JSON-stringifying and setting content-type). Returns `<status> <statusText>\\n<body>` ' +
      'as content (body truncated if it exceeds the configured byte limit) and the HTTP status ' +
      'code as return_code. Non-2xx responses are returned as data, not thrown.',
    inputSchema: z.object({
      url: z.string().url().describe('The request URL (http or https)'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
        .default('GET')
        .describe('HTTP method'),
      headers: z.record(z.string()).optional().describe('Request headers as a flat object'),
      queryParams: z
        .record(z.string())
        .optional()
        .describe('Query string parameters merged onto the URL'),
      body: z
        .string()
        .optional()
        .describe('Raw request body string; set content-type via headers when needed'),
      ...intentField,
    }),
    execute: async (args, { abortSignal, toolCallId }) =>
      wrapToolExecute<HttpArgs>(
        {
          toolName: 'http',
          labeler: (a) => `fetch ${a.method} ${a.url}`,
          handler: async (a, opts) => runHttp(a, cfg, opts.abortSignal),
          ctx,
        },
        args,
        { toolCallId, abortSignal },
      ),
  });
}

async function runHttp(
  input: HttpArgs,
  cfg: HttpToolConfig,
  abortSignal: AbortSignal | undefined,
): Promise<PartialToolResult> {
  const url = new URL(input.url);
  if (input.queryParams) {
    for (const [k, v] of Object.entries(input.queryParams)) {
      url.searchParams.append(k, v);
    }
  }

  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

  const init: RequestInit = {
    method: input.method,
    headers: input.headers,
    signal,
  };
  if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
    init.body = input.body;
  }

  const res = await fetch(url, init);

  const text = await res.text();
  const bodyTruncated = text.length > cfg.maxResponseBytes;
  const body = bodyTruncated ? text.slice(0, cfg.maxResponseBytes) : text;

  const statusLine = `${res.status} ${res.statusText}`.trimEnd();
  return {
    status: 'succeeded',
    content: body.length > 0 ? `${statusLine}\n${body}` : statusLine,
    return_code: res.status,
    ...(bodyTruncated ? { truncated: true } : {}),
  };
}
