'use strict';

/**
 * link-preview route — fetches a remote page and extracts OpenGraph-style
 * metadata (title / favicon / image) for chat link cards.
 *
 *   GET /api/link-preview?url=<http(s) URL>
 *     200 → { url, title, faviconUrl, imageUrl, cached?: true }
 *     400 → { error: 'invalid_url' }      (missing / non-http(s) / oversized)
 *     403 → { error: 'blocked_host' }     (SSRF guard, hostname or DNS level)
 *     502 → { error: 'fetch_failed' }     (network / upstream / non-HTML)
 *     504 → { error: 'timeout' }          (5s abort budget exceeded)
 *
 * Safety:
 * - SSRF guard on the literal hostname (localhost, RFC1918, link-local,
 *   loopback, metadata ranges, .local/.internal, private IPv6).
 * - Best-effort anti-rebinding: DNS-resolves the hostname and re-checks every
 *   resolved address before fetching; the post-redirect final host is also
 *   re-validated.
 * - Body read capped at 256 KiB via a reader loop; only text/html parsed.
 *
 * Injectable for tests:
 *   module.exports.createRouter = (deps = { fetchImpl, lookupImpl, timeoutMs }) => router
 * Default export is a router wired to the real fetch + dns.lookup.
 */

const express = require('express');
const cheerio = require('cheerio');
const net = require('node:net');
const dnsPromises = require('node:dns').promises;

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 262_144; // 256 KiB
const MAX_URL_LENGTH = 2_048;
const TITLE_MAX_CHARS = 200;
const CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes
const CACHE_MAX_ENTRIES = 200;
const USER_AGENT = 'SiraGPT-LinkPreview/1.0 (+https://siragpt.com)';

// ---------------------------------------------------------------------------
// SSRF guard helpers
// ---------------------------------------------------------------------------

function stripBrackets(host) {
  const h = String(host || '');
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // "this" net, RFC1918, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  return false;
}

function isPrivateIPv6(ip) {
  const bare = String(ip).toLowerCase().split('%')[0]; // drop zone id
  if (bare === '::' || bare === '::1') return true; // unspecified + loopback
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(bare)) return true; // link-local fe80::/10
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** Block a literal IP (v4 or v6) that points at private / internal space. */
function isBlockedAddress(address) {
  const addr = stripBrackets(address);
  const version = net.isIP(addr);
  if (version === 4) return isPrivateIPv4(addr);
  if (version === 6) return isPrivateIPv6(addr);
  return false;
}

/** Block by hostname BEFORE any DNS resolution happens. */
function isBlockedHost(hostname) {
  if (!hostname) return true;
  const host = stripBrackets(String(hostname).toLowerCase().replace(/\.$/, ''));
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'local' || host.endsWith('.local')) return true;
  if (host === 'internal' || host.endsWith('.internal')) return true;
  return isBlockedAddress(host);
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

function resolveAbsolute(raw, base) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return new URL(raw.trim(), base).toString();
  } catch {
    return null;
  }
}

/** Extract { title, imageUrl, faviconUrl } from an HTML document. */
function parseHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const meta = (name) => {
    const content = $(`meta[property="${name}"]`).attr('content')
      || $(`meta[name="${name}"]`).attr('content');
    const trimmed = typeof content === 'string' ? content.trim() : '';
    return trimmed || null;
  };

  let title = meta('og:title')
    || meta('twitter:title')
    || ($('title').first().text() || '').trim()
    || null;
  if (title) title = title.slice(0, TITLE_MAX_CHARS);

  const imageUrl = resolveAbsolute(meta('og:image') || meta('twitter:image'), finalUrl);

  let faviconUrl = resolveAbsolute($('link[rel~="icon"]').first().attr('href'), finalUrl);
  if (!faviconUrl) faviconUrl = resolveAbsolute('/favicon.ico', finalUrl);

  return { title, imageUrl, faviconUrl };
}

// ---------------------------------------------------------------------------
// Capped body reader
// ---------------------------------------------------------------------------

async function readBodyCapped(response, capBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // Mock / exotic responses without a stream: fall back to text().
    const text = typeof response.text === 'function' ? await response.text() : '';
    return Buffer.from(String(text), 'utf8').subarray(0, capBytes).toString('utf8');
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < capBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    // Always cancel the reader. An exception inside the loop (read() rejecting,
    // Buffer.from throwing) used to skip the cancel and leak the open stream.
    try { await reader.cancel(); } catch { /* best effort */ }
  }
  return Buffer.concat(chunks).subarray(0, capBytes).toString('utf8');
}

