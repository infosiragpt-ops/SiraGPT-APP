'use strict';

/**
 * Read-only URL fetch for SiraCode.
 *
 * Contract inspired by OpenCode webfetch (anomalyco/opencode, MIT):
 * https-only, markdown/text/html, size cap. Native rewrite — not a copy
 * of vendor/opencode/src/tool/webfetch.ts. Blocks private/loopback hosts.
 */

const { lookup } = require('node:dns/promises');
const net = require('node:net');

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 8_000;
const FORMATS = new Set(['markdown', 'text', 'html']);

let fetchImpl = globalThis.fetch.bind(globalThis);

function setWebFetchForTests(fn) {
  fetchImpl = fn || globalThis.fetch.bind(globalThis);
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function isPrivateIp(ip) {
  const ver = net.isIP(ip);
  if (!ver) return true;
  if (ver === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] === 255) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  const n = ip.toLowerCase();
  return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80')
    || n.startsWith('::ffff:127.') || n.startsWith('::ffff:10.') || n.startsWith('::ffff:192.168.');
}

function blockedHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
  if (net.isIP(host) && isPrivateIp(host)) return true;
  return false;
}

async function assertPublicUrl(raw, opts = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    const err = new Error('URL inválida');
    err.code = 'url_invalid';
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error('la URL no puede llevar credenciales');
    err.code = 'url_credentials';
    throw err;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') {
    const err = new Error('solo se permite https');
    err.code = 'url_scheme';
    throw err;
  }
  if (blockedHost(url.hostname)) {
    const err = new Error('host no permitido');
    err.code = 'url_blocked';
    throw err;
  }
  if (!opts.skipDns && !net.isIP(url.hostname)) {
    let records;
    try {
      records = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      const err = new Error('no se resolvió el host');
      err.code = 'url_dns';
      throw err;
    }
    if (!records.length || records.some((row) => isPrivateIp(row.address))) {
      const err = new Error('host no permitido');
      err.code = 'url_blocked';
      throw err;
    }
  }
  return url;
}

function toText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBody(body, format, contentType) {
  const raw = String(body || '');
  if (format === 'html') return raw;
  const looksHtml = /html/i.test(contentType || '') || /<html|<body|<p[\s>]/i.test(raw.slice(0, 2000));
  if (format === 'text' || format === 'markdown') return looksHtml ? toText(raw) : raw;
  return raw;
}

async function fetchUrl(url, format, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { Accept: 'text/html, text/plain, */*;q=0.8', 'User-Agent': 'SiraGPT-SiraCode/1' },
    });
    if (res.status >= 300 && res.status < 400) {
      const hops = Number(opts.hops) || 0;
      if (hops >= 3) {
        const err = new Error('demasiados redireccionamientos');
        err.code = 'url_redirects';
        throw err;
      }
      const loc = res.headers.get('location');
      const next = await assertPublicUrl(new URL(loc || '', url).href, opts);
      return fetchUrl(next, format, { ...opts, hops: hops + 1 });
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = 'http_error';
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const sliced = buf.subarray(0, MAX_BYTES).toString('utf8');
    const content = formatBody(sliced, format, res.headers.get('content-type') || '');
    return { ok: true, content, url: url.href, status: res.status, truncated: buf.length > MAX_BYTES };
  } finally {
    clearTimeout(timer);
  }
}

async function runWebFetch(args = {}, opts = {}) {
  const prev = fetchImpl;
  if (opts.fetch) fetchImpl = opts.fetch;
  const skipDns = Boolean(opts.fetch) || opts.skipDns === true;
  const format = FORMATS.has(String(args.format || '').trim()) ? String(args.format).trim() : 'markdown';
  let url;
  try {
    try {
      url = await assertPublicUrl(args.url || args.href, { skipDns });
    } catch (err) {
      return toolError(err.code || 'url_invalid', err.message);
    }
    return await fetchUrl(url, format, { skipDns });
  } catch (err) {
    if (err && err.name === 'AbortError') return toolError('timeout', 'la descarga excedió el tiempo');
    return toolError(err.code || 'fetch_failed', err.message || 'fetch failed');
  } finally {
    fetchImpl = prev;
  }
}

module.exports = {
  runWebFetch,
  assertPublicUrl,
  blockedHost,
  isPrivateIp,
  setWebFetchForTests,
  MAX_BYTES,
};
