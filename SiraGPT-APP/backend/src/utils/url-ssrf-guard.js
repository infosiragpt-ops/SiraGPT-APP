'use strict';

/**
 * url-ssrf-guard — reusable SSRF guard for *outbound* URLs that the
 * server itself fetches or redirects to (Stripe invoice PDFs, image
 * URLs, etc.).
 *
 * It is a thin, dependency-light wrapper around the canonical SSRF
 * primitives in `services/connectors/web-fetch.js` so there is a single
 * source of truth for the private/reserved IP ranges and the DNS
 * anti-rebinding check. The wrapper adds:
 *
 *   - https-by-default scheme enforcement (opt into http with allowHttp),
 *   - rejection of embedded credentials and localhost/.internal/.local,
 *   - private / loopback / link-local / cloud-metadata IP-literal blocking,
 *   - an optional exact-suffix host allowlist (e.g. ['stripe.com']),
 *   - an async variant that resolves DNS and re-checks the addresses so a
 *     public A record pointing at 169.254.169.254 cannot be followed.
 *
 * Throws {@link SsrfBlockedError} (carrying `.code` + `.statusCode`) on
 * rejection; the sync `isSafeOutboundUrl` returns a boolean instead.
 */

const net = require('node:net');
const {
  isPrivateOrReservedAddress,
  resolveAndAssertSafe,
} = require('../services/connectors/web-fetch');

class SsrfBlockedError extends Error {
  constructor(message, code = 'ssrf_blocked', statusCode = 400) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data', // EC2 IMDS alias
  'metadata.azure.com',
]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local'];

function hostMatchesAllowlist(host, allowlist) {
  const target = String(host || '').toLowerCase();
  if (!target) return false;
  return allowlist.some((entry) => {
    const e = String(entry || '').toLowerCase();
    return e && (target === e || target.endsWith(`.${e}`));
  });
}

/**
 * parseSafeOutboundUrl — synchronous literal + IP-range validation.
 * Returns the parsed URL or throws SsrfBlockedError. Does NOT touch DNS.
 *
 * @param {string} rawUrl
 * @param {{ allowHosts?: string[]|null, allowHttp?: boolean }} [opts]
 */
function parseSafeOutboundUrl(rawUrl, opts = {}) {
  const { allowHosts = null, allowHttp = false } = opts;
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (_err) {
    throw new SsrfBlockedError('url is not a parseable absolute URL', 'invalid_url', 400);
  }
  const allowedSchemes = allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new SsrfBlockedError(`scheme "${parsed.protocol}" is not allowed`, 'bad_scheme', 400);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError('URLs with embedded credentials are not allowed', 'credentials_rejected', 400);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new SsrfBlockedError('url has no host component', 'no_host', 400);
  }
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SsrfBlockedError(`host "${host}" is not reachable`, 'blocked_host', 400);
  }
  if (net.isIP(host) && isPrivateOrReservedAddress(host)) {
    throw new SsrfBlockedError('private / reserved IP addresses are not allowed', 'blocked_ip', 400);
  }
  if (Array.isArray(allowHosts) && allowHosts.length > 0 && !hostMatchesAllowlist(host, allowHosts)) {
    throw new SsrfBlockedError(`host "${host}" is not in the allowlist`, 'host_not_allowlisted', 403);
  }
  return parsed;
}

/** Boolean convenience wrapper around {@link parseSafeOutboundUrl}. */
function isSafeOutboundUrl(rawUrl, opts = {}) {
  try {
    parseSafeOutboundUrl(rawUrl, opts);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * assertOutboundUrlSafe — full guard: sync checks + DNS anti-rebinding.
 * Resolves the hostname and rejects if any resolved address is
 * private/reserved (even when the literal host looked fine). For IP
 * literals the sync check already vetted the address, so DNS is skipped.
 *
 * @param {string} rawUrl
 * @param {{ allowHosts?: string[]|null, allowHttp?: boolean, lookup?: Function }} [opts]
 * @returns {Promise<URL>}
 */
async function assertOutboundUrlSafe(rawUrl, opts = {}) {
  const { allowHosts = null, allowHttp = false, lookup } = opts;
  const parsed = parseSafeOutboundUrl(rawUrl, { allowHosts, allowHttp });
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) {
    try {
      await resolveAndAssertSafe(host, lookup);
    } catch (err) {
      const status = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 400;
      throw new SsrfBlockedError(
        (err && err.message) || 'host resolved to a blocked address',
        'resolved_blocked',
        status,
      );
    }
  }
  return parsed;
}

module.exports = {
  SsrfBlockedError,
  parseSafeOutboundUrl,
  isSafeOutboundUrl,
  assertOutboundUrlSafe,
};
