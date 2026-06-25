#!/usr/bin/env node
// Harvest MCP OAuth helper.
//
// Runs the full authorization-code (+ PKCE) flow against Harvest, requesting a
// token scoped to the MCP resource server, then verifies it with an MCP
// `initialize` call.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CLIENT_ID = process.env.HARVEST_CLIENT_ID;
const CLIENT_SECRET = process.env.HARVEST_CLIENT_SECRET;
const REDIRECT_URI = process.env.HARVEST_REDIRECT_URI;

const AUTHORIZE_URL = 'https://id.getharvest.com/oauth2/authorize';
const TOKEN_URL = 'https://id.getharvest.com/api/v2/oauth2/token';
const MCP_URL = 'https://api.harvestapp.com/mcp';
const RESOURCE = MCP_URL; // RFC 8707 resource indicator — what makes the token valid for the MCP server.

const PORT = new URL(REDIRECT_URI).port || 80;

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const codeVerifier = base64url(randomBytes(48));
const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
const state = base64url(randomBytes(16));

function buildAuthorizeUrl() {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('resource', RESOURCE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  } catch {
    // ignore — the URL is printed below for manual opening
  }
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
    resource: RESOURCE,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function fetchAccountId(accessToken) {
  const res = await fetch('https://id.getharvest.com/api/v2/accounts', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'configurable-agent',
      accept: 'application/json',
    },
  });
  if (!res.ok) return undefined;
  const data = await res.json();
  // Prefer the Harvest account (the API also returns Forecast accounts).
  const account = data.accounts?.find((a) => a.product === 'harvest') ?? data.accounts?.[0];
  return account?.id;
}

async function verifyMcp(accessToken) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'harvest-oauth-script', version: '1.0.0' },
      },
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/' && url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(
          `<h1>Authorization error</h1><pre>${err}: ${url.searchParams.get('error_description') ?? ''}</pre>`,
        );
        server.close();
        reject(new Error(`authorize error: ${err}`));
        return;
      }
      if (!code) {
        res.end('<h1>No code in callback</h1>');
        return; // ignore stray requests (e.g. favicon)
      }
      res.end('<h1>✓ Authorized</h1><p>You can close this tab and return to the terminal.</p>');
      server.close();
      if (returnedState !== state) {
        reject(new Error(`state mismatch (csrf?): expected ${state}, got ${returnedState}`));
        return;
      }
      resolve(code);
    });
    server.on('error', reject);
    server.listen(PORT, () => {
      const authUrl = buildAuthorizeUrl();
      console.log(`\nListening on ${REDIRECT_URI} for the OAuth redirect.`);
      console.log('\nOpen this URL in your browser (attempting to open automatically):\n');
      console.log(`${authUrl}\n`);
      openBrowser(authUrl);
    });
  });
}

async function main() {
  const code = await waitForCode();
  console.log('\nGot authorization code, exchanging for tokens...');
  const token = await exchangeCode(code);

  // Resolve the account ID for the Harvest-Account-ID header from the accounts API.
  const accountId = await fetchAccountId(token.access_token);

  console.log('\n=== TOKENS ===');
  console.log(`access_token:  ${token.access_token}`);
  console.log(`refresh_token: ${token.refresh_token ?? '(none)'}`);
  console.log(`token_type:    ${token.token_type ?? '(n/a)'}`);
  console.log(
    `expires_in:    ${token.expires_in ?? '(n/a)'}${token.expires_in ? ` (~${Math.round(token.expires_in / 3600)}h)` : ''}`,
  );
  console.log(`scope:         ${token.scope ?? '(none)'}`);
  console.log(`account_id:    ${accountId ?? '(not found in scope)'}`);

  console.log('\nVerifying token against the MCP endpoint...');
  const check = await verifyMcp(token.access_token);
  console.log(`MCP initialize -> HTTP ${check.status}`);
  console.log(check.body.slice(0, 800));

  if (check.status === 200) {
    console.log('\n✓ Token is valid for the MCP server. Put these in your .env:\n');
    console.log(`HARVEST_ACCESS_TOKEN=${token.access_token}`);
    console.log(`HARVEST_ACCOUNT_ID=${accountId ?? '<account id>'}`);
  } else {
    console.log('\n✗ MCP rejected the token. See the body above for the reason.');
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
