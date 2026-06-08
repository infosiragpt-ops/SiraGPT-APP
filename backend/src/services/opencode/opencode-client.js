'use strict';

/**
 * opencode-client — thin HTTP client for a running OpenCode server
 * (`opencode serve`). Stdlib fetch only, injectable for tests. This is the
 * Phase-0 integration seam: every concrete endpoint path lives in ENDPOINTS so
 * they can be reconciled against the live server's OpenAPI (`GET /doc`) without
 * touching call sites.
 *
 * Fail-soft: `createOpencodeClient` returns null when no server is configured,
 * mirroring `createCerebrasClient`, so routes degrade instead of throwing.
 */

const { getOpencodeConfig, basicAuthHeader } = require('./opencode-config');

// Endpoint shapes per opencode.ai/docs (server mode). Reconcile against /doc
// on a live server before depending on the exact request/response bodies.
const ENDPOINTS = {
  openapi: () => '/doc',
  sessions: () => '/session',
  session: (id) => `/session/${encodeURIComponent(id)}`,
  message: (id) => `/session/${encodeURIComponent(id)}/message`,
  file: () => '/file',
  find: () => '/find',
  event: () => '/event',
};

class OpencodeHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'OpencodeHttpError';
    this.status = status;
    this.body = body;
  }
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(baseUrl + path);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Create a client, or null when OpenCode isn't configured.
 * @param {{ env?: object, fetchImpl?: Function }} [opts]
 */
function createOpencodeClient({ env = process.env, fetchImpl } = {}) {
  const config = getOpencodeConfig({ env });
  if (!config.enabled) return null;

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('opencode-client: no fetch implementation available');
  }
  const auth = basicAuthHeader(config);

  async function request(method, path, { query, body, signal } = {}) {
    const url = buildUrl(config.baseUrl, path, query);
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = auth;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await doFetch(url, { method, headers, body: payload, signal });
    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch { /* non-JSON error */ }
      throw new OpencodeHttpError(
        `opencode ${method} ${path} → HTTP ${res.status}`,
        { status: res.status, body: errBody },
      );
    }
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  return {
    config,
    request,
    /** Connectivity check — fetches the OpenAPI document. */
    ping(opts) { return request('GET', ENDPOINTS.openapi(), opts); },
    listSessions(opts) { return request('GET', ENDPOINTS.sessions(), opts); },
    createSession(body = {}, opts) { return request('POST', ENDPOINTS.sessions(), { ...opts, body }); },
    /** Send a text prompt to a session (OpenCode message-parts shape). */
    prompt(sessionId, text, opts) {
      return request('POST', ENDPOINTS.message(sessionId), {
        ...opts,
        body: { parts: [{ type: 'text', text: String(text) }] },
      });
    },
    readFile(path, opts) { return request('GET', ENDPOINTS.file(), { ...opts, query: { path } }); },
    findText(pattern, opts) { return request('GET', ENDPOINTS.find(), { ...opts, query: { pattern } }); },
    /** Absolute URL of the SSE event stream (for a backend→frontend proxy). */
    eventStreamUrl() { return buildUrl(config.baseUrl, ENDPOINTS.event()); },
  };
}

module.exports = { createOpencodeClient, OpencodeHttpError, ENDPOINTS };
