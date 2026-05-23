'use strict';

/**
 * hsts — Strict-Transport-Security header builder + parser (RFC 6797).
 *
 * HSTS tells browsers "for the next N seconds, refuse to load this
 * origin over plain HTTP — upgrade or fail." Misconfigured values
 * are an outage with no rollback (the browser caches the directive
 * client-side), so this builder enforces the preload-list rules:
 *
 *   - max-age >= 31536000 (1 year) when preload is requested
 *   - includeSubDomains required for preload
 *
 * That mirrors hstspreload.org submission requirements; building
 * an invalid combination should fail early in code review, not at
 * registration time.
 *
 * Public API:
 *   build({ maxAge, includeSubDomains?, preload? })  → header value
 *   parse(header)                                     → directives
 *   isPreloadEligible(parsed)                         → boolean
 */

const SECONDS_IN_YEAR = 31536000;

function build(opts = {}) {
  const maxAge = Math.floor(Number(opts.maxAge));
  if (!(Number.isFinite(maxAge) && maxAge >= 0)) {
    throw new TypeError('hsts: maxAge must be a non-negative number of seconds');
  }
  const includeSubDomains = Boolean(opts.includeSubDomains);
  const preload = Boolean(opts.preload);

  if (preload) {
    if (maxAge < SECONDS_IN_YEAR) {
      throw new RangeError(
        `hsts: preload requires max-age >= ${SECONDS_IN_YEAR} (got ${maxAge})`
      );
    }
    if (!includeSubDomains) {
      throw new RangeError('hsts: preload requires includeSubDomains');
    }
  }

  let header = `max-age=${maxAge}`;
  if (includeSubDomains) header += '; includeSubDomains';
  if (preload) header += '; preload';
  return header;
}

function parse(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const out = {
    maxAge: null,
    includeSubDomains: false,
    preload: false,
  };
  for (const raw of header.split(';')) {
    const seg = raw.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    const key = (eq === -1 ? seg : seg.slice(0, eq)).trim().toLowerCase();
    const val = eq === -1 ? '' : seg.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) out.maxAge = Math.floor(n);
    } else if (key === 'includesubdomains') {
      out.includeSubDomains = true;
    } else if (key === 'preload') {
      out.preload = true;
    }
  }
  // RFC 6797 §6.1: the header MUST contain max-age. Without it, treat
  // the directive as invalid by returning null.
  if (out.maxAge === null) return null;
  return out;
}

function isPreloadEligible(parsed) {
  if (!parsed) return false;
  return (
    Number.isFinite(parsed.maxAge) &&
    parsed.maxAge >= SECONDS_IN_YEAR &&
    parsed.includeSubDomains === true &&
    parsed.preload === true
  );
}

module.exports = {
  build,
  parse,
  isPreloadEligible,
  SECONDS_IN_YEAR,
};
