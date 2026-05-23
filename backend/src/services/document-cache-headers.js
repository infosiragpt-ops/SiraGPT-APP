'use strict';

/**
 * document-cache-headers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects HTTP cache-control headers and their directives. Useful for spotting
 * "is this cached?" / "what's the max-age?" / "any stale-while-revalidate?".
 *
 * Targets:
 *   - Cache-Control: max-age=N, s-maxage, no-cache, no-store, public, private,
 *                    immutable, stale-while-revalidate, stale-if-error,
 *                    must-revalidate, proxy-revalidate, no-transform
 *   - ETag: "<value>" (weak/strong)
 *   - Last-Modified: <date>
 *   - Expires: <date>
 *   - Pragma: no-cache (legacy)
 *   - Vary: Accept, Authorization, …
 *   - Age: <seconds>
 *
 * Public API:
 *   extractCacheHeaders(text)            → { entries, totals, total }
 *   buildCacheHeadersForFiles(files)     → { perFile, aggregate, totals }
 *   renderCacheHeadersBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const CACHE_CONTROL_RE = /\bCache-Control\s*:\s*([^\n\r]{1,250})/gi;
const ETAG_RE = /\bETag\s*:\s*(W\/)?"([^"\n]{1,80})"/gi;
const LAST_MOD_RE = /\bLast-Modified\s*:\s*([A-Z][a-z]{2,8},\s*[^\n\r]{8,60})/g;
const EXPIRES_RE = /\bExpires\s*:\s*([A-Z][a-z]{2,8},\s*[^\n\r]{8,60})/g;
const PRAGMA_RE = /\bPragma\s*:\s*(no-cache|public)/gi;
const VARY_RE = /\bVary\s*:\s*([A-Za-z][A-Za-z0-9,\-\s]{2,160})/gi;
const AGE_RE = /\bAge\s*:\s*(\d{1,8})/gi;

const KNOWN_DIRECTIVES = new Set([
  'no-cache', 'no-store', 'public', 'private', 'immutable',
  'must-revalidate', 'proxy-revalidate', 'no-transform', 'only-if-cached',
]);

function parseCacheControl(value) {
  const out = { directives: [], maxAge: null, sMaxAge: null, staleWhileRevalidate: null, staleIfError: null };
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      const dir = part.toLowerCase();
      if (KNOWN_DIRECTIVES.has(dir)) out.directives.push(dir);
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (key === 'max-age') out.maxAge = parseInt(v, 10);
    else if (key === 's-maxage') out.sMaxAge = parseInt(v, 10);
    else if (key === 'stale-while-revalidate') out.staleWhileRevalidate = parseInt(v, 10);
    else if (key === 'stale-if-error') out.staleIfError = parseInt(v, 10);
  }
  return out;
}

function extractCacheHeaders(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { cacheControl: 0, etag: 0, lastModified: 0, expires: 0, pragma: 0, vary: 0, age: 0 };

  // Cache-Control
  CACHE_CONTROL_RE.lastIndex = 0;
  let m;
  while ((m = CACHE_CONTROL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const parsed = parseCacheControl(m[1]);
    const key = `cc:${m[1].slice(0, 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ header: 'Cache-Control', value: m[1].slice(0, 120), parsed });
    totals.cacheControl += 1;
  }

  // ETag
  if (entries.length < MAX_PER_FILE) {
    ETAG_RE.lastIndex = 0;
    while ((m = ETAG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const weak = !!m[1];
      const val = m[2];
      const key = `etag:${val}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ header: 'ETag', value: `${weak ? 'W/' : ''}"${val.length > 40 ? val.slice(0, 40) + '…' : val}"`, weak });
      totals.etag += 1;
    }
  }

  // Last-Modified
  if (entries.length < MAX_PER_FILE) {
    LAST_MOD_RE.lastIndex = 0;
    while ((m = LAST_MOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `lm:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ header: 'Last-Modified', value: m[1].slice(0, 50) });
      totals.lastModified += 1;
    }
  }

  // Expires
  if (entries.length < MAX_PER_FILE) {
    EXPIRES_RE.lastIndex = 0;
    while ((m = EXPIRES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `exp:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ header: 'Expires', value: m[1].slice(0, 50) });
      totals.expires += 1;
    }
  }

  // Pragma
  if (entries.length < MAX_PER_FILE) {
    PRAGMA_RE.lastIndex = 0;
    while ((m = PRAGMA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `pragma:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ header: 'Pragma', value: m[1] });
      totals.pragma += 1;
    }
  }

  // Vary
  if (entries.length < MAX_PER_FILE) {
    VARY_RE.lastIndex = 0;
    while ((m = VARY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const v = m[1].trim();
      const key = `vary:${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ header: 'Vary', value: v.slice(0, 120) });
      totals.vary += 1;
    }
  }

  // Age
  if (entries.length < MAX_PER_FILE) {
    AGE_RE.lastIndex = 0;
    while ((m = AGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `age:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ header: 'Age', value: m[1] });
      totals.age += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCacheHeadersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { cacheControl: 0, etag: 0, lastModified: 0, expires: 0, pragma: 0, vary: 0, age: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCacheHeaders(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.header}:${e.value}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      const bucket = e.header === 'Cache-Control' ? 'cacheControl' :
                     e.header === 'ETag' ? 'etag' :
                     e.header === 'Last-Modified' ? 'lastModified' :
                     e.header === 'Expires' ? 'expires' :
                     e.header === 'Pragma' ? 'pragma' :
                     e.header === 'Vary' ? 'vary' :
                     e.header === 'Age' ? 'age' : null;
      if (bucket && totals[bucket] != null) totals[bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCacheHeadersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## HTTP CACHE HEADERS'];
  const t = report.totals || {};
  const parts = [];
  if (t.cacheControl) parts.push(`Cache-Control: ${t.cacheControl}`);
  if (t.etag) parts.push(`ETag: ${t.etag}`);
  if (t.lastModified) parts.push(`Last-Modified: ${t.lastModified}`);
  if (t.expires) parts.push(`Expires: ${t.expires}`);
  if (t.pragma) parts.push(`Pragma: ${t.pragma}`);
  if (t.vary) parts.push(`Vary: ${t.vary}`);
  if (t.age) parts.push(`Age: ${t.age}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.header}: \`${e.value}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCacheHeaders,
  buildCacheHeadersForFiles,
  renderCacheHeadersBlock,
  _internal: { parseCacheControl },
};
