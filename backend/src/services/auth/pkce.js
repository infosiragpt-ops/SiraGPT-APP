'use strict';

/**
 * pkce — RFC 7636 Proof Key for Code Exchange. Pairs with the
 * JWT-HS256 (#80), OAuth-style token flows, and the signed-URL
 * helper (#70): when a public OAuth client (mobile app, SPA) can't
 * keep a client_secret safe, PKCE binds the authorization-code
 * exchange to a one-time secret only the client knows.
 *
 * Public API:
 *   generateCodeVerifier({ length = 64 })       → string (43..128, URL-safe)
 *   challengeFor(verifier, method = 'S256')     → string (challenge)
 *   verifyChallenge(verifier, challenge, method = 'S256') → boolean
 *
 * Methods: 'S256' (default; SHA-256 + base64url) and 'plain' (echo).
 * RFC explicitly recommends S256 over plain.
 */

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const b64u = require('../../utils/base64url');

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function generateCodeVerifier({ length = 64 } = {}) {
  if (!Number.isInteger(length) || length < 43 || length > 128) {
    throw new RangeError('pkce: length must be in [43, 128]');
  }
  // base64url (no padding) yields 4/3 chars per byte. Generate enough
  // random bytes to cover the requested length, then slice.
  const bytes = randomBytes(Math.ceil(length * 3 / 4) + 4);
  return b64u.encode(bytes).slice(0, length);
}

function challengeFor(verifier, method = 'S256') {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) {
    throw new TypeError('pkce: verifier must be 43-128 URL-safe chars');
  }
  if (method === 'plain') return verifier;
  if (method === 'S256') {
    return b64u.encode(createHash('sha256').update(verifier, 'ascii').digest());
  }
  throw new TypeError(`pkce: unsupported method "${method}"`);
}

function verifyChallenge(verifier, challenge, method = 'S256') {
  if (typeof challenge !== 'string' || !challenge) return false;
  let expected;
  try { expected = challengeFor(verifier, method); }
  catch { return false; }
  if (expected.length !== challenge.length) return false;
  try { return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(challenge, 'utf8')); }
  catch { return false; }
}

module.exports = {
  generateCodeVerifier,
  challengeFor,
  verifyChallenge,
  VERIFIER_RE,
};
