#!/usr/bin/env node
// Harvest MCP mock — a local stand-in for https://api.harvestapp.com/mcp.
//
// Speaks the Streamable-HTTP MCP protocol that `@ai-sdk/mcp` uses for
// `transport: http`, so the configurable agent can talk to it without code
// changes — just point `HARVEST_MCP_URL` at this server (see examples/harvest).
//
// Data comes from a JSON fixture (default examples/harvest/fixture.json) holding
// raw `users` / `projects` / `time_entries`. The mock implements the real
// filtering semantics of the read tools on top of that dataset, and re-reads the
// fixture on every request so scenarios can be edited live without a restart.
//
//   node examples/harvest/harvest-mock.mjs
//   HARVEST_FIXTURE=examples/harvest/scenario-x.json PORT=8765 node examples/harvest/harvest-mock.mjs
//
// Env:
//   HARVEST_FIXTURE        path to the fixture JSON (default examples/harvest/fixture.json)
//   PORT                   listen port (default 8765)
//   HARVEST_MOCK_LATENCY_MS  optional artificial latency per tool call (default 0)

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const FIXTURE_PATH = resolve(process.env.HARVEST_FIXTURE ?? 'examples/harvest/fixture.json');
const PORT = Number(process.env.PORT ?? 8765);
const LATENCY_MS = Number(process.env.HARVEST_MOCK_LATENCY_MS ?? 0);

