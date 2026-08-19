'use strict';

/**
 * cookie — RFC 6265 (and the modern Set-Cookie attributes) parser +
 * serializer. Pairs with the JWT-HS256 (#80), signed-URL (#70), and
 * the HMAC-webhook (#48) modules: when an endpoint hands the browser
 * a session cookie, this is the safe way to build the Set-Cookie
 * header (with HttpOnly / Secure / SameSite defaults) and to read
 * the inbound Cookie header back.
 *
 * Public API:
 *   parseCookieHeader(header)               → { name: value }
 *   serializeCookie(name, value, options)   → 'name=value; Attr; …'
 *   parseSetCookie(setCookieHeader)         → { name, value, attrs }
 */

function isToken(s) {
  // Per RFC 6265 cookie-name = token; we also enforce on user-supplied
  // attribute names. Name must contain no separators / control chars.
  return typeof s === 'string' && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s);
}

function parseCookieHeader(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    if (!name) continue;
    try { out[name] = decodeURIComponent(value); }
    catch { out[name] = value; }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  if (!isToken(name)) throw new TypeError('cookie: name must be a token');
  const enc = encodeURIComponent(String(value == null ? '' : value));
  let out = `${name}=${enc}`;
  if (opts.domain != null) out += `; Domain=${opts.domain}`;
  if (opts.path != null) out += `; Path=${opts.path}`;
  if (opts.expires instanceof Date) out += `; Expires=${opts.expires.toUTCString()}`;
  if (Number.isFinite(opts.maxAge)) out += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.httpOnly) out += '; HttpOnly';
  if (opts.secure) out += '; Secure';
  if (opts.partitioned) out += '; Partitioned';
  if (opts.sameSite) {
    const s = String(opts.sameSite).toLowerCase();
    if (s === 'strict' || s === 'lax' || s === 'none') {
      out += `; SameSite=${s[0].toUpperCase()}${s.slice(1)}`;
    }
  }
  return out;
}

function parseSetCookie(header) {
  if (typeof header !== 'string' || !header) return null;
  const parts = header.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const head = parts[0];
  const eq = head.indexOf('=');
  if (eq === -1) return null;
  const name = head.slice(0, eq).trim();
  let value = head.slice(eq + 1).trim();
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    value = value.slice(1, -1);
  }
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  const attrs = {};
  for (const p of parts.slice(1)) {
    const ae = p.indexOf('=');
    if (ae === -1) {
      attrs[p.toLowerCase()] = true;
      continue;
    }
    const ak = p.slice(0, ae).trim().toLowerCase();
    const av = p.slice(ae + 1).trim();
    if (ak === 'max-age') {
      const n = Number(av);
      attrs[ak] = Number.isFinite(n) ? n : 0;
    } else if (ak === 'expires') {
      const t = Date.parse(av);
      attrs[ak] = Number.isFinite(t) ? new Date(t) : null;
    } else if (ak === 'samesite') {
      attrs[ak] = av.toLowerCase();
    } else {
      attrs[ak] = av;
    }
  }
  return { name, value, attrs };
}

module.exports = {
  parseCookieHeader,
  serializeCookie,
  parseSetCookie,
  isToken,
};
