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
const dns = require('node:dns').promises;

const DISCOVERY_TIMEOUT_MS = Math.max(1_000, Number(process.env.SIRAGPT_MCP_DISCOVERY_TIMEOUT_MS) || 8_000);
const CALL_TIMEOUT_MS = Math.max(1_000, Number(process.env.SIRAGPT_MCP_CALL_TIMEOUT_MS) || 30_000);
const CONNECTION_IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_TOOLS_PER_SERVER = 40;
const MAX_RESULT_CHARS = 30_000;

/** cacheKey → { clientPromise, lastUsedAt, close } */
const connectionCache = new Map();
const auditedPolicyErrors = new WeakSet();

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
  } catch (_err) {
    try { console.warn('[mcp-client] failed to decrypt server headers'); } catch (_) { /* noop */ }
    return {};
  }
}

function mcpAllowPrivate() {
  // Legacy compatibility surface. Private/LAN bypasses are intentionally no
  // longer honored; only explicit non-production HTTP loopback is supported.
  return false;
}

/**
 * Second SSRF defense layer for MCP transports (mirrors web-fetch's
 * resolveAndAssertSafe). validateServerInput() only inspects the hostname
 * STRING at registration time, and isPrivateOrReservedAddress returns false
 * for any non-IP-literal hostname — so a public hostname whose DNS resolves
 * to a private / loopback / cloud-metadata address (169.254.169.254 etc.)
 * slips through registration and is then reached at connect time with the
 * user's stored auth headers (anti-rebinding hole). Resolve the host and
 * reject private/reserved records before opening any socket. Legacy private
 * network bypass flags are intentionally ignored; on any failure the
 * connection is refused.
 *
 * `server._lookup` may be injected in tests to stub DNS.
 */
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
  // Legacy compatibility surface. DNS rebinding protection is mandatory.
  return true;
}

/**
 * Resolve an MCP server host at connection/call time and reject private /
 * reserved IPs. The transport passes the resulting address to a pinned Undici
 * connector, closing the former check-then-resolve TOCTOU window: socket DNS
 * never runs independently from this validation. Redirect hops get a fresh
 * validated pin; final URLs are origin-authorized against the pin actually
 * used. `lookup` is injectable for tests.
 */
async function assertMcpHostSafe(host, { lookup, allowLoopback = false } = {}) {
  const {
    isLoopbackHostname,
    isPrivateOrReservedIp,
  } = require('./mcp-policy');
  let records;
  try {
    records = await (lookup || dns.lookup)(String(host || ''), { all: true });
  } catch (_error) {
    const error = new Error('mcp server host DNS check failed');
    error.code = 'MCP_DNS_LOOKUP_FAILED';
    throw error;
  }
  if (!Array.isArray(records) || records.length === 0) {
    const error = new Error('mcp server host DNS check failed');
    error.code = 'MCP_DNS_LOOKUP_FAILED';
    throw error;
  }
  for (const record of records) {
    const address = record && record.address;
    if (
      !address
      || (allowLoopback
        ? !isLoopbackHostname(address)
        : isPrivateOrReservedIp(address))
    ) {
      const error = new Error(
        'mcp server host resolves to a private / loopback / metadata / reserved address',
      );
      error.code = 'MCP_PRIVATE_ADDRESS_DENIED';
      error.status = 403;
      throw error;
    }
  }
  return records.map((record) => Object.freeze({
    address: String(record.address),
    family: Number(record.family) || 0,
  }));
}

async function authorizeServerUrl(server, phase, rawUrl = server && server.url) {
  if (server && typeof server._authorize === 'function') {
    return server._authorize(rawUrl, phase);
  }
  const { validateMcpServerUrl } = require('./mcp-policy');
  return validateMcpServerUrl(rawUrl, { env: (server && server._env) || process.env });
}

function createBoundPolicyAuthorize(server, policyContextFingerprint) {
  const expected = policyContextFingerprint == null
    ? null
    : String(policyContextFingerprint);
  return async (rawUrl, phase) => {
    const checked = await authorizeServerUrl(server, phase, rawUrl);
    if (
      expected
      && checked.policyContextFingerprint !== expected
    ) {
      throw mcpRuntimeError(
        'MCP_POLICY_CONTEXT_CHANGED',
        403,
        'MCP policy context changed',
      );
    }
    return checked;
  };
}

