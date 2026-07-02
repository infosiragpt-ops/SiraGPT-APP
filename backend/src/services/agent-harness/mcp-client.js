'use strict';

/**
 * mcp-client — user-registered EXTERNAL MCP servers for the chat agent.
 *
 * Complements connectors/mcp-tool-registry.js, which is the opposite
 * direction (siraGPT EXPOSING its own vetted tools through an internal MCP
 * hub, `arbitraryServersAllowed: false`). This module is the CLIENT side:
 * the user registers third-party servers by URL (settings UI / API), their
 * tools are discovered at the start of an agent turn, namespaced as
 * `mcp__<server>__<tool>`, merged into the harness tool registry with
 * permissionTier 'confirm' by default (third-party code — the user approves
 * each call unless they pick "always allow in this chat"), and executed over
 * Streamable HTTP with an SSE-transport fallback.
 *
 * Failure posture: a server that is down, slow, or misbehaving is logged and
 * SKIPPED — discovery and execution problems must never take the chat turn
 * down with them. Per-server discovery and per-call timeouts enforce that.
 *
 * Auth headers are stored AES-256-CBC-encrypted (utils/encryption) in the
 * `mcp_servers` row and only decrypted in-process at connect time.
 */

const { z } = require('zod');

const DISCOVERY_TIMEOUT_MS = Math.max(1_000, Number(process.env.SIRAGPT_MCP_DISCOVERY_TIMEOUT_MS) || 8_000);
const CALL_TIMEOUT_MS = Math.max(1_000, Number(process.env.SIRAGPT_MCP_CALL_TIMEOUT_MS) || 30_000);
const CONNECTION_IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_TOOLS_PER_SERVER = 40;
const MAX_RESULT_CHARS = 30_000;

/** cacheKey → { clientPromise, lastUsedAt, close } */
const connectionCache = new Map();

function slugifyServerName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return slug || 'server';
}

function decryptHeaders(headersEncrypted) {
  if (!headersEncrypted) return {};
  try {
    const { decrypt } = require('../../utils/encryption');
    const parsed = JSON.parse(decrypt(headersEncrypted));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    try { console.warn('[mcp-client] failed to decrypt server headers:', err.message); } catch (_) { /* noop */ }
    return {};
  }
}

function mcpAllowPrivate() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.SIRAGPT_MCP_ALLOW_PRIVATE || '').toLowerCase());
}

/**
 * Second SSRF defense layer for MCP transports (mirrors web-fetch's
 * resolveAndAssertSafe). validateServerInput() only inspects the hostname
 * STRING at registration time, and isPrivateOrReservedAddress returns false
 * for any non-IP-literal hostname — so a public hostname whose DNS resolves
 * to a private / loopback / cloud-metadata address (169.254.169.254 etc.)
 * slips through registration and is then reached at connect time with the
 * user's stored auth headers (anti-rebinding hole). Resolve the host and
 * reject private/reserved records before opening any socket. Gated by
 * SIRAGPT_MCP_ALLOW_PRIVATE for self-hosted LAN deployments. Never leaks the
 * raw WebFetchError type; on any failure the connect is refused.
 *
 * `server._lookup` may be injected in tests to stub DNS.
 */
