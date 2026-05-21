'use strict';

/**
 * geo-lookup — resolves a raw IP address into a short human label
 * ("Madrid, ES") for the Appshots settings UI.
 *
 * Design:
 *   - Best-effort and silent: any failure (timeout, DNS, non-200, parse,
 *     private IP) returns null so the caller can fall back to the /24
 *     ipHint that's already stored. We never throw at the route layer.
 *   - Private / reserved / loopback ranges short-circuit to null before
 *     any network I/O so dev machines don't leak their LAN to a third
 *     party and don't burn the upstream rate limit.
 *   - Defaults to the keyless `ip-api.com` JSON endpoint, but is fully
 *     overridable via `GEOIP_LOOKUP_URL` (with `{ip}` placeholder) for
 *     self-hosted MaxMind / GeoIP2 setups. Tests can also point this at
 *     a stub server.
 *   - Hard 1500 ms timeout via AbortController — the /api/appshots/pair
 *     handler awaits this call inline, so a slow upstream must never
 *     stall the user-facing pairing flow for long.
 */

// Secure-by-default: ipwho.is exposes a keyless HTTPS endpoint whose
// JSON shape (`success`, `country`, `country_code`, `city`) is already
// understood by formatGeoHint. We deliberately avoid the popular
// `http://ip-api.com/...` endpoint because its free tier is HTTP-only,
// which would leak the user's public IP and the resolved city/country
// in clear over the wire. Operators who want a different provider
// (self-hosted MaxMind, paid ip-api key, etc.) can set GEOIP_LOOKUP_URL
// — but the request is rejected if that override isn't HTTPS (or a
// localhost stub), so we never silently downgrade transport.
const DEFAULT_LOOKUP_URL = 'https://ipwho.is/{ip}';
const DEFAULT_TIMEOUT_MS = 1500;

function isSecureLookupUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('https://')) return true;
  // Allow plain-HTTP only when it points at a loopback address — this is
  // what tests / self-hosted GeoIP sidecars typically use, and keeps the
  // PII inside the host.
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

function isPrivateOrReserved(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const cleaned = ip.replace(/^::ffff:/, '').split(',')[0].trim();
  if (!cleaned) return true;
  if (cleaned === '::1' || cleaned === '::' || cleaned.startsWith('fe80:')) return true;
  if (cleaned.startsWith('fc') || cleaned.startsWith('fd')) return true; // unique-local IPv6
  // Bare IPv4 checks
  const m = cleaned.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    // Unrecognised format — treat as non-resolvable to avoid leaking
    // arbitrary strings to the upstream service.
    return !cleaned.includes(':');
  }
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * resolveGeoHint(ip, { fetchImpl, timeoutMs, lookupUrl }) → "City, CC" | "CC" | null
 *
 * Returns a short, human-readable label or null. Never throws.
 */
async function resolveGeoHint(ip, opts = {}) {
  if (isPrivateOrReserved(ip)) return null;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const lookupUrl =
    opts.lookupUrl || process.env.GEOIP_LOOKUP_URL || DEFAULT_LOOKUP_URL;
  // Refuse to send the user's IP over an insecure channel. If an operator
  // configures GEOIP_LOOKUP_URL to a plain-HTTP non-loopback endpoint we
  // log once (caller's responsibility) and degrade silently — the UI
  // keeps falling back to ipHint.
  if (!isSecureLookupUrl(lookupUrl)) return null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const url = lookupUrl.includes('{ip}')
    ? lookupUrl.replace('{ip}', encodeURIComponent(ip))
    : `${lookupUrl.replace(/\/+$/, '')}/${encodeURIComponent(ip)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!resp || !resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return formatGeoHint(data);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * formatGeoHint — accepts a parsed JSON payload from the upstream and
 * collapses it to a short label. Handles the shape of ip-api.com as well
 * as common alternatives (`country_code`, `country_name`, etc.) so
 * swapping providers via GEOIP_LOOKUP_URL doesn't require a code change.
 */
function formatGeoHint(data) {
  if (!data || typeof data !== 'object') return null;
  // ip-api.com reports `status: 'success'|'fail'`; ipwho.is reports a
  // boolean `success`. Reject either shape's failure case so we don't
  // store an empty/error label.
  if (data.status && data.status !== 'success') return null;
  if (data.success === false) return null;

  const city = sanitisePart(data.city || data.cityName || data.city_name);
  const cc = sanitisePart(
    data.countryCode || data.country_code || data.countryISO || data.country_iso,
  );
  const countryName = sanitisePart(data.country || data.country_name);

  const right = cc || countryName;
  if (city && right) return `${city}, ${right}`;
  if (right) return right;
  if (city) return city;
  return null;
}

function sanitisePart(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control chars + cap to a sane width so a hostile upstream can't
  // bloat the row or smuggle weird whitespace into the UI.
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 64) : null;
}

module.exports = {
  resolveGeoHint,
  formatGeoHint,
  isPrivateOrReserved,
  isSecureLookupUrl,
};