async function assertServerHostSafe(server, validation = null) {
  const checked = validation || await authorizeServerUrl(server, 'dns');
  const records = await assertMcpHostSafe(checked.hostname, {
    lookup: server && server._lookup,
    allowLoopback: checked.loopback,
  });
  return { ...checked, records };
}

function createPinnedDispatcher({
  hostname,
  address,
  family,
  createAgent,
  buildConnector: buildConnectorImpl,
} = {}) {
  const { normalizeHostname } = require('./mcp-policy');
  const expectedHostname = normalizeHostname(hostname);
  const pinFamily = Number(family);
  if (!address || ![4, 6].includes(pinFamily)) {
    throw new TypeError('mcp pinned dispatcher requires a valid DNS record');
  }
  const {
    Agent,
    buildConnector,
  } = require('undici');
  const makeConnector = buildConnectorImpl || buildConnector;
  const makeAgent = createAgent || ((options) => new Agent(options));
  const pinnedLookup = (requestedHostname, options, callback) => {
    let requested;
    try {
      requested = normalizeHostname(requestedHostname);
    } catch (error) {
      callback(error);
      return;
    }
    if (requested !== expectedHostname) {
      const error = new Error('mcp pinned dispatcher hostname mismatch');
      error.code = 'MCP_PINNED_HOST_MISMATCH';
      callback(error);
      return;
    }
    if (options && options.all) {
      callback(null, [{ address: String(address), family: pinFamily }]);
      return;
    }
    callback(null, String(address), pinFamily);
  };
  const connector = makeConnector({
    lookup: pinnedLookup,
    // The socket connects to the pinned address through `lookup`, while TLS
    // certificate verification and SNI continue to use the authorized host.
    servername: expectedHostname,
  });
  return makeAgent({
    connect: connector,
    connections: 1,
    pipelining: 1,
  });
}

function drainDispatcher(dispatcher, { force = false } = {}) {
  if (!dispatcher) return Promise.resolve();
  try {
    if (force && typeof dispatcher.destroy === 'function') {
      return Promise.resolve(dispatcher.destroy()).catch(() => {});
    }
    if (typeof dispatcher.close === 'function') {
      return Promise.resolve(dispatcher.close()).catch(() => {});
    }
  } catch (_error) {
    return Promise.resolve();
  }
  return Promise.resolve();
}

function createPolicyFetch({
  serverUrl,
  authorize,
  lookup,
  fetchImpl = globalThis.fetch,
  createDispatcher = createPinnedDispatcher,
  maxRedirects = 5,
} = {}) {
  if (
    typeof authorize !== 'function'
    || typeof fetchImpl !== 'function'
    || typeof createDispatcher !== 'function'
  ) {
    throw new TypeError('mcp guarded fetch requires authorize, fetch, and dispatcher');
  }
  const expectedOrigin = new URL(serverUrl).origin;
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);

  async function validateTarget(rawUrl, phase, originCode, { resolveDns = true } = {}) {
    const checked = await authorize(String(rawUrl), phase);
    if (checked.origin !== expectedOrigin) {
      const error = new Error('mcp transport origin blocked by policy');
      error.code = originCode;
      error.status = 403;
      throw error;
    }
    if (!resolveDns) return checked;
    const records = await assertMcpHostSafe(checked.hostname, {
      lookup,
      allowLoopback: checked.loopback,
    });
    return { ...checked, records };
  }

  return async function policyFetch(input, init = {}) {
    let currentUrl = input instanceof URL
      ? input.toString()
      : (typeof input === 'string' ? input : input && input.url);
    if (!currentUrl) {
      const error = new Error('mcp transport request URL is invalid');
      error.code = 'MCP_URL_INVALID';
      throw error;
    }
    let requestInit = { ...init, redirect: 'manual' };
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const checked = await validateTarget(currentUrl, 'transport', 'MCP_REQUEST_ORIGIN_FORBIDDEN');
      const pin = checked.records[0];
      const dispatcher = createDispatcher({
        hostname: checked.hostname,
        address: pin.address,
        family: pin.family,
      });
      let response;
      try {
        response = await fetchImpl(checked.url, {
          ...requestInit,
          // Security invariant: Undici's connector receives the already
          // validated address and must not perform an independent DNS lookup.
          dispatcher,
        });
      } catch (error) {
        await drainDispatcher(dispatcher, { force: true });
        throw error;
      }
      // close() drains the active response without aborting it. For SSE this
      // remains pending until the stream/client closes; for finite responses
      // the socket is released promptly instead of entering a reusable pool.
      void drainDispatcher(dispatcher);
      if (redirectStatuses.has(Number(response && response.status))) {
        const location = response && response.headers && response.headers.get
          ? response.headers.get('location')
          : null;
        if (!location) return response;
        if (redirects >= maxRedirects) {
          const error = new Error('mcp transport redirect limit exceeded');
          error.code = 'MCP_REDIRECT_LIMIT';
          throw error;
        }
        const nextUrl = new URL(location, checked.url).toString();
        await validateTarget(
          nextUrl,
          'redirect',
          'MCP_REDIRECT_ORIGIN_FORBIDDEN',
          { resolveDns: false },
        );
        try {
          if (response && response.body && typeof response.body.cancel === 'function') {
            await response.body.cancel();
          }
        } catch (_) { /* response disposal is best-effort */ }
        currentUrl = nextUrl;
        if (Number(response.status) === 303) {
          const headers = new Headers(requestInit.headers || {});
          headers.delete('content-length');
          headers.delete('content-type');
          requestInit = {
            ...requestInit,
            method: 'GET',
            body: undefined,
            headers,
          };
        }
        continue;
      }
      if (response && response.url) {
        // The final URL was reached through this hop's pinned dispatcher.
        // Re-authorize its origin, but do not perform a second DNS lookup that
        // could observe a rebinding answer unrelated to the actual socket.
        await validateTarget(
          response.url,
          'final',
          'MCP_FINAL_ORIGIN_FORBIDDEN',
          { resolveDns: false },
        );
      }
      return response;
    }
    throw new Error('mcp transport redirect limit exceeded');
  };
}

