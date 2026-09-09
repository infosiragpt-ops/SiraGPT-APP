'use strict';

/**
 * HMAC-signed ephemeral preview tokens (OpenSandbox / E2B getHost pattern).
 * Native rewrite — no E2B/OpenSandbox dump. Secret is injectable.
 */

const crypto = require('node:crypto');
const { fail } = require('../coding-sandbox/errors');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 60 * 60 * 1000;
const MIN_SECRET_BYTES = 16;

function clampTtlMs(value, fallback = DEFAULT_TTL_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(n)));
}

function resolvePreviewSecret(opts = {}, env = process.env) {
  if (typeof opts.secret === 'string' && opts.secret.trim()) return opts.secret.trim();
  const fromEnv = String(env.AGENTES_CODING_PREVIEW_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  if (opts.generatedSecret) return opts.generatedSecret;
  return null;
}

function requireSecret(secret) {
  if (typeof secret !== 'string' || !secret) {
    fail('E_PREVIEW_FAILED', 'Falta el secreto de vista previa.');
  }
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    fail('E_PREVIEW_FAILED', 'El secreto de vista previa es demasiado corto.');
  }
  return secret;
}

function signPreviewToken(claims, secret) {
  const key = requireSecret(secret);
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPreviewToken(token, secret, nowFn = Date.now) {
  const key = requireSecret(secret);
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  const port = Number(claims.port);
  const sid = typeof claims.sid === 'string' ? claims.sid : '';
  if (!sid || !Number.isFinite(port) || !Number.isFinite(exp) || !Number.isFinite(iat)) return null;
  if (iat > nowFn() + 30_000 || exp <= iat) return null;
  return { ...claims, sid, port, exp, iat };
}

function mintPreviewClaims({ sessionId, port, ttlMs, now }) {
  const iat = now();
  const exp = iat + clampTtlMs(ttlMs);
  return {
    sid: sessionId,
    port,
    iat,
    exp,
    n: crypto.randomBytes(8).toString('hex'),
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  MIN_SECRET_BYTES,
  clampTtlMs,
  resolvePreviewSecret,
  signPreviewToken,
  verifyPreviewToken,
  mintPreviewClaims,
};
