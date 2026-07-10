import { jsonSchema, type Tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMcpRegistry,
  normalizeJsonSchemaDraft2020,
  wrapToolsWithSummarization,
} from '../src/agent/tools/mcp.js';
import type { AgentConfig } from '../src/config/schema.js';

// Mock the AI SDK MCP modules so tests never spawn child processes or open
// network connections. Each test queues fake clients on the createClient mock.
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: class FakeStdioTransport {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
  },
}));

import type { MCPClient } from '@ai-sdk/mcp';
import { createMCPClient as createClient } from '@ai-sdk/mcp';

interface FakeClient {
  tools: () => Promise<Record<string, Tool>>;
  close: () => Promise<void>;
  toolsCalls: number;
  closed: boolean;
}

// The fake implements only the slice of MCPClient the registry touches.
function asMcpClient(c: FakeClient): MCPClient {
  return c as unknown as MCPClient;
}

function fakeClient(
  opts: { toolsResult?: Record<string, Tool>; toolsThrows?: Error; closeThrows?: Error } = {},
): FakeClient {
  // State lives on the returned object directly so tests can inspect mutations.
  const c: FakeClient = {
    toolsCalls: 0,
    closed: false,
    async tools() {
      c.toolsCalls += 1;
      if (opts.toolsThrows) throw opts.toolsThrows;
      return opts.toolsResult ?? {};
    },
    async close() {
      c.closed = true;
      if (opts.closeThrows) throw opts.closeThrows;
    },
  };
  return c;
}