async function connectClient(server) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const headers = decryptHeaders(server.headersEncrypted);
  const validation = await authorizeServerUrl(server, 'connect');
  const boundPolicyContext = server._policyContextFingerprint
    || validation.policyContextFingerprint
    || null;
  if (
    server._policyContextFingerprint
    && validation.policyContextFingerprint !== server._policyContextFingerprint
  ) {
    throw mcpRuntimeError(
      'MCP_POLICY_CONTEXT_CHANGED',
      403,
      'MCP policy context changed',
    );
  }
  await assertServerHostSafe(server, validation);
  const url = new URL(validation.url);
  const boundAuthorize = createBoundPolicyAuthorize(server, boundPolicyContext);
  const guardedFetch = createPolicyFetch({
    serverUrl: validation.url,
    authorize: boundAuthorize,
    lookup: server._lookup,
    fetchImpl: server._fetch || globalThis.fetch,
    createDispatcher: server._createDispatcher || createPinnedDispatcher,
  });

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
        eventSourceInit: { fetch: guardedFetch },
        fetch: guardedFetch,
      });
    } else {
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        fetch: guardedFetch,
      });
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

function contextIdentityFor(server) {
  if (server?._contextIdentityFingerprint) {
    return String(server._contextIdentityFingerprint);
  }
  const { createMcpContextIdentityFingerprint } = require('./mcp-policy');
  return createMcpContextIdentityFingerprint({
    userId: server?._userId ?? server?.userId ?? null,
    requestedOrganizationId: server?._requestedOrganizationId ?? null,
    activeOrganizationId: server?._activeOrganizationId ?? null,
  });
}

function policyContextFor(server) {
  return String(server?._policyContextFingerprint || `unresolved:${contextIdentityFor(server)}`);
}

function cacheKeyFor(server) {
  return [
    serverRevision(server),
    contextIdentityFor(server),
    policyContextFor(server),
  ].join('\u0000');
}

function closeCacheEntry(entry) {
  if (!entry) return;
  entry.clientPromise
    .then((client) => { try { client.close(); } catch (_) { /* noop */ } })
    .catch(() => {});
}

async function getClient(server) {
  const key = cacheKeyFor(server);
  const cached = connectionCache.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.clientPromise;
  }
  const serverId = server?.id ? String(server.id) : null;
  const contextIdentityFingerprint = contextIdentityFor(server);
  // A changed policy fingerprint replaces only this tenant context's prior
  // generation. Personal/org-A/org-B sessions can coexist without closing or
  // reusing one another's authorization closure or decrypted-header client.
  for (const [staleKey, entry] of connectionCache) {
    if (
      staleKey !== key
      && entry.serverId === serverId
      && entry.contextIdentityFingerprint === contextIdentityFingerprint
    ) {
      connectionCache.delete(staleKey);
      closeCacheEntry(entry);
    }
  }
  const connectClientImpl = typeof server?._connectClient === 'function'
    ? server._connectClient
    : connectClient;
  const entry = {
    serverId,
    contextIdentityFingerprint,
    policyContextFingerprint: policyContextFor(server),
    lastUsedAt: Date.now(),
    clientPromise: Promise.resolve().then(() => connectClientImpl(server)).catch((err) => {
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
      closeCacheEntry(entry);
    }
  }
}