async function assertServerHostSafe(server) {
  if (mcpAllowPrivate()) return;
  let host;
  try {
    host = new URL(server.url).hostname.replace(/^\[|\]$/g, '');
  } catch (_) {
    throw new Error('mcp server has an invalid URL');
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('mcp server host resolves to a private / loopback / metadata address');
  }
  try {
    const { resolveAndAssertSafe } = require('../connectors/web-fetch');
    await resolveAndAssertSafe(host, server._lookup);
  } catch (err) {
    if (err && err.code === 'web_fetch_resolved_blocked') {
      throw new Error('mcp server host resolves to a private / loopback / metadata address');
    }
    throw new Error(`mcp server host DNS check failed: ${(err && err.message) || String(err)}`);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function mcpSsrfGuardEnabled() {
  // Connect-time SSRF guard is ON by default; explicit kill-switch
  // (SIRAGPT_MCP_SSRF_GUARD=0) only for emergencies.
  return !['0', 'false', 'no', 'off'].includes(String(process.env.SIRAGPT_MCP_SSRF_GUARD || '').toLowerCase());
}

/**
 * Re-resolve an MCP server host at CONNECT time and reject private /
 * reserved IPs. The registration check (validateServerInput) only sees
 * the hostname string, so a domain that rebinds to a private IP after
 * registration would slip through; this closes that DNS-rebinding hole
 * by reusing web-fetch's DNS-resolving guard. Operators who legitimately
 * point at LAN servers opt out with SIRAGPT_MCP_ALLOW_PRIVATE (the same
 * flag as registration). A sub-TTL rebind between this check and the SDK
 * transport's own fetch is a residual TOCTOU window, but the bar is
 * raised substantially. `lookup` is injectable for tests.
 */
async function assertMcpHostSafe(host, { lookup } = {}) {
  if (!mcpSsrfGuardEnabled() || mcpAllowPrivate()) return;
  // eslint-disable-next-line global-require
  const { resolveAndAssertSafe } = require('../connectors/web-fetch');
  await resolveAndAssertSafe(String(host || ''), lookup);
}

async function connectClient(server) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const headers = decryptHeaders(server.headersEncrypted);
  const url = new URL(server.url);
  // SSRF hardening: block hosts that resolve to private/reserved IPs at
  // connect time (defends against DNS-rebinding the registration-time
  // hostname check cannot see). Throws → the connection attempt fails.
  await assertMcpHostSafe(url.hostname);

  async function attempt(transportKind) {
    const client = new Client(
      { name: 'siragpt-agent', version: '1.0.0' },
      { capabilities: {} },
    );
    let transport;
    if (transportKind === 'sse') {
      const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
      transport = new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init && init.headers), ...headers } }) },
      });
    } else {
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    }
    try {
      await client.connect(transport);
    } catch (err) {
      // A failed kind must close its (possibly half-open) transport before the
      // loop tries the next one — otherwise the EventSource/socket leaks.
      try { await client.close(); } catch (_) { /* noop */ }
      throw err;
    }
    return client;
  }

  const preferred = server.transport === 'sse' ? ['sse'] : ['streamable-http', 'sse'];
  let lastErr = null;
  for (const kind of preferred) {
    const attemptPromise = attempt(kind);
    try {
      return await withTimeout(attemptPromise, DISCOVERY_TIMEOUT_MS, `mcp connect (${kind})`);
    } catch (err) {
      lastErr = err;
      // The timeout abandons the in-flight attempt: if connect() later resolves,
      // close the orphaned client (open transport/EventSource) instead of leaking
      // it for the process lifetime. Rejections (already closed above) are no-ops.
      attemptPromise.then((client) => { try { client.close(); } catch (_) { /* noop */ } }).catch(() => {});
    }
  }
  throw lastErr || new Error('mcp connect failed');
}

function cacheKeyFor(server) {
  return `${server.id || server.url} ${server.updatedAt ? new Date(server.updatedAt).getTime() : ''}`;
}

async function getClient(server) {
  const key = cacheKeyFor(server);
  const cached = connectionCache.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.clientPromise;
  }
  const entry = {
    lastUsedAt: Date.now(),
    clientPromise: connectClient(server).catch((err) => {
      connectionCache.delete(key); // never cache a failed connection
      throw err;
    }),
  };
  connectionCache.set(key, entry);
  sweepIdleConnections();
  return entry.clientPromise;
}

function sweepIdleConnections() {
  const now = Date.now();
  for (const [key, entry] of connectionCache) {
    if (now - entry.lastUsedAt > CONNECTION_IDLE_TTL_MS) {
      connectionCache.delete(key);
      entry.clientPromise
        .then((client) => { try { client.close(); } catch (_) { /* noop */ } })
        .catch(() => {});
    }
  }
}

