'use strict';

/**
 * Read-only URL fetch for SiraCode.
 *
 * Contract inspired by OpenCode webfetch (anomalyco/opencode, MIT):
 * https-only, markdown/text/html, size cap. Native rewrite — not a copy
 * of vendor/opencode/src/tool/webfetch.ts. Uses the shared SSRF IP policy
 * and validates DNS in the HTTPS connection's lookup, without re-resolving.
 */

const { lookup } = require('node:dns/promises');
const net = require('node:net');
const https = require('node:https');
const { StringDecoder } = require('node:string_decoder');
const nodeFetch = require('node-fetch');
const { isPrivateOrReservedAddress } = require('../connectors/web-fetch');

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 8_000;
const FORMATS = new Set(['markdown', 'text', 'html']);
let testFetch;

function setWebFetchForTests(fn) {
  testFetch = fn || undefined;
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateIp(ip) {
  const host = normalizedHost(ip);
  return !net.isIP(host) || isPrivateOrReservedAddress(host);
}

function blockedHost(hostname) {
  const host = normalizedHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal') || ['metadata.goog', 'instance-data', 'metadata.azure.com'].includes(host)) return true;
  return Boolean(net.isIP(host) && isPrivateIp(host));
}

// Literal checks run before each request. DNS is checked by createSafeLookup
// inside the actual connection, so fetch cannot resolve a different address.
async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw failure('url_invalid', 'URL inválida');
  }
  if (url.username || url.password) throw failure('url_credentials', 'la URL no puede llevar credenciales');
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw failure('url_scheme', 'solo se permite https');
  if (blockedHost(url.hostname)) throw failure('url_blocked', 'host no permitido');
  return url;
}

