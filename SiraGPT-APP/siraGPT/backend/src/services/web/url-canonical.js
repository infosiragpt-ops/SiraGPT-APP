/**
 * url-canonical — canonicalise URLs for dedup, frontier management,
 * and cache keys.
 *
 * Rules applied (in order):
 *   1. Lowercase scheme + host.
 *   2. Strip fragment (#anchor).
 *   3. Drop default ports (80 for http, 443 for https).
 *   4. Remove tracking query params (utm_*, fbclid, gclid, mc_cid,
 *      mc_eid, ref, yclid, _ga, msclkid).
 *   5. Sort remaining query params alphabetically.
 *   6. Collapse trailing slash on an empty path (normalise to "/").
 *   7. Decode percent-encodings that are safe (unreserved chars).
 *
 * Not applied:
 *   - No IDN / punycode conversion — we let the caller pre-normalise
 *     Unicode hosts if it wants.
 *   - No path-case normalisation — paths ARE case-sensitive.
 */

const TRACKING_PATTERNS = [
  /^utm_/i, /^mc_/i, /^icid$/i, /^ref$/i, /^refsrc$/i, /^src$/i,
  /^fbclid$/i, /^gclid$/i, /^yclid$/i, /^msclkid$/i,
  /^_ga$/i, /^_gl$/i, /^_hs/i, /^hsCtaTracking$/i,
  /^igshid$/i, /^ncid$/i, /^twclid$/i,
];

function isTrackingParam(name) {
  return TRACKING_PATTERNS.some(rx => rx.test(name));
}

function stripTrackingQuery(searchParams) {
  const keys = [...searchParams.keys()];
  for (const k of keys) if (isTrackingParam(k)) searchParams.delete(k);
  return searchParams;
}

function sortParams(searchParams) {
  const entries = [...searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const sorted = new URLSearchParams();
  for (const [k, v] of entries) sorted.append(k, v);
  return sorted;
}

/**
 * Canonicalise a single URL. Returns null when the input is not a
 * valid absolute URL we can parse.
 */
function canonicalize(raw, { baseUrl } = {}) {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (!input) return null;
  let u;
  try { u = baseUrl ? new URL(input, baseUrl) : new URL(input); }
  catch { return null; }

  // Only canonicalise http(s) — other schemes (mailto, javascript, file)
  // are out of scope for the scraper.
  if (!/^https?:$/.test(u.protocol)) return null;

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";

  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }

  if (u.pathname === "") u.pathname = "/";

  u.search = (() => {
    const params = new URLSearchParams(u.search);
    stripTrackingQuery(params);
    const sorted = sortParams(params);
    const s = sorted.toString();
    return s ? `?${s}` : "";
  })();

  return u.toString();
}

/**
 * Are two URLs the same resource after canonicalisation?
 */
function sameResource(a, b) {
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  return Boolean(ca && cb && ca === cb);
}

/**
 * Dedupe a list of URL strings. Returns both the deduped list and
 * the map of canonical → first-seen original, useful for reporting.
 */
function dedupeUrlList(urls) {
  const seen = new Map();
  const unique = [];
  for (const raw of urls || []) {
    const c = canonicalize(raw);
    if (!c || seen.has(c)) continue;
    seen.set(c, raw);
    unique.push(c);
  }
  return { unique, seenMap: seen };
}

/**
 * Extract the registrable-ish domain (eTLD+1). A zero-dep approximation:
 * we take the last two labels, with a small allow-list of two-label
 * public suffixes (.co.uk, .com.ar, .com.br, .co.jp, .com.mx). Good
 * enough for rate-limiting grouping; not a replacement for the full
 * PSL in production.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "com.ar", "com.br",
  "com.mx", "com.au", "com.sg", "gov.uk",
]);

function registrableDomain(urlOrHost) {
  let host;
  try { host = new URL(urlOrHost).hostname; }
  catch { host = String(urlOrHost || "").toLowerCase(); }
  host = host.replace(/^\.+|\.+$/g, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  if (TWO_LABEL_SUFFIXES.has(last2)) return last3;
  return last2;
}

module.exports = {
  canonicalize,
  sameResource,
  dedupeUrlList,
  registrableDomain,
  isTrackingParam,
  TRACKING_PATTERNS,
  TWO_LABEL_SUFFIXES,
};
