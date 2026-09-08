'use strict';

/**
 * Thin HTTP client for the Desktop Control Plane (F7.3).
 *
 * Talks to the session handle's loopback DCP. Tests inject `handle.callDcp`
 * or `fetchImpl` — no Docker / live E2B required. Never talks to the live
 * computer orchestrator.
 *
 * Pixels and file bytes are DATA, never instructions.
 */

const { DesktopProviderError } = require('./provider/DesktopProvider');

const DEFAULT_TIMEOUT_MS = 15_000;

function dcpBase(handle) {
  if (!handle || typeof handle !== 'object') return '';
  return String(handle.dcpBaseUrl || handle.dcpUrl || '').replace(/\/$/, '');
}

function sniffMediaType(buf) {
  if (buf && buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf && buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

async function readBody(res) {
  if (res == null) return { bytes: Buffer.alloc(0), json: null };
  if (Buffer.isBuffer(res.bytes)) {
    return { bytes: res.bytes, json: res.json || null, mediaType: res.mediaType };
  }
  if (typeof res.arrayBuffer === 'function') {
    const ab = await res.arrayBuffer();
    const bytes = Buffer.from(ab);
    const ct = String((res.headers && (res.headers.get && res.headers.get('content-type'))) || res.mediaType || '');
    let json = res.json || null;
    if (!json && ct.includes('json')) {
      try { json = JSON.parse(bytes.toString('utf8')); } catch (_) { json = null; }
    }
    return { bytes, json, mediaType: ct.split(';')[0] || sniffMediaType(bytes) };
  }
  if (res && typeof res === 'object' && (res.ok != null || res.status != null || res.error)) {
    return { bytes: Buffer.alloc(0), json: res, mediaType: 'application/json' };
  }
  return { bytes: Buffer.alloc(0), json: null };
}

/**
 * @param {object} handle session handle from DesktopProvider.create
 * @param {object} req
 * @param {'GET'|'POST'} req.method
 * @param {string} req.path  e.g. '/click'
 * @param {object} [req.body]
 * @param {AbortSignal} [req.signal]
 * @param {function} [req.fetchImpl]
 * @returns {Promise<{ status: number, json: object|null, bytes: Buffer, mediaType: string }>}
 */
async function callDcp(handle, req = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.path || '/').startsWith('/') ? String(req.path) : `/${req.path}`;
  const signal = req.signal;
  if (signal && signal.aborted) {
    const err = new Error('operation_aborted');
    err.name = 'AbortError';
    err.code = 'ABORTED';
    throw err;
  }

  if (handle && typeof handle.callDcp === 'function') {
    const raw = await handle.callDcp(method, path, req.body || {}, { signal });
    const packed = await readBody(raw);
    const status = Number(raw && raw.status) || (raw && raw.error ? 400 : 200);
    return {
      status,
      json: packed.json,
      bytes: packed.bytes,
      mediaType: packed.mediaType || sniffMediaType(packed.bytes),
    };
  }

  const base = dcpBase(handle);
  if (!base) {
    throw new DesktopProviderError('DCP no disponible en esta sesión.', {
      code: 'dcp_unavailable',
      status: 503,
    });
  }

  const fetchFn = req.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new DesktopProviderError('fetch no disponible para hablar con DCP.', {
      code: 'dcp_fetch_missing',
      status: 503,
    });
  }

  const url = path === '/file' && method === 'GET' && req.body && req.body.path
    ? `${base}/file?path=${encodeURIComponent(req.body.path)}`
    : `${base}${path}`;

  const ac = new AbortController();
  const timer = setTimeout(() => {
    try { ac.abort(); } catch (_) { /* ignore */ }
  }, Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : DEFAULT_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const onAbort = () => {
    try { ac.abort(); } catch (_) { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetchFn(url, {
      method,
      headers: req.body && method !== 'GET' ? { 'content-type': 'application/json' } : undefined,
      body: req.body && method !== 'GET' ? JSON.stringify(req.body) : undefined,
      signal: ac.signal,
    });
    const packed = await readBody(res);
    return {
      status: Number(res && res.status) || 200,
      json: packed.json,
      bytes: packed.bytes,
      mediaType: packed.mediaType || sniffMediaType(packed.bytes),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  callDcp,
  dcpBase,
  sniffMediaType,
};