function dropConnection(server, { scope = 'exact' } = {}) {
  if (scope === 'server' && server?.id) {
    invalidateServerConnections(server.id);
    return;
  }
  if (scope === 'context' && server?.id) {
    invalidateServerContextConnections(server.id, contextIdentityFor(server));
    return;
  }
  const key = cacheKeyFor(server);
  const entry = connectionCache.get(key);
  if (!entry) return;
  connectionCache.delete(key);
  closeCacheEntry(entry);
}

function invalidateServerConnections(serverId) {
  const target = String(serverId || '');
  if (!target) return 0;
  let invalidated = 0;
  for (const [key, entry] of connectionCache) {
    if (entry.serverId !== target) continue;
    connectionCache.delete(key);
    invalidated += 1;
    closeCacheEntry(entry);
  }
  return invalidated;
}

function invalidateServerContextConnections(serverId, contextIdentityFingerprint) {
  const target = String(serverId || '');
  const context = String(contextIdentityFingerprint || '');
  if (!target || !context) return 0;
  let invalidated = 0;
  for (const [key, entry] of connectionCache) {
    if (
      entry.serverId !== target
      || entry.contextIdentityFingerprint !== context
    ) {
      continue;
    }
    connectionCache.delete(key);
    invalidated += 1;
    closeCacheEntry(entry);
  }
  return invalidated;
}

function serverRevision(server) {
  const updatedAt = server && server.updatedAt
    ? new Date(server.updatedAt).getTime()
    : Number.NaN;
  return [
    String(server?.id || ''),
    Number.isFinite(updatedAt) ? String(updatedAt) : '',
    String(server?.url || ''),
    String(server?.transport || ''),
    String(server?.headersEncrypted || ''),
  ].join('\u0000');
}

function mcpRuntimeError(code, status, message) {
  const error = new Error(message);
  error.name = 'McpPolicyError';
  error.code = code;
  error.status = status;
  return error;
}

function applyAuthorizedPolicyContext(server, validation) {
  if (!server || !validation) return server;
  if (validation.contextIdentityFingerprint) {
    server._contextIdentityFingerprint = validation.contextIdentityFingerprint;
  }
  if (validation.policyContextFingerprint) {
    server._policyContextFingerprint = validation.policyContextFingerprint;
  }
  return server;
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
async function discoverServerTools(server, {
  getClientImpl = getClient,
  dropClientImpl = dropConnection,
} = {}) {
  let activeServer = server;
  // SSRF re-validation: refuse before connecting if the host DNS-resolves to a
  // private / loopback / metadata address (a public hostname that rebinds).
  const discoveryValidation = await authorizeServerUrl(activeServer, 'discovery');
  applyAuthorizedPolicyContext(activeServer, discoveryValidation);
  await assertServerHostSafe(activeServer, discoveryValidation);
  const client = await getClientImpl(activeServer);
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
          if (typeof activeServer._refresh === 'function') {
            let refreshed;
            try {
              refreshed = await activeServer._refresh();
            } catch (error) {
              try { error._mcpConnectionScope = 'server'; } catch (_) { /* noop */ }
              throw error;
            }
            if (!refreshed || refreshed.enabled === false) {
              const error = mcpRuntimeError(
                'MCP_SERVER_DISABLED',
                403,
                'MCP server is disabled or unavailable',
              );
              error._mcpConnectionScope = 'server';
              throw error;
            }
            if (serverRevision(refreshed) !== serverRevision(activeServer)) {
              await Promise.resolve(dropClientImpl(activeServer, { scope: 'server' }));
            }
            activeServer = refreshed;
          }
          const previousIdentity = activeServer._contextIdentityFingerprint;
          const previousPolicy = activeServer._policyContextFingerprint;
          const callValidation = await authorizeServerUrl(activeServer, 'call');
          if (
            previousIdentity
            && callValidation.contextIdentityFingerprint
            && previousIdentity !== callValidation.contextIdentityFingerprint
          ) {
            await Promise.resolve(dropClientImpl(activeServer, { scope: 'context' }));
            throw mcpRuntimeError(
              'MCP_ORG_CONTEXT_UNVERIFIED',
              403,
              'MCP organization context was not verified',
            );
          }
          if (
            previousPolicy
            && callValidation.policyContextFingerprint
            && previousPolicy !== callValidation.policyContextFingerprint
          ) {
            await Promise.resolve(dropClientImpl(activeServer, { scope: 'context' }));
          }
          applyAuthorizedPolicyContext(activeServer, callValidation);
          await assertServerHostSafe(activeServer, callValidation);
          const liveClient = await getClientImpl(activeServer);
          const result = await withTimeout(
            liveClient.callTool({ name: tool.name, arguments: args || {} }),
            CALL_TIMEOUT_MS,
            `mcp ${server.name}/${tool.name}`,
          );
          const normalized = normalizeCallResult(result);
          if (normalized.error) throw new Error(`mcp_tool_error: ${normalized.error}`);
          return normalized;
        } catch (err) {
          if (typeof activeServer._auditPolicyDenial === 'function') {
            await activeServer._auditPolicyDenial('call', err);
          }
          if (isMcpPolicyDenial(err)) {
            await Promise.resolve(dropClientImpl(activeServer, {
              scope: err._mcpConnectionScope || 'context',
            }));
          }
          // A broken pipe poisons the cached session — drop it so the next
          // call reconnects fresh instead of failing forever.
          if (
            !isMcpPolicyDenial(err)
            && /timed out|fetch failed|ECONNREFUSED|ECONNRESET|socket|closed/i.test(String(err && err.message))
          ) {
            await Promise.resolve(dropClientImpl(activeServer));
          }
          throw err;
        }
      },
    };
  });
}

