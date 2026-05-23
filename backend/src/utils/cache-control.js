'use strict';

/**
 * cache-control — RFC 7234 Cache-Control parser + builder. Closes the
 * HTTP cache trio (#87 ETag + #88 Accept negotiator + #89 Range): a
 * caller can now build a fully-correct cacheable response with one
 * import per concern.
 *
 * Parser tolerates whitespace, lowercases directive names, accepts
 * boolean directives ('no-store') and value directives ('max-age=60'
 * → number; 'private="X-Custom"' → string with quotes stripped).
 *
 * Builder emits directives in stable order: boolean directives first
 * (sorted), then value directives (sorted) — so two equivalent
 * requests produce identical headers (good for cache-key dedup and
 * audit-log diffs).
 *
 * Public API:
 *   parseCacheControl(header)         → { [name]: true | number | string }
 *   buildCacheControl(directives)     → header string
 *   freshness(parsed, ageSec)         → { fresh, reason }
 */

const NUMBER_DIRECTIVES = new Set([
  'max-age', 's-maxage', 'min-fresh', 'max-stale', 'stale-while-revalidate',
  'stale-if-error',
]);

function unquote(s) {
  if (typeof s !== 'string') return s;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

function parseCacheControl(header) {
  if (typeof header !== 'string' || !header.trim()) return {};
  const out = {};
  for (const raw of header.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      out[part.toLowerCase()] = true;
      continue;
    }
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = unquote(part.slice(eq + 1).trim());
    if (NUMBER_DIRECTIVES.has(name)) {
      const n = Number(value);
      out[name] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function buildCacheControl(directives) {
  if (!directives || typeof directives !== 'object') return '';
  const booleanParts = [];
  const valueParts = [];
  for (const [k, v] of Object.entries(directives)) {
    if (v === false || v == null) continue;
    const name = String(k).toLowerCase();
    if (v === true) booleanParts.push(name);
    else if (typeof v === 'number') valueParts.push(`${name}=${Math.max(0, Math.floor(v))}`);
    else if (typeof v === 'string') {
      const needsQuote = /[\s,;]/.test(v);
      valueParts.push(`${name}=${needsQuote ? `"${v}"` : v}`);
    }
  }
  booleanParts.sort();
  valueParts.sort();
  return [...booleanParts, ...valueParts].join(', ');
}

function freshness(parsed, ageSec) {
  if (!parsed || typeof parsed !== 'object') return { fresh: false, reason: 'no_directives' };
  if (parsed['no-store']) return { fresh: false, reason: 'no_store' };
  if (parsed['no-cache']) return { fresh: false, reason: 'no_cache_revalidate' };
  const max = Number.isFinite(parsed['s-maxage']) ? parsed['s-maxage']
    : Number.isFinite(parsed['max-age']) ? parsed['max-age'] : null;
  if (max == null) return { fresh: false, reason: 'no_max_age' };
  return { fresh: ageSec < max, reason: ageSec < max ? 'fresh' : 'expired', maxAge: max };
}

module.exports = {
  parseCacheControl,
  buildCacheControl,
  freshness,
  NUMBER_DIRECTIVES,
};