// ---------------------------------------------------------------------------
// TTL cache (Map preserves insertion order → first key is the oldest)
// ---------------------------------------------------------------------------

function cacheGet(cache, key, now = Date.now()) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function cacheSet(cache, key, payload, now = Date.now()) {
  if (cache.has(key)) cache.delete(key); // refresh insertion order
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { storedAt: now, payload });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

function isAbortError(err, controller) {
  return Boolean(
    (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    || (controller && controller.signal.aborted),
  );
}

function createRouter(deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
  const lookupImpl = deps.lookupImpl
    || ((hostname, opts) => dnsPromises.lookup(hostname, opts));
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : FETCH_TIMEOUT_MS;

  const cache = new Map();
  const router = express.Router();

  router.get('/', async (req, res) => {
    const raw = typeof req.query.url === 'string' ? req.query.url : '';
    if (!raw || raw.length > MAX_URL_LENGTH) {
      return res.status(400).json({ error: 'invalid_url' });
    }
    let target;
    try {
      target = new URL(raw);
    } catch {
      return res.status(400).json({ error: 'invalid_url' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return res.status(400).json({ error: 'invalid_url' });
    }

    const cacheKey = target.toString();
    const hit = cacheGet(cache, cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    // --- SSRF guard: literal hostname first --------------------------------
    if (isBlockedHost(target.hostname)) {
      return res.status(403).json({ error: 'blocked_host' });
    }

    // --- SSRF guard: DNS resolution re-check (anti-rebinding, best effort) --
    if (net.isIP(stripBrackets(target.hostname)) === 0) {
      let records;
      try {
        records = await lookupImpl(target.hostname, { all: true });
      } catch {
        return res.status(502).json({ error: 'fetch_failed', reason: 'dns' });
      }
      const list = Array.isArray(records) ? records : [records];
      if (list.length === 0) {
        return res.status(502).json({ error: 'fetch_failed', reason: 'dns' });
      }
      for (const record of list) {
        if (!record || !record.address || isBlockedAddress(String(record.address))) {
          return res.status(403).json({ error: 'blocked_host' });
        }
      }
    }

    // --- Fetch with abort budget -------------------------------------------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(target.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (isAbortError(err, controller)) {
        return res.status(504).json({ error: 'timeout' });
      }
      return res.status(502).json({ error: 'fetch_failed' });
    }

    try {
      const finalUrl = (typeof response.url === 'string' && response.url)
        ? response.url
        : target.toString();

      // Redirects may have landed somewhere private — re-validate.
      let finalHostBlocked = true;
      try {
        finalHostBlocked = isBlockedHost(new URL(finalUrl).hostname);
      } catch {
        finalHostBlocked = true;
      }
      if (finalHostBlocked) {
        return res.status(403).json({ error: 'blocked_host' });
      }

      if (!response.ok) {
        return res.status(502).json({ error: 'fetch_failed', reason: 'upstream_status' });
      }

      const contentType = String(
        (response.headers && typeof response.headers.get === 'function'
          && response.headers.get('content-type')) || '',
      ).toLowerCase();
      if (!contentType.includes('text/html')) {
        return res.status(502).json({ error: 'fetch_failed', reason: 'not_html' });
      }

      let html;
      try {
        html = await readBodyCapped(response, MAX_BODY_BYTES);
      } catch (err) {
        if (isAbortError(err, controller)) {
          return res.status(504).json({ error: 'timeout' });
        }
        return res.status(502).json({ error: 'fetch_failed' });
      }

      const { title, imageUrl, faviconUrl } = parseHtml(html, finalUrl);
      const payload = { url: target.toString(), title, faviconUrl, imageUrl };
      cacheSet(cache, cacheKey, payload);
      return res.json(payload);
    } finally {
      clearTimeout(timer);
    }
  });

  // Exposed so tests can inspect / clear cache state.
  router._cache = cache;
  return router;
}

const router = createRouter();

module.exports = router;
module.exports.createRouter = createRouter;
module.exports._internals = {
  parseHtml,
  isBlockedHost,
  isBlockedAddress,
  readBodyCapped,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  MAX_BODY_BYTES,
};