function safeDiscoveryErrorMessage(error) {
  const message = String(error?.message || '');
  if (error?.name === 'McpPolicyError') {
    return message || 'MCP server blocked by policy';
  }
  if (
    message === 'mcp server host DNS check failed'
    || message === 'mcp server host resolves to a private / loopback / metadata / reserved address'
    || /^mcp (?:connect \((?:sse|streamable-http)\)|listTools) timed out after \d+ms$/.test(message)
  ) {
    return message;
  }
  return 'mcp server unavailable';
}

function isMcpPolicyDenial(error) {
  return Boolean(
    error
    && (
      error.name === 'McpPolicyError'
      || (
        typeof error.code === 'string'
        && /^MCP_[A-Z0-9_]+$/.test(error.code)
        && error.code !== 'MCP_DNS_LOOKUP_FAILED'
      )
    )
  );
}

async function writeRuntimePolicyDenialAudit({
  prisma,
  userId,
  serverId,
  phase,
  error,
}) {
  if (!isMcpPolicyDenial(error) || auditedPolicyErrors.has(error)) return;
  auditedPolicyErrors.add(error);
  try {
    const { writeAuditLog } = require('../../utils/audit-log');
    await writeAuditLog(prisma, {
      action: 'mcp_server_policy_denied',
      userId: String(userId),
      resource: 'mcp_server',
      resourceId: serverId || null,
      metadata: {
        phase: String(phase || 'runtime').slice(0, 24),
        reason: error.code || 'MCP_POLICY_DENIED',
      },
      tags: ['security', 'mcp', 'policy-denial'],
    });
  } catch (_auditError) {
    // Security enforcement never depends on best-effort audit persistence.
  }
}

/**
 * Load every enabled MCP server of a user and return their tools, ready to
 * merge into the turn's toolset. NEVER throws: per-server failures are
 * logged and reported in `errors`, the rest of the chat continues.
 */
