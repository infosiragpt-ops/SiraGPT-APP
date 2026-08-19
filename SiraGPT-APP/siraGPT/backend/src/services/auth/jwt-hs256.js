'use strict';

/**
 * jwt-hs256 — minimal RFC 7519 JWT, HS256 only. Composes prior
 * primitives: base64url (#72), HMAC-SHA256 (#48), and the canonical-
 * json (#50) flavor of "deterministic encoding". No deps. Supports
 * exp, nbf, iat, iss, aud, sub, jti claims with leeway.
 *
 * We refuse the alg=none attack at the door (always re-derive the
 * alg from the verifier config, never trust the header).
 *
 * Public API:
 *   const j = createJwtSigner({ secret, issuer?, audience?, leewaySec? })
 *   j.sign(payload, { ttlSec?, audience?, subject?, jti? })  → token
 *   j.verify(token, { audience?, issuer?, now? })
 *     → { ok, payload, header } | { ok:false, reason }
 *
 * Reasons: 'malformed', 'bad_alg', 'signature_mismatch',
 * 'expired', 'not_before', 'wrong_issuer', 'wrong_audience'.
 */

const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const b64u = require('../../utils/base64url');

const ALG = 'HS256';
const HEADER = { alg: ALG, typ: 'JWT' };
const HEADER_B64 = b64u.encode(JSON.stringify(HEADER));

function hmacSig(secret, signingInput) {
  return b64u.encode(createHmac('sha256', secret).update(signingInput).digest());
}

function safeEqualB64u(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
  catch { return false; }
}

function createJwtSigner(opts = {}) {
  if (typeof opts.secret !== 'string' || !opts.secret) throw new TypeError('jwt: secret required');
  const secret = opts.secret;
  const issuer = typeof opts.issuer === 'string' ? opts.issuer : null;
  const audience = typeof opts.audience === 'string' ? opts.audience : null;
  const leewaySec = Number.isFinite(opts.leewaySec) && opts.leewaySec >= 0 ? Math.floor(opts.leewaySec) : 5;

  function sign(payload, { ttlSec = 3600, audience: audOverride, subject, jti } = {}) {
    if (payload == null || typeof payload !== 'object') throw new TypeError('jwt.sign: payload object required');
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iat: now,
      exp: now + Math.floor(ttlSec),
      ...(issuer ? { iss: issuer } : {}),
      ...(audOverride || audience ? { aud: audOverride || audience } : {}),
      ...(subject ? { sub: subject } : {}),
      ...(jti ? { jti } : {}),
      ...payload,
    };
    const payloadB64 = b64u.encode(JSON.stringify(claims));
    const signingInput = `${HEADER_B64}.${payloadB64}`;
    const sig = hmacSig(secret, signingInput);
    return `${signingInput}.${sig}`;
  }

  function verify(token, { audience: audExpect, issuer: issExpect, now } = {}) {
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [h, p, s] = parts;
    let header;
    try { header = JSON.parse(b64u.decode(h, { encoding: 'utf8' })); }
    catch { return { ok: false, reason: 'malformed' }; }
    if (header.alg !== ALG) return { ok: false, reason: 'bad_alg', alg: header.alg };
    const expected = hmacSig(secret, `${h}.${p}`);
    if (!safeEqualB64u(expected, s)) return { ok: false, reason: 'signature_mismatch' };
    let payload;
    try { payload = JSON.parse(b64u.decode(p, { encoding: 'utf8' })); }
    catch { return { ok: false, reason: 'malformed' }; }
    const t = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
    if (Number.isFinite(payload.exp) && t > payload.exp + leewaySec) return { ok: false, reason: 'expired' };
    if (Number.isFinite(payload.nbf) && t + leewaySec < payload.nbf) return { ok: false, reason: 'not_before' };
    const issWant = issExpect || issuer;
    if (issWant && payload.iss !== issWant) return { ok: false, reason: 'wrong_issuer' };
    const audWant = audExpect || audience;
    if (audWant && payload.aud !== audWant) return { ok: false, reason: 'wrong_audience' };
    return { ok: true, payload, header };
  }

  function newJti() {
    return randomBytes(12).toString('hex');
  }

  return { sign, verify, newJti };
}

module.exports = {
  createJwtSigner,
  ALG,
};
