'use strict';

const crypto = require('node:crypto');
const { isProductionLike } = require('../utils/environment');

const SAML_PREAUTH_COOKIE_NAME = 'sira_saml_preauth';
const SAML_PREAUTH_NONCE_BYTES = 32;
const SAML_PREAUTH_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

function normalizeOrgSlug(orgSlug) {
  const normalized = String(orgSlug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(normalized)) {
    throw new TypeError('invalid SAML organization slug');
  }
  return normalized;
}

function normalizePreAuthNonce(value) {
  const nonce = String(value || '').trim();
  return SAML_PREAUTH_NONCE_RE.test(nonce) ? nonce : null;
}

function createSamlPreAuthNonce(randomBytes = crypto.randomBytes) {
  const bytes = Buffer.from(randomBytes(SAML_PREAUTH_NONCE_BYTES));
  if (bytes.length < SAML_PREAUTH_NONCE_BYTES) {
    throw new Error('SAML_PREAUTH_NONCE_GENERATION_FAILED');
  }
  return bytes.subarray(0, SAML_PREAUTH_NONCE_BYTES).toString('base64url');
}

function hashSamlPreAuthNonce(value) {
  const nonce = normalizePreAuthNonce(value);
  if (!nonce) throw new Error('SAML_PREAUTH_NONCE_INVALID');
  return crypto.createHash('sha256').update(nonce, 'utf8').digest('base64url');
}

function samlPreAuthCookiePath(orgSlug) {
  return `/api/auth/sso/${normalizeOrgSlug(orgSlug)}/callback`;
}

function getSamlPreAuthCookieOptions(orgSlug, maxAgeMs, env = process.env) {
  const maxAge = Number(maxAgeMs);
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0 || maxAge > 15 * 60 * 1000) {
    throw new TypeError('invalid SAML pre-auth cookie lifetime');
  }
  return {
    httpOnly: true,
    secure: isProductionLike(env),
    sameSite: 'none',
    path: samlPreAuthCookiePath(orgSlug),
    maxAge,
  };
}

function setSamlPreAuthCookie(
  res,
  { orgSlug, nonce, maxAgeMs },
  env = process.env,
) {
  const normalizedNonce = normalizePreAuthNonce(nonce);
  if (!normalizedNonce) throw new TypeError('invalid SAML pre-auth nonce');
  return res.cookie(
    SAML_PREAUTH_COOKIE_NAME,
    normalizedNonce,
    getSamlPreAuthCookieOptions(orgSlug, maxAgeMs, env),
  );
}

function clearSamlPreAuthCookie(res, orgSlug, env = process.env) {
  const { maxAge: _maxAge, ...options } = getSamlPreAuthCookieOptions(
    orgSlug,
    1,
    env,
  );
  return res.clearCookie(SAML_PREAUTH_COOKIE_NAME, options);
}

function readSamlPreAuthCookie(req) {
  return normalizePreAuthNonce(req?.cookies?.[SAML_PREAUTH_COOKIE_NAME]);
}

module.exports = {
  SAML_PREAUTH_COOKIE_NAME,
  SAML_PREAUTH_NONCE_BYTES,
  clearSamlPreAuthCookie,
  createSamlPreAuthNonce,
  getSamlPreAuthCookieOptions,
  hashSamlPreAuthNonce,
  readSamlPreAuthCookie,
  samlPreAuthCookiePath,
  setSamlPreAuthCookie,
};
