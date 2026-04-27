import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { type PartialToolResult, intentField, wrapToolExecute } from './result.js';

export interface WebSearchToolConfig {
  maxResults: number;
}

interface WebSearchArgs {
  query: string;
  maxResults?: number;
}

interface TavilyResponse {
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    snippet?: string;
  }>;
}

export function createWebSearchTool(cfg: WebSearchToolConfig, ctx: ToolSummaryRuntime) {
  return tool({
    description:
      'Search the public web for up-to-date information. Returns a list of result snippets and an optional synthesized answer.',
    inputSchema: z.object({
      query: z.string().min(1).describe('The search query'),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe('Override the default max number of results'),
      ...intentField,
    }),
    execute: async (args, { abortSignal, toolCallId }) =>
      wrapToolExecute<WebSearchArgs>(
        {
          toolName: 'websearch',
          labeler: (a) => `search "${a.query}"`,
          handler: async (a, opts) => runSearch(a, cfg, opts.abortSignal),
          ctx,
        },
        args,
        { toolCallId, abortSignal },
      ),
  });
}

async function runSearch(
  args: WebSearchArgs,
  cfg: WebSearchToolConfig,
  abortSignal: AbortSignal | undefined,
): Promise<PartialToolResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY env var is not set');
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: args.query,
      max_results: args.maxResults ?? cfg.maxResults,
      include_answer: true,
    }),
    signal: abortSignal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`tavily search failed: ${res.status} ${res.statusText} ${body}`.trim());
  }

  const data = (await res.json()) as TavilyResponse;
  const results = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? r.snippet ?? '',
  }));

  return {
    status: 'succeeded',
    content: formatSearchContent(data.answer, results),
    return_code: null,
  };
}

function formatSearchContent(
  answer: string | undefined,
  results: Array<{ title: string; url: string; snippet: string }>,
): string {
  const parts: string[] = [];
  if (answer && answer.length > 0) {
    parts.push(`Answer: ${answer}`);
    parts.push('');
  }
  results.forEach((r, i) => {
    parts.push(`${i + 1}. ${r.title}`);
    if (r.url) parts.push(`   ${r.url}`);
    if (r.snippet) parts.push(`   ${r.snippet}`);
    parts.push('');
  });
  return parts.join('\n').replace(/\n+$/, '');
}