function fakeTool(name: string, executeOutput: unknown = `${name}-result`): Tool {
  return {
    description: `${name} stub`,
    inputSchema: jsonSchema({ type: 'object', additionalProperties: true }),
    type: 'dynamic' as const,
    async execute() {
      return executeOutput;
    },
  };
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    systemPrompt: 'SYSTEM',
    model: { provider: 'anthropic', name: 'stub' },
    agent: { maxSteps: 10 },
    mcpTools: [],
    output: { structured: false },
    safety: {
      compaction: { triggerTokens: 100_000, keepRecentMessages: 6 },
      toolOutput: { triggerTokens: 50, headChars: 20, tailChars: 20 },
      approval: { mode: 'none', tools: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildMcpRegistry', () => {
  it('returns empty tools and a no-op cleanup when no servers are configured', async () => {
    const reg = await buildMcpRegistry(baseConfig());
    expect(Object.keys(reg.tools)).toHaveLength(0);
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
    await expect(reg.cleanup()).resolves.not.toThrow();
  });

  it('discovers tools from a stdio server', async () => {
    const client = fakeClient({ toolsResult: { ping: fakeTool('ping') } });
    vi.mocked(createClient).mockResolvedValueOnce(asMcpClient(client));

    const reg = await buildMcpRegistry(
      baseConfig({
        mcpTools: [{ name: 'svc', transport: 'stdio', command: 'svc-mcp', args: [], env: {} }],
      }),
    );

    expect(Object.keys(reg.tools)).toEqual(['ping']);
    expect(client.toolsCalls).toBe(1);
    await reg.cleanup();
    expect(client.closed).toBe(true);
  });

  it('discovers tools from an HTTP server', async () => {
    const client = fakeClient({ toolsResult: { search: fakeTool('search') } });
    vi.mocked(createClient).mockResolvedValueOnce(asMcpClient(client));

    const reg = await buildMcpRegistry(
      baseConfig({
        mcpTools: [
          {
            name: 'remote',
            transport: 'http',
            url: 'https://mcp.example.com/v1',
            headers: {},
          },
        ],
      }),
    );

    expect(Object.keys(reg.tools)).toEqual(['search']);
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(createClient).mock.calls[0]?.[0] as {
      transport: { type?: string; url?: string };
    };
    expect(callArg.transport.type).toBe('http');
    expect(callArg.transport.url).toBe('https://mcp.example.com/v1');

    await reg.cleanup();
    expect(client.closed).toBe(true);
  });

  it('fails startup when two servers expose the same tool name', async () => {
    const a = fakeClient({ toolsResult: { shared: fakeTool('shared-a') } });
    const b = fakeClient({ toolsResult: { shared: fakeTool('shared-b') } });
    vi.mocked(createClient)
      .mockResolvedValueOnce(asMcpClient(a))
      .mockResolvedValueOnce(asMcpClient(b));

    await expect(
      buildMcpRegistry(
        baseConfig({
          mcpTools: [
            { name: 'a', transport: 'stdio', command: 'a-mcp', args: [], env: {} },
            { name: 'b', transport: 'stdio', command: 'b-mcp', args: [], env: {} },
          ],
        }),
      ),
    ).rejects.toThrow(/MCP tool name conflict.*"shared".*"b"/);

    // Both clients were opened during discovery and both must be closed before
    // the error propagates — leaking processes/sockets on init failure is the
    // exact regression we are guarding against.
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });

  it('fails startup when a stdio server cannot be discovered', async () => {
    vi.mocked(createClient).mockRejectedValueOnce(new Error('spawn ENOENT'));

    await expect(
      buildMcpRegistry(
        baseConfig({
          mcpTools: [{ name: 'broken', transport: 'stdio', command: 'no-such', args: [], env: {} }],
        }),
      ),
    ).rejects.toThrow(/spawn ENOENT/);
  });

  it('fails startup when an HTTP server cannot complete tool discovery', async () => {
    const client = fakeClient({ toolsThrows: new Error('connection refused') });
    vi.mocked(createClient).mockResolvedValueOnce(asMcpClient(client));

    await expect(
      buildMcpRegistry(
        baseConfig({
          mcpTools: [
            {
              name: 'remote',
              transport: 'http',
              url: 'https://down.example.com/mcp',
              headers: {},
            },
          ],
        }),
      ),
    ).rejects.toThrow(/connection refused/);

    // Even though tools() failed, the client was opened — cleanup must still
    // close it before we abort startup.
    expect(client.closed).toBe(true);
  });

  it('cleanup closes every client and tolerates close errors', async () => {
    const a = fakeClient({
      toolsResult: { ta: fakeTool('ta') },
      closeThrows: new Error('close-failed'),
    });
    const b = fakeClient({ toolsResult: { tb: fakeTool('tb') } });
    vi.mocked(createClient)
      .mockResolvedValueOnce(asMcpClient(a))
      .mockResolvedValueOnce(asMcpClient(b));

    const reg = await buildMcpRegistry(
      baseConfig({
        mcpTools: [
          { name: 'a', transport: 'stdio', command: 'a-mcp', args: [], env: {} },
          { name: 'b', transport: 'stdio', command: 'b-mcp', args: [], env: {} },
        ],
      }),
    );

    await expect(reg.cleanup()).resolves.not.toThrow();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });
});

describe('wrapToolsWithSummarization', () => {
  it('passes a small MCP result through as a succeeded envelope', async () => {
    const tool = fakeTool('echo', { content: [{ type: 'text', text: 'hi there' }] });
    const summarize = vi.fn();
    const wrapped = wrapToolsWithSummarization(
      { echo: tool },
      {
        config: baseConfig(),
        summarize,
      },
    );

    const out = (await (
      wrapped.echo as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute({ q: 1 }, { toolCallId: 'x', messages: [] })) as Record<string, unknown>;

    expect(summarize).not.toHaveBeenCalled();
    expect(out.label).toBe('echo');
    expect(out.status).toBe('succeeded');
    expect(out.content).toBe('hi there');
    expect(out.truncated).toBeUndefined();
  });

  it('summarizes oversized MCP results and marks the envelope truncated', async () => {
    const big = 'X'.repeat(2000);
    const tool = fakeTool('big', { content: [{ type: 'text', text: big }] });
    const summarize = vi.fn(async () => 'SUMMARY-OF-BIG');
    const wrapped = wrapToolsWithSummarization(
      { big: tool },
      {
        config: baseConfig(),
        summarize,
      },
    );

    const out = (await (
      wrapped.big as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute({}, { toolCallId: 'x', messages: [] })) as {
      truncated?: boolean;
      content: string;
    };

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('SUMMARY-OF-BIG');
    expect(out.content).toContain('HEAD');
    expect(out.content).toContain('TAIL');
    // Sanity: the raw oversized body is NOT included verbatim
    expect(out.content.length).toBeLessThan(big.length);
  });

  it('flags MCP results with isError as a failed envelope', async () => {
    const tool = fakeTool('fail', { content: [{ type: 'text', text: 'boom' }], isError: true });
    const summarize = vi.fn();
    const wrapped = wrapToolsWithSummarization(
      { fail: tool },
      {
        config: baseConfig(),
        summarize,
      },
    );

    const out = (await (
      wrapped.fail as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute({}, { toolCallId: 'x', messages: [] })) as { status: string };

    expect(out.status).toBe('error');
  });

  // AI SDK v6 calls toModelOutput with { toolCallId, input, output } — `output`
  // is the execute() return value (our envelope). Reading the envelope from the
  // wrong place yields { value: undefined }, which fails prompt validation on
  // the next step.
  it('toModelOutput unwraps the v6 { output } envelope into clean text', async () => {
    const tool = fakeTool('echo', { content: [{ type: 'text', text: 'clean body' }] });
    const wrapped = wrapToolsWithSummarization(
      { echo: tool },
      {
        config: baseConfig(),
        summarize: vi.fn(),
      },
    );

    const w = wrapped.echo as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
      toModelOutput: (opts: { output: unknown }) => { type: string; value: string };
    };
    const envelope = await w.execute({}, { toolCallId: 'x', messages: [] });

    const succeeded = w.toModelOutput({ output: envelope });
    expect(succeeded).toEqual({ type: 'text', value: 'clean body' });

    const errored = w.toModelOutput({ output: { status: 'error', content: 'boom' } });
    expect(errored).toEqual({ type: 'error-text', value: 'boom' });
  });
});

describe('normalizeJsonSchemaDraft2020', () => {
  it('converts draft-04 boolean exclusiveMinimum to the 2020-12 numeric form', () => {
    // This is the exact shape Harvest's update_time_entry tool ships, which the
    // Anthropic API rejects as invalid draft 2020-12.
    const result = normalizeJsonSchemaDraft2020({
      type: 'object',
      properties: {
        hours: { type: 'number', minimum: 0, exclusiveMinimum: true },
      },
    }) as { properties: { hours: Record<string, unknown> } };

    expect(result.properties.hours).toEqual({ type: 'number', exclusiveMinimum: 0 });
  });

  it('drops exclusiveMaximum:false and keeps the plain bound', () => {
    const result = normalizeJsonSchemaDraft2020({
      type: 'number',
      maximum: 10,
      exclusiveMaximum: false,
    });
    expect(result).toEqual({ type: 'number', maximum: 10 });
  });

  it('recurses into nested schemas and arrays ($defs, items)', () => {
    const result = normalizeJsonSchemaDraft2020({
      $defs: {
        amount: { type: 'number', minimum: 0, exclusiveMinimum: true },
      },
      items: [{ type: 'integer', minimum: 1, exclusiveMinimum: true }],
    }) as {
      $defs: { amount: Record<string, unknown> };
      items: Array<Record<string, unknown>>;
    };
    expect(result.$defs.amount).toEqual({ type: 'number', exclusiveMinimum: 0 });
    expect(result.items[0]).toEqual({ type: 'integer', exclusiveMinimum: 1 });
  });

  it('leaves already-numeric exclusive bounds and unrelated keywords untouched', () => {
    const schema = {
      type: 'number',
      exclusiveMinimum: 5,
      description: 'keep me',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    };
    expect(normalizeJsonSchemaDraft2020(schema)).toEqual(schema);
  });

  it('does not mutate the input object', () => {
    const input = { type: 'number', minimum: 0, exclusiveMinimum: true };
    normalizeJsonSchemaDraft2020(input);
    expect(input).toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true });
  });
});
