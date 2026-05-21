import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMcpRegistry, wrapToolsWithSummarization } from '../src/agent/tools/mcp.js';
import type { AgentConfig } from '../src/config/schema.js';

// Mock the AI SDK MCP modules so tests never spawn child processes or open
// network connections. Each test queues fake clients on the createClient mock.
vi.mock('@ai-sdk/mcp', () => ({
  experimental_createMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: class FakeStdioTransport {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
  },
}));

import { experimental_createMCPClient as createClient } from '@ai-sdk/mcp';

interface FakeClient {
  tools: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
  toolsCalls: number;
  closed: boolean;
}

function fakeClient(
  opts: {
    toolsResult?: Record<string, unknown>;
    toolsThrows?: Error;
    closeThrows?: Error;
  } = {},
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

function fakeTool(name: string, executeOutput: unknown = `${name}-result`) {
  return {
    description: `${name} stub`,
    inputSchema: {},
    type: 'dynamic',
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
    vi.mocked(createClient).mockResolvedValueOnce(client as never);

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
    vi.mocked(createClient).mockResolvedValueOnce(client as never);

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

  it('discovers tools from an SSE server', async () => {
    const client = fakeClient({ toolsResult: { browser_navigate: fakeTool('browser_navigate') } });
    vi.mocked(createClient).mockResolvedValueOnce(client as never);

    const reg = await buildMcpRegistry(
      baseConfig({
        mcpTools: [
          {
            name: 'browser',
            transport: 'sse',
            url: 'http://playwright-mcp:8931/sse',
            headers: {},
          },
        ],
      }),
    );

    expect(Object.keys(reg.tools)).toEqual(['browser_navigate']);
    const callArg = vi.mocked(createClient).mock.calls.at(-1)?.[0] as {
      transport: { type?: string; url?: string };
    };
    expect(callArg.transport.type).toBe('sse');
    expect(callArg.transport.url).toBe('http://playwright-mcp:8931/sse');

    await reg.cleanup();
    expect(client.closed).toBe(true);
  });

  it('fails startup when two servers expose the same tool name', async () => {
    const a = fakeClient({ toolsResult: { shared: fakeTool('shared-a') } });
    const b = fakeClient({ toolsResult: { shared: fakeTool('shared-b') } });
    vi.mocked(createClient)
      .mockResolvedValueOnce(a as never)
      .mockResolvedValueOnce(b as never);

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
    vi.mocked(createClient).mockResolvedValueOnce(client as never);

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
      .mockResolvedValueOnce(a as never)
      .mockResolvedValueOnce(b as never);

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
    const tool = {
      description: 'echo',
      inputSchema: {},
      type: 'dynamic',
      async execute() {
        return { content: [{ type: 'text', text: 'hi there' }] };
      },
    };
    const summarize = vi.fn();
    const wrapped = wrapToolsWithSummarization({ echo: tool } as never, {
      config: baseConfig(),
      summarize,
    });

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
    const tool = {
      description: 'big',
      inputSchema: {},
      type: 'dynamic',
      async execute() {
        return { content: [{ type: 'text', text: big }] };
      },
    };
    const summarize = vi.fn(async () => 'SUMMARY-OF-BIG');
    const wrapped = wrapToolsWithSummarization({ big: tool } as never, {
      config: baseConfig(),
      summarize,
    });

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
    const tool = {
      description: 'fail',
      inputSchema: {},
      type: 'dynamic',
      async execute() {
        return { content: [{ type: 'text', text: 'boom' }], isError: true };
      },
    };
    const summarize = vi.fn();
    const wrapped = wrapToolsWithSummarization({ fail: tool } as never, {
      config: baseConfig(),
      summarize,
    });

    const out = (await (
      wrapped.fail as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute({}, { toolCallId: 'x', messages: [] })) as { status: string };

    expect(out.status).toBe('error');
  });
});