function dropConnection(server) {
  const key = cacheKeyFor(server);
  const entry = connectionCache.get(key);
  if (!entry) return;
  connectionCache.delete(key);
  entry.clientPromise
    .then((client) => { try { client.close(); } catch (_) { /* noop */ } })
    .catch(() => {});
}

/** Normalize an MCP CallToolResult into a compact, model-friendly payload. */
function normalizeCallResult(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  const texts = [];
  const other = [];
  for (const part of parts) {
    if (part && part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part && part.type) other.push({ type: part.type });
  }
  let text = texts.join('\n');
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}…[truncated ${MAX_RESULT_CHARS} of ${text.length} chars]`;
  }
  return {
    ...(result && result.isError ? { error: text || 'MCP tool reported an error' } : { text }),
    ...(result && result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    ...(other.length ? { nonTextParts: other } : {}),
  };
}

/** Make a third-party JSON schema safe for our AJV/OpenAI pipeline. */
function sanitizeInputSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  try {
    const { sanitizeJsonSchema } = require('../ai-product-os/tool-schema-sanitizer');
    if (typeof sanitizeJsonSchema === 'function') {
      const sanitized = sanitizeJsonSchema(JSON.parse(JSON.stringify(schema)));
      if (sanitized && sanitized.type === 'object') return sanitized;
    }
  } catch (_) { /* sanitizer optional */ }
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$schema;
  if (clone.type !== 'object') {
    return { type: 'object', properties: clone.properties || {}, additionalProperties: true };
  }
  return clone;
}

/**
 * Build `mcp__<slug>__<tool>` names, capped at 64 chars. The TOOL-NAME segment
 * is truncated (not the whole id, which would lose the prefix) and names are
 * de-duped within the server with a numeric suffix — two tool names that collide
 * after truncation used to map to the same namespaced name and shadow each other.
 */
function namespaceToolNames(slug, rawNames) {
  const prefix = `mcp__${slug}__`;
  const nameBudget = Math.max(8, 64 - prefix.length);
  const emitted = new Set();
  return (rawNames || []).map((rawName) => {
    const clean = String(rawName || 'tool').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, nameBudget);
    let namespaced = `${prefix}${clean}`;
    for (let n = 2; emitted.has(namespaced); n += 1) {
      const suffix = `_${n}`;
      namespaced = `${prefix}${clean.slice(0, nameBudget - suffix.length)}${suffix}`;
    }
    emitted.add(namespaced);
    return namespaced;
  });
}

/**
 * Discover a server's tools and project them as harness tool definitions
 * ({name, description, parameters, execute} — react-agent shape, plus
 * `mcp: true` so the registry assigns the 'confirm' tier by default).
 */
async function discoverServerTools(server) {
  // SSRF re-validation: refuse before connecting if the host DNS-resolves to a
  // private / loopback / metadata address (a public hostname that rebinds).
  await assertServerHostSafe(server);
  const client = await getClient(server);
  const listed = await withTimeout(client.listTools(), DISCOVERY_TIMEOUT_MS, 'mcp listTools');
  const slug = slugifyServerName(server.name);
  const tools = Array.isArray(listed && listed.tools) ? listed.tools.slice(0, MAX_TOOLS_PER_SERVER) : [];
  const namespacedNames = namespaceToolNames(slug, tools.map((t) => t && t.name));
  return tools.map((tool, idx) => {
    const namespaced = namespacedNames[idx];
    return {
      name: namespaced,
      description: `[MCP · ${server.name}] ${String(tool.description || tool.name || '').slice(0, 800)}`,
      parameters: sanitizeInputSchema(tool.inputSchema),
      mcp: { serverId: server.id, serverName: server.name, toolName: tool.name },
      execute: async (args) => {
        try {
          const liveClient = await getClient(server);
          const result = await withTimeout(
            liveClient.callTool({ name: tool.name, arguments: args || {} }),
            CALL_TIMEOUT_MS,
            `mcp ${server.name}/${tool.name}`,
          );
          const normalized = normalizeCallResult(result);
          if (normalized.error) throw new Error(`mcp_tool_error: ${normalized.error}`);
          return normalized;
        } catch (err) {
          // A broken pipe poisons the cached session — drop it so the next
          // call reconnects fresh instead of failing forever.
          if (/timed out|fetch failed|ECONNREFUSED|ECONNRESET|socket|closed/i.test(String(err && err.message))) {
            dropConnection(server);
          }
          throw err;
        }
      },
    };
  });
}

/**
 * Load every enabled MCP server of a user and return their tools, ready to
 * merge into the turn's toolset. NEVER throws: per-server failures are
 * logged and reported in `errors`, the rest of the chat continues.
 */
async function loadUserMcpTools({ userId, prisma }) {
  if (!userId || !prisma || !prisma.mcpServer || typeof prisma.mcpServer.findMany !== 'function') {
    return { tools: [], errors: [] };
  }
  let servers = [];
  try {
    servers = await prisma.mcpServer.findMany({
      where: { userId: String(userId), enabled: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  } catch (err) {
    try { console.warn('[mcp-client] mcp_servers lookup failed:', err.message); } catch (_) { /* noop */ }
    return { tools: [], errors: [{ server: null, error: err.message }] };
  }
  const tools = [];
  const errors = [];
  await Promise.all(servers.map(async (server) => {
    try {
      const discovered = await discoverServerTools(server);
      tools.push(...discovered);
    } catch (err) {
      errors.push({ server: server.name, error: err && err.message ? err.message : String(err) });
      try { console.warn(`[mcp-client] server "${server.name}" unavailable:`, err && err.message); } catch (_) { /* noop */ }
    }
  }));
  return { tools, errors };
}

// ── Server registration validation (used by the /api/agent/mcp-servers routes) ──
const serverInputSchema = z.object({
  name: z.string().min(1).max(48),
  url: z.string().url().max(2_000),
  transport: z.enum(['streamable-http', 'sse']).optional().default('streamable-http'),
  headers: z.record(z.string(), z.string().max(4_000)).optional(),
  enabled: z.boolean().optional().default(true),
}).strict();

function validateServerInput(body) {
  const parsed = serverInputSchema.safeParse(body || {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; ') };
  }
  let url;
  try { url = new URL(parsed.data.url); } catch (_) { return { ok: false, error: 'url is not a valid absolute URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'only http(s) MCP servers are supported' };
  }
  try {
    const { isPrivateOrReservedAddress } = require('../connectors/web-fetch');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || isPrivateOrReservedAddress(host)) {
      // Self-hosted deployments may legitimately point at LAN servers —
      // operators opt in explicitly.
      if (!mcpAllowPrivate()) {
        return { ok: false, error: 'private/localhost MCP servers are disabled (set SIRAGPT_MCP_ALLOW_PRIVATE=1 to allow)' };
      }
    }
  } catch (_) { /* guard is best-effort */ }
  return { ok: true, data: parsed.data };
}

function encryptHeaders(headers) {
  if (!headers || typeof headers !== 'object' || !Object.keys(headers).length) return null;
  const { encrypt } = require('../../utils/encryption');
  return encrypt(JSON.stringify(headers));
}

/** Tests only. */
function resetForTests() {
  for (const [, entry] of connectionCache) {
    entry.clientPromise.then((client) => { try { client.close(); } catch (_) { /* noop */ } }).catch(() => {});
  }
  connectionCache.clear();
}

module.exports = {
  loadUserMcpTools,
  discoverServerTools,
  namespaceToolNames,
  normalizeCallResult,
  sanitizeInputSchema,
  slugifyServerName,
  validateServerInput,
  encryptHeaders,
  decryptHeaders,
  resetForTests,
  assertMcpHostSafe,
  mcpAllowPrivate,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
};