// `@ai-sdk/mcp` 1.0.46 advertises this as its latest; we echo it back if asked,
// otherwise fall back to a widely-supported version from its SUPPORTED set.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function loadFixture() {
  let raw;
  try {
    raw = readFileSync(FIXTURE_PATH, 'utf8');
  } catch (err) {
    throw new Error(`could not read fixture at ${FIXTURE_PATH}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`fixture at ${FIXTURE_PATH} is not valid JSON: ${err.message}`);
  }
  return {
    users: Array.isArray(data.users) ? data.users : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    time_entries: Array.isArray(data.time_entries) ? data.time_entries : [],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions + handlers
// ---------------------------------------------------------------------------

const containsCI = (haystack, needle) =>
  String(haystack ?? '')
    .toLowerCase()
    .includes(String(needle ?? '').toLowerCase());

const TOOLS = [
  {
    name: 'list_users',
    description:
      'List Harvest users (mock). Optional is_active filter and case-insensitive search over name/email.',
    inputSchema: {
      type: 'object',
      properties: {
        is_active: { type: 'boolean', description: 'Filter by active state.' },
        search: {
          type: 'string',
          description: 'Case-insensitive substring match on name or email.',
        },
      },
      additionalProperties: true,
    },
    handler: (fx, args) => {
      let users = fx.users;
      if (typeof args.is_active === 'boolean') {
        users = users.filter((u) => u.is_active === args.is_active);
      }
      if (args.search) {
        users = users.filter(
          (u) => containsCI(u.name, args.search) || containsCI(u.email, args.search),
        );
      }
      return { users, total_count: users.length, limit: DEFAULT_LIMIT, truncated: false };
    },
  },
  {
    name: 'list_projects',
    description:
      'List Harvest projects (mock). Optional case-insensitive `search` matches project name, code, or client name; optional is_active filter.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Substring match on name, code, or client_name.' },
        is_active: { type: 'boolean', description: 'Filter by active state.' },
        client_id: { type: 'integer', description: 'Filter by client id.' },
      },
      additionalProperties: true,
    },
    handler: (fx, args) => {
      let projects = fx.projects;
      if (args.search) {
        projects = projects.filter(
          (p) =>
            containsCI(p.name, args.search) ||
            containsCI(p.code, args.search) ||
            containsCI(p.client_name, args.search),
        );
      }
      if (typeof args.is_active === 'boolean') {
        projects = projects.filter((p) => p.is_active === args.is_active);
      }
      if (args.client_id != null) {
        projects = projects.filter((p) => p.client_id === args.client_id);
      }
      return { projects, total_count: projects.length, limit: DEFAULT_LIMIT, truncated: false };
    },
  },
  {
    name: 'list_time_entries',
    description:
      'List Harvest time entries (mock). Filter by project_id, user_id, client_id, and a `from`/`to` (inclusive, YYYY-MM-DD) range over spent_at. Sorted by spent_at descending.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Filter by project id.' },
        user_id: { type: 'integer', description: 'Filter by user id.' },
        client_id: { type: 'integer', description: 'Filter by client id.' },
        from: { type: 'string', description: 'Inclusive lower bound on spent_at (YYYY-MM-DD).' },
        to: { type: 'string', description: 'Inclusive upper bound on spent_at (YYYY-MM-DD).' },
      },
      additionalProperties: true,
    },
    handler: (fx, args) => {
      let entries = fx.time_entries;
      if (args.project_id != null) {
        entries = entries.filter((e) => e.project_id === args.project_id);
      }
      if (args.user_id != null) {
        entries = entries.filter((e) => e.user_id === args.user_id);
      }
      if (args.client_id != null) {
        entries = entries.filter((e) => e.client_id === args.client_id);
      }
      if (args.from) {
        entries = entries.filter((e) => e.spent_at >= args.from);
      }
      if (args.to) {
        entries = entries.filter((e) => e.spent_at <= args.to);
      }
      // Harvest returns most-recent-first; spent_at is YYYY-MM-DD so string sort works.
      entries = [...entries].sort((a, b) =>
        a.spent_at < b.spent_at ? 1 : a.spent_at > b.spent_at ? -1 : 0,
      );
      return {
        time_entries: entries,
        limit: DEFAULT_LIMIT,
        truncated: false,
        next_cursor: null,
        scope_limited: false,
      };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const publicTool = ({ name, description, inputSchema }) => ({ name, description, inputSchema });

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ---------------------------------------------------------------------------
// JSON-RPC handling
// ---------------------------------------------------------------------------

function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

async function handleRpc(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateProtocol(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'harvest-mcp-mock', version: '1.0.0' },
        },
      };

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(publicTool) } };

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          },
        };
      }
      try {
        await sleep(LATENCY_MS);
        const fx = loadFixture();
        const output = tool.handler(fx, args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(output) }] },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: String(err.message ?? err) }] },
        };
      }
    }

    default:
      // Unknown request method → JSON-RPC "method not found".
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ---------------------------------------------------------------------------
// HTTP server (Streamable HTTP transport)
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A stable session id is enough for a single-tenant mock; the client just echoes
// whatever we send back on subsequent requests.
const SESSION_ID = 'harvest-mock-session';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/' && url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  // Best-effort inbound SSE stream: the client opens this on connect; we don't
  // push server-initiated messages, so a 405 cleanly tells it "no inbound stream".
  if (req.method === 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('no inbound SSE');
    return;
  }
  // Session teardown on client close.
  if (req.method === 'DELETE') {
    res.writeHead(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    );
    return;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  // Notifications carry no `id`; the client ignores the body for those.
  const requests = messages.filter((m) => m && 'id' in m && m.id !== undefined && m.id !== null);

  if (requests.length === 0) {
    // Batch of notifications only (e.g. notifications/initialized) — ack with 202.
    res.writeHead(202, { 'mcp-session-id': SESSION_ID }).end();
    return;
  }

  const responses = await Promise.all(requests.map(handleRpc));
  const body = Array.isArray(payload) ? responses : responses[0];
  res.writeHead(200, {
    'content-type': 'application/json',
    'mcp-session-id': SESSION_ID,
  });
  res.end(JSON.stringify(body));
});

// Validate the fixture once at boot so misconfiguration fails fast and loudly.
try {
  const fx = loadFixture();
  console.error(
    `[harvest-mock] fixture ${FIXTURE_PATH}: ${fx.users.length} users, ${fx.projects.length} projects, ${fx.time_entries.length} time entries`,
  );
} catch (err) {
  console.error(`[harvest-mock] ${err.message}`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.error(`[harvest-mock] listening on http://localhost:${PORT}/mcp`);
  console.error('[harvest-mock] point HARVEST_MCP_URL at the URL above to use this mock.');
});
