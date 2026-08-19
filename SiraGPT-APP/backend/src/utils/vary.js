'use strict';

/**
 * vary — HTTP Vary header parser, mutator, and cache-key derivator.
 *
 * Why this exists separately from cache-control: Vary is the
 * single most-misused HTTP cache primitive. A Cache-Control directive
 * tells *whether* to cache; Vary tells *what to key on*. If your
 * cache stores responses indexed only by URL but the response varied
 * on Accept-Encoding, you'll serve gzipped bytes to a curl client
 * that asked for identity. cacheKey() below produces a deterministic,
 * normalized key that incorporates only the request-header values
 * the response declared it varied on.
 *
 * Public API:
 *   parse(header)               — string[] of normalized field names
 *   append(header, fields)      — RFC-correct merge (no dupes, '*'
 *                                 swallows everything)
 *   isWildcard(header)          — true if the response is uncacheable-
 *                                 across-clients ("Vary: *")
 *   cacheKey(method, url, varyHeader, requestHeaders)
 *                               — stable string suitable as Map key
 */

function normalizeField(name) {
  return String(name).trim().toLowerCase();
}

function parse(header) {
  if (typeof header !== 'string' || header.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const part of header.split(',')) {
    const f = normalizeField(part);
    if (f === '') continue;
    if (f === '*') return ['*'];
    if (!seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out;
}

function append(header, fields) {
  const cur = parse(header);
  if (cur.length === 1 && cur[0] === '*') return '*';
  const newFields = Array.isArray(fields) ? fields : [fields];
  const seen = new Set(cur);
  for (const f of newFields) {
    const n = normalizeField(f);
    if (n === '') continue;
    if (n === '*') return '*';
    if (!seen.has(n)) { seen.add(n); cur.push(n); }
  }
  return cur.join(', ');
}

function isWildcard(header) {
  const fields = parse(header);
  return fields.length === 1 && fields[0] === '*';
}

function getReqHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  let v = headers[lower];
  if (v === undefined) {
    // Tolerate mixed-case keys (Express normalizes, but raw Node req.headers
    // sometimes don't if the caller passed something exotic).
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) { v = headers[k]; break; }
    }
  }
  if (Array.isArray(v)) return v.join(',');
  return v === undefined ? '' : String(v);
}

function normalizeHeaderValue(field, value) {
  if (!value) return '';
  // For Accept-* and Content-* style headers, ordering of equivalent
  // lists shouldn't change the cache key. Sort comma-separated lists
  // and lower-case media-type tokens for stability.
  if (/^(accept|accept-language|accept-encoding|accept-charset)$/.test(field)) {
    return value.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(',');
  }
  return value.trim();
}

function cacheKey(method, url, varyHeader, requestHeaders) {
  const m = String(method || 'GET').toUpperCase();
  const u = String(url || '');
  const fields = parse(varyHeader);
  if (fields.length === 1 && fields[0] === '*') {
    // RFC 9111: a Vary of "*" means "do not reuse cached response"
    // for any other request — i.e. the response is per-request.
    // Return a key that includes a sentinel so the caller can detect.
    return `${m} ${u}\x1evary:*\x1f` + Math.random().toString(36).slice(2);
  }
  // Build deterministic key segments.
  const segs = [`${m} ${u}`];
  for (const f of fields) {
    const v = normalizeHeaderValue(f, getReqHeader(requestHeaders, f));
    segs.push(`${f}=${v}`);
  }
  return segs.join('\x1f');
}

module.exports = {
  parse,
  append,
  isWildcard,
  cacheKey,
};