function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('aborted', 'descarga interrumpida'));
    const settle = (fn, value) => {
      signal.removeEventListener('abort', abort);
      fn(value);
    };
    Promise.resolve(promise).then((value) => settle(resolve, value), (err) => settle(reject, err));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function createSafeLookup(resolveHost, signal) {
  return (hostname, options, callback) => {
    const all = options && options.all;
    const resolve = async () => {
      if (signal.aborted) throw failure('aborted', 'descarga interrumpida');
      if (blockedHost(hostname)) throw failure('url_blocked', 'host no permitido');
      let records;
      try {
        records = await waitFor(resolveHost(hostname, { all: true, verbatim: true }), signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw failure('url_dns', 'no se resolvió el host');
      }
      if (!Array.isArray(records) || !records.length) throw failure('url_dns', 'no se resolvió el host');
      if (records.some((row) => !row || isPrivateIp(row.address))) throw failure('url_blocked', 'host no permitido');
      const addresses = records.map((row) => ({ address: normalizedHost(row.address), family: net.isIP(normalizedHost(row.address)) }));
      if (signal.aborted) throw failure('aborted', 'descarga interrumpida');
      return addresses;
    };
    resolve().then((addresses) => {
      if (all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }, callback);
  };
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
  if (format === 'html') return body;
  const looksHtml = /html/i.test(contentType || '') || /<html|<body|<p[\s>]/i.test(body.slice(0, 2000));
  return looksHtml ? toText(body) : body;
}

function cancelBody(body) {
  if (!body) return;
  try {
    if (typeof body.destroy === 'function') body.destroy();
    else if (typeof body.cancel === 'function') Promise.resolve(body.cancel()).catch(() => {});
  } catch { /* Cleanup must not hide the download outcome. */ }
}

async function readBoundedBody(response, signal) {
  const body = response.body;
  if (!body) {
    if (response.status === 204 || response.headers.get('content-length') === '0') return { body: '', truncated: false };
    throw failure('fetch_failed', 'no se pudo leer la descarga de forma segura');
  }
  const reader = typeof body.getReader === 'function' ? body.getReader() : null;
  if (!reader && typeof body[Symbol.asyncIterator] !== 'function') {
    cancelBody(body);
    throw failure('fetch_failed', 'no se pudo leer la descarga de forma segura');
  }
  const iterator = reader ? null : body[Symbol.asyncIterator]();
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  let done = false;
  const cancel = () => {
    if (reader) {
      Promise.resolve(reader.cancel()).catch(() => {});
      return;
    }
    if (typeof body.destroy === 'function') body.destroy();
    if (typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {});
  };
  try {
    while (bytes < MAX_BYTES) {
      const chunk = await waitFor(reader ? reader.read() : iterator.next(), signal);
      if (chunk.done) {
        done = true;
        text += decoder.end();
        break;
      }
      const value = Buffer.isBuffer(chunk.value) ? chunk.value : typeof chunk.value === 'string' ? Buffer.from(chunk.value)
        : Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
      const retained = value.subarray(0, MAX_BYTES - bytes);
      text += decoder.write(retained);
      bytes += retained.byteLength;
    }
    // At the cap, stop immediately. Do not read another chunk just to prove EOF.
    // Dropping the decoder's partial trailing character avoids a replacement
    // character that could expand the bounded UTF-8 output.
    return { body: text, truncated: !done };
  } finally {
    cancel();
  }
}

async function fetchUrl(url, format, options) {
  let current = url;
  for (let hops = 0; ; hops += 1) {
    if (options.signal.aborted) throw failure('aborted', 'descarga interrumpida');
    const pendingResponse = Promise.resolve(options.fetch(current.href, {
      method: 'GET',
      redirect: 'manual',
      signal: options.signal,
      agent: options.agent,
      headers: { Accept: 'text/html, text/plain, */*;q=0.8', 'User-Agent': 'SiraGPT-SiraCode/1' },
    })).then((res) => {
      if (options.signal.aborted) cancelBody(res.body);
      return res;
    });
    const res = await waitFor(pendingResponse, options.signal);
    if (res.status >= 300 && res.status < 400) {
      cancelBody(res.body);
      if (hops >= 3) throw failure('url_redirects', 'demasiados redireccionamientos');
      const location = res.headers.get('location');
      if (!location) throw failure('url_redirects', 'el redireccionamiento no tiene destino');
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }
    if (!res.ok) {
      cancelBody(res.body);
      throw failure('http_error', `HTTP ${res.status}`);
    }
    const result = await readBoundedBody(res, options.signal);
    return {
      ok: true,
      content: formatBody(result.body, format, res.headers.get('content-type') || ''),
      url: current.href,
      status: res.status,
      truncated: result.truncated,
    };
  }
}

async function runWebFetch(args = {}, opts = {}) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TIMEOUT_MS);
  const cancel = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', cancel, { once: true });
  }
  const agent = new https.Agent({ keepAlive: false, lookup: createSafeLookup(opts.lookup || lookup, ac.signal) });
  const format = FORMATS.has(String(args.format || '').trim()) ? String(args.format).trim() : 'markdown';
  // Select the dependency once per request; concurrent test fetches cannot leak
  // across calls. node-fetch v2 and https.Agent are already repo dependencies.
  const fetch = opts.fetch || testFetch || nodeFetch;
  try {
    const url = await assertPublicUrl(args.url || args.href);
    return await fetchUrl(url, format, { fetch, signal: ac.signal, agent });
  } catch (err) {
    if (timedOut) return toolError('timeout', 'la descarga excedió el tiempo; reintenta');
    if (ac.signal.aborted) return toolError('E_CANCELLED', 'descarga cancelada');
    const messages = {
      url_invalid: 'URL inválida', url_credentials: 'la URL no puede llevar credenciales',
      url_scheme: 'solo se permite https', url_blocked: 'host no permitido',
      url_dns: 'no se resolvió el host', url_redirects: 'no se pudo seguir el redireccionamiento',
    };
    const code = err && err.code;
    if (messages[code]) return toolError(code, messages[code]);
    if (code === 'http_error') return toolError(code, err.message);
    return toolError('fetch_failed', 'no se pudo completar la descarga; reintenta');
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', cancel);
    agent.destroy();
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
