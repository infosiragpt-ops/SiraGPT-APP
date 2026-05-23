'use strict';

/**
 * http-authorization — RFC 7617 (Basic) + RFC 6750 (Bearer) parser
 * + builders. Pairs with the JWT-HS256 (#80), HMAC webhook (#48),
 * and PKCE (#97) modules: when an endpoint receives the
 * Authorization header, this is the first thing it touches.
 *
 * Public API:
 *   parseAuthorization(header)
 *     → { scheme: 'Basic', user, password } | null
 *     → { scheme: 'Bearer', token } | null
 *     → { scheme: <other>, params } | null  (raw param parse)
 *
 *   buildBasic(user, password)         → 'Basic <b64>'
 *   buildBearer(token)                 → 'Bearer <token>'
 */

function parseAuthorization(header) {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const space = trimmed.indexOf(' ');
  if (space === -1) return null;
  const scheme = trimmed.slice(0, space);
  const credentials = trimmed.slice(space + 1).trim();
  if (!scheme || !credentials) return null;

  const lower = scheme.toLowerCase();
  if (lower === 'basic') {
    let decoded;
    try { decoded = Buffer.from(credentials, 'base64').toString('utf8'); }
    catch { return null; }
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return {
      scheme: 'Basic',
      user: decoded.slice(0, colon),
      password: decoded.slice(colon + 1),
    };
  }
  if (lower === 'bearer') {
    return { scheme: 'Bearer', token: credentials };
  }
  // Generic: parse as comma-separated key=value pairs (Digest-style).
  const params = {};
  for (const part of credentials.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    let v = part.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    params[k] = v;
  }
  return { scheme, params };
}

function buildBasic(user, password) {
  if (typeof user !== 'string' || typeof password !== 'string') {
    throw new TypeError('buildBasic: user + password strings required');
  }
  if (user.includes(':')) throw new TypeError('buildBasic: user cannot contain ":"');
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

function buildBearer(token) {
  if (typeof token !== 'string' || !token) throw new TypeError('buildBearer: token required');
  if (/[\r\n]/.test(token)) throw new TypeError('buildBearer: token cannot contain newlines');
  return `Bearer ${token}`;
}

module.exports = {
  parseAuthorization,
  buildBasic,
  buildBearer,
};
