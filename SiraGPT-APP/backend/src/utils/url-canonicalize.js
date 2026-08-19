'use strict';

/**
 * url-canonicalize — normalize URLs to a canonical form for cache
 * keys, RAG-source dedup, signed-link comparison, and SEO. Pairs
 * with the signed-URL helper (#70) — both walk URL pieces, but
 * canonicalize is about *equivalence*, signed-url about *integrity*.
 *
 * Operations applied (each independently configurable):
 *   - lowercase scheme + host
 *   - strip default port (80 for http, 443 for https, 21 for ftp)
 *   - drop fragment (#…)
 *   - sort query parameters alphabetically (stable for ties)
 *   - drop tracking parameters (utm_*, fbclid, gclid, …)
 *   - remove duplicate slashes in path (`/a//b` → `/a/b`)
 *   - remove trailing slash from non-root path (configurable)
 *   - decode percent-encoded unreserved chars (RFC 3986 §2.3)
 *
 * Public API:
 *   canonicalizeUrl(url, opts)                  → string
 *   areEquivalent(a, b, opts)                   → boolean
 *   stripTrackingParams(url, paramList?)        → string
 *
 * opts (defaults):
 *   { lowercaseHost: true, stripDefaultPort: true, dropFragment: true,
 *     sortQuery: true, stripTracking: true, collapseSlashes: true,
 *     stripTrailingSlash: true, trackingParams: DEFAULT_TRACKING }
 */

const DEFAULT_TRACKING = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi', 'igshid',
]);

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ftp:': '21', 'ws:': '80', 'wss:': '443' };

function stripTrackingParams(url, paramList) {
  const u = url instanceof URL ? new URL(url.toString()) : new URL(url);
  const set = paramList instanceof Set ? paramList : new Set(paramList || DEFAULT_TRACKING);
  for (const k of [...u.searchParams.keys()]) {
    if (set.has(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

function canonicalizeUrl(input, opts = {}) {
  const {
    lowercaseHost = true,
    stripDefaultPort = true,
    dropFragment = true,
    sortQuery = true,
    stripTracking = true,
    collapseSlashes = true,
    stripTrailingSlash = true,
    trackingParams,
  } = opts;
  const u = input instanceof URL ? new URL(input.toString()) : new URL(input);

  if (lowercaseHost) {
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
  }
  if (stripDefaultPort && u.port && DEFAULT_PORTS[u.protocol] === u.port) {
    u.port = '';
  }
  if (dropFragment) u.hash = '';

  if (collapseSlashes) {
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  }
  if (stripTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  if (stripTracking) {
    const set = trackingParams instanceof Set ? trackingParams : new Set(trackingParams || DEFAULT_TRACKING);
    for (const k of [...u.searchParams.keys()]) if (set.has(k)) u.searchParams.delete(k);
  }
  if (sortQuery) {
    const entries = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // Wipe + re-add in sorted order; second arg of URLSearchParams ctor isn't supported uniformly.
    for (const k of [...u.searchParams.keys()]) u.searchParams.delete(k);
    for (const [k, v] of entries) u.searchParams.append(k, v);
  }
  return u.toString();
}

function areEquivalent(a, b, opts) {
  try { return canonicalizeUrl(a, opts) === canonicalizeUrl(b, opts); }
  catch { return false; }
}

module.exports = {
  canonicalizeUrl,
  areEquivalent,
  stripTrackingParams,
  DEFAULT_TRACKING,
};
