'use strict';

/**
 * Remote sandbox driver — implements the same interface as the local/docker
 * drivers in ./sandbox.js by proxying to the standalone sandbox microservice
 * (services/sandbox) over HTTPS. This is what lets the app (Replit, no Docker)
 * run document tasks: the agentic LOOP stays in the app (with the LLM key),
 * while tool EXECUTION happens in a network-less container on the sandbox host.
 *
 * Selected automatically by createSandbox() when SANDBOX_SERVICE_URL +
 * SANDBOX_API_KEY are set. Injectable `fetchImpl` for offline tests.
 */

const DEFAULT_TIMEOUT_MS = 130_000;

function createRemoteSandbox({ baseUrl, apiKey, fetchImpl } = {}) {
  const base = String(baseUrl || process.env.SANDBOX_SERVICE_URL || '').replace(/\/+$/, '');
  const key = apiKey || process.env.SANDBOX_API_KEY || '';
  const doFetch = fetchImpl || globalThis.fetch;
  if (!base) throw new Error('createRemoteSandbox: SANDBOX_SERVICE_URL is required');
  if (!key) throw new Error('createRemoteSandbox: SANDBOX_API_KEY is required');
  if (typeof doFetch !== 'function') throw new Error('createRemoteSandbox: fetch is not available');

  let sessionId = null;
  let destroyed = false;

  async function call(method, p, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const res = await doFetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: 'bad_json', raw: text.slice(0, 300) }; }
    if (!res.ok) throw new Error(`sandbox service ${res.status}: ${json.error || text.slice(0, 200)}`);
    return json;
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const r = await call('POST', '/v1/sessions', {}, { timeoutMs: 40_000 });
    sessionId = r.sessionId;
    if (!sessionId) throw new Error('sandbox service returned no sessionId');
    return sessionId;
  }

  return {
    driver: 'remote',
    root: '/workspace',
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('sandbox destroyed');
      const id = await ensureSession();
      return call('POST', `/v1/sessions/${id}/exec`, { command: String(command), timeoutMs: opts.timeoutMs }, { timeoutMs: (opts.timeoutMs || 120_000) + 10_000 });
    },
    async putFile(relPath, buffer) {
      const id = await ensureSession();
      const r = await call('POST', `/v1/sessions/${id}/put`, { path: relPath, contentBase64: Buffer.from(buffer).toString('base64') });
      return r.path;
    },
    async readFile(relPath) {
      const id = await ensureSession();
      const r = await call('POST', `/v1/sessions/${id}/read`, { path: relPath });
      return Buffer.from(String(r.contentBase64 || ''), 'base64');
    },
    async writeFile(relPath, content) {
      const id = await ensureSession();
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      await call('POST', `/v1/sessions/${id}/write`, { path: relPath, contentBase64: buf.toString('base64') });
    },
    async listFiles(relDir = '.') {
      const id = await ensureSession();
      const r = await call('POST', `/v1/sessions/${id}/list`, { path: relDir });
      return Array.isArray(r.files) ? r.files : [];
    },
    async collectOutputs() {
      const id = await ensureSession();
      const r = await call('GET', `/v1/sessions/${id}/outputs`, undefined, { timeoutMs: 60_000 });
      return (Array.isArray(r.outputs) ? r.outputs : []).map((o) => ({ name: o.name, buffer: Buffer.from(String(o.contentBase64 || ''), 'base64') }));
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      if (sessionId) { try { await call('DELETE', `/v1/sessions/${sessionId}`, undefined, { timeoutMs: 20_000 }); } catch (_) {} }
    },
  };
}

module.exports = { createRemoteSandbox };
