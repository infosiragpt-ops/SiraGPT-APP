'use strict';

/**
 * pagination-cursor — opaque, signed, URL-safe pagination cursor.
 * Composes canonical-json (#50, deterministic serialization),
 * base64url (#72, URL-safe transport), and HMAC-SHA256 (#48, anti-
 * tamper). Clients can't invent cursors and the server detects
 * tampering as `signature_mismatch`.
 *
 * Use case: cursor-based list endpoints. The server emits
 * { cursor: "v1.…" } and the client passes it back unchanged on the
 * next page. The cursor encodes whatever the server needs to resume
 * (lastId, lastSortKey, sortDir, filterHash, etc.).
 *
 * Public API:
 *   const cur = createCursorCodec({ secret, version = 'v1' })
 *   cur.encode(payload)           → string (e.g. "v1.<sigB64u>.<dataB64u>")
 *   cur.decode(token)             → { ok, payload } | { ok:false, reason }
 *   cur.isValid(token)            → boolean (decode().ok)
 *
 * Forward-compatible: callers can bump `version` and accept old
 * versions via { acceptVersions: ['v1', 'v0'] } so a deploy can roll
 * forward without invalidating outstanding cursors.
 */

const { canonicalize } = require('./canonical-json');
const b64u = require('./base64url');
const { hmacHex, safeEqualHex } = require('../services/auth/hmac-webhook');

function createCursorCodec(opts = {}) {
  if (typeof opts.secret !== 'string' || !opts.secret) {
    throw new TypeError('pagination-cursor: secret required');
  }
  const secret = opts.secret;
  const version = typeof opts.version === 'string' && opts.version ? opts.version : 'v1';
  const accept = Array.isArray(opts.acceptVersions) && opts.acceptVersions.length
    ? new Set([version, ...opts.acceptVersions])
    : new Set([version]);

  function encode(payload) {
    const json = canonicalize(payload);
    const data = b64u.encode(json);
    const sig = b64u.encode(Buffer.from(hmacHex(secret, `${version}.${data}`), 'hex'));
    return `${version}.${sig}.${data}`;
  }

  function decode(token) {
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [v, sigB64u, data] = parts;
    if (!accept.has(v)) return { ok: false, reason: 'unknown_version', version: v };
    let sigHex;
    try { sigHex = b64u.decode(sigB64u).toString('hex'); }
    catch { return { ok: false, reason: 'malformed' }; }
    const expected = hmacHex(secret, `${v}.${data}`);
    if (!safeEqualHex(sigHex, expected)) return { ok: false, reason: 'signature_mismatch' };
    let payload;
    try { payload = JSON.parse(b64u.decode(data, { encoding: 'utf8' })); }
    catch { return { ok: false, reason: 'malformed' }; }
    return { ok: true, payload, version: v };
  }

  function isValid(token) { return decode(token).ok; }

  return { encode, decode, isValid };
}

module.exports = {
  createCursorCodec,
};