async function loadUserMcpTools({
  userId,
  organizationId,
  requestedOrganizationId,
  activeOrganizationId,
  prisma,
  env = process.env,
  getClientImpl = getClient,
  dropClientImpl = dropConnection,
}) {
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
    try { console.warn('[mcp-client] mcp_servers lookup failed'); } catch (_) { /* noop */ }
    return { tools: [], errors: [{ server: null, error: 'mcp server lookup unavailable' }] };
  }
  const tools = [];
  const errors = [];
  const splitContextProvided = (
    requestedOrganizationId !== undefined
    || activeOrganizationId !== undefined
  );
  const requestedOrg = splitContextProvided
    ? (requestedOrganizationId ?? null)
    : (organizationId ?? null);
  const activeOrg = splitContextProvided
    ? (activeOrganizationId ?? null)
    : (organizationId ?? null);
  const { createMcpContextIdentityFingerprint } = require('./mcp-policy');
  const runtimeContextIdentity = createMcpContextIdentityFingerprint({
    userId,
    requestedOrganizationId: requestedOrg,
    activeOrganizationId: activeOrg,
  });
  await Promise.all(servers.map(async (server) => {
    const auditPolicyDenial = (phase, error) => writeRuntimePolicyDenialAudit({
      prisma,
      userId,
      serverId: server.id,
      phase,
      error,
    });
    const makeRuntimeServer = (row, inheritedContext = {}) => {
      const runtimeServer = {
        ...row,
        _env: env,
        _userId: String(userId),
        _requestedOrganizationId: requestedOrg,
        _activeOrganizationId: activeOrg,
        _contextIdentityFingerprint:
          inheritedContext.contextIdentityFingerprint || runtimeContextIdentity,
        _policyContextFingerprint:
          inheritedContext.policyContextFingerprint || null,
        _auditPolicyDenial: auditPolicyDenial,
      };
      runtimeServer._authorize = async (rawUrl, phase) => {
        const { authorizeMcpServerUrl } = require('./mcp-policy');
        try {
          return await authorizeMcpServerUrl({
            prisma,
            userId,
            requestedOrganizationId: requestedOrg,
            activeOrganizationId: activeOrg,
            url: rawUrl,
            env,
          });
        } catch (error) {
          await auditPolicyDenial(phase, error);
          throw error;
        }
      };
      runtimeServer._refresh = async () => {
        if (typeof prisma.mcpServer.findFirst !== 'function') {
          throw mcpRuntimeError(
            'MCP_SERVER_LOOKUP_FAILED',
            503,
            'MCP server state is unavailable',
          );
        }
        let fresh;
        try {
          fresh = await prisma.mcpServer.findFirst({
            where: {
              id: String(row.id),
              userId: String(userId),
              enabled: true,
            },
          });
        } catch (_error) {
          throw mcpRuntimeError(
            'MCP_SERVER_LOOKUP_FAILED',
            503,
            'MCP server state is unavailable',
          );
        }
        if (!fresh) {
          throw mcpRuntimeError(
            'MCP_SERVER_DISABLED',
            403,
            'MCP server is disabled or unavailable',
          );
        }
        return makeRuntimeServer(fresh, {
          contextIdentityFingerprint: runtimeServer._contextIdentityFingerprint,
          policyContextFingerprint: runtimeServer._policyContextFingerprint,
        });
      };
      return runtimeServer;
    };
    const runtimeServer = makeRuntimeServer(server);
    try {
      const discovered = await discoverServerTools(runtimeServer, {
        getClientImpl,
        dropClientImpl,
      });
      tools.push(...discovered);
    } catch (err) {
      await auditPolicyDenial('discovery', err);
      if (isMcpPolicyDenial(err)) {
        await Promise.resolve(dropClientImpl(runtimeServer, { scope: 'context' }));
      }
      errors.push({ server: server.name, error: safeDiscoveryErrorMessage(err) });
      try { console.warn('[mcp-client] server unavailable'); } catch (_) { /* noop */ }
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

function validateServerInput(body, { env = process.env } = {}) {
  const parsed = serverInputSchema.safeParse(body || {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; ') };
  }
  try {
    const { validateMcpServerUrl } = require('./mcp-policy');
    const checked = validateMcpServerUrl(parsed.data.url, { env });
    return {
      ok: true,
      data: { ...parsed.data, url: checked.url },
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.code ? error.code : 'MCP_URL_INVALID',
      status: error && error.status ? error.status : 400,
    };
  }
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
  getClient,
  namespaceToolNames,
  normalizeCallResult,
  sanitizeInputSchema,
  slugifyServerName,
  validateServerInput,
  encryptHeaders,
  decryptHeaders,
  resetForTests,
  assertMcpHostSafe,
  assertServerHostSafe,
  createPinnedDispatcher,
  createPolicyFetch,
  createBoundPolicyAuthorize,
  invalidateServerConnections,
  invalidateServerContextConnections,
  safeDiscoveryErrorMessage,
  mcpAllowPrivate,
  mcpSsrfGuardEnabled,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
};
