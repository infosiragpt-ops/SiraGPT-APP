'use strict';

/**
 * csrf — double-submit-cookie CSRF protection for cookie-authenticated
 * endpoints (improvement cycle 17, Task 1).
 *
 * Design — why double-submit instead of csurf:
 *   - `csurf` is deprecated upstream and forces a server-side session
 *     store. siraGPT already authenticates via JWT-in-cookie, so a
 *     stateless double-submit pattern is a better fit:
 *       1. Server issues a random `csrfToken` cookie (NOT httpOnly so
 *          JS can read it) bound to a httpOnly secret cookie.
 *       2. Client echoes the token in `X-CSRF-Token` (or `_csrf` body
 *          field). Server compares hashed(token) against the secret
 *          cookie. Cross-site attackers can't read the cookie so they
 *          can't forge the header.
 *
 *   - Bearer-auth API clients (mobile, server-to-server) are exempt:
 *     they don't send the auth cookie cross-site, so CSRF doesn't apply.
 *     The middleware detects bearer auth via `Authorization: Bearer …`
 *     and short-circuits.
 *
 *   - Webhooks (Stripe, etc.) are exempt by NOT being mounted under
 *     `requireCsrf`. Callers wire this only on cookie-auth routers.
 *
 * Threat model assumptions:
 *   - Attacker can make the victim's browser issue a same-cookies POST
 *     to our origin. They CANNOT read response bodies or our cookies
 *     (SameOrigin policy).
 *   - The `token` cookie value is opaque, 32 random bytes hex-encoded.
 *   - The `_csrf_secret` cookie is httpOnly and contains
 *     sha256(token || pepper). Attackers can't read it, so even if
 *     they steal a stale token they can't validate.
 */

const crypto = require('crypto');
const { getRequestId } = require('./request-id');

const TOKEN_BYTES = 32;
const TOKEN_COOKIE = 'csrf_token';
const SECRET_COOKIE = '_csrf_secret';
const HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getPepper() {
  return (
    process.env.CSRF_PEPPER ||
    process.env.JWT_SECRET ||
    'siragpt-csrf-default-pepper-change-me'
  );
}

function hashToken(token, pepper = getPepper()) {
  return crypto
    .createHmac('sha256', pepper)
    .update(String(token))
    .digest('hex');
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readHeader(req, name) {
  if (!req || !req.headers) return undefined;
  const direct = req.headers[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (String(key).toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function setCsrfSecurityHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  if (typeof res.getHeader !== 'function' || !res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function rejectCsrf(req, res, reason) {
  setCsrfSecurityHeaders(res);
  return res.status(403).json({
    ok: false,
    error: 'csrf_invalid',
    message: 'CSRF token invalid or missing',
    code: 'csrf_invalid',
    reason,
    ...(getRequestId(req) ? { requestId: getRequestId(req) } : {}),
  });
}

/**
 * Has bearer-auth — if so, CSRF does not apply because the browser
 * does not auto-send Authorization headers cross-origin.
 */
function hasBearerAuth(req) {
  const h = readHeader(req, 'authorization');
  return typeof h === 'string' && /^bearer\s+\S+/i.test(h);
}

/**
 * Issues a fresh CSRF token pair on the response (sets both the public
 * `csrf_token` cookie + the httpOnly `_csrf_secret` cookie) and returns
 * the public token so callers can attach it to JSON response bodies.
 *
 * Used by:
 *   • `csrfTokenRoute` — the explicit GET /api/csrf-token endpoint.
 *   • `/api/auth/login` + `/api/auth/register` (ratchet 45, task 2) so
 *     SPA clients receive the token in the same roundtrip and can skip
 *     the dedicated fetch. Token still rotates because every call to
 *     this helper generates a brand-new random value.
 */
function issueCsrfToken(res) {
  const token = generateToken();
  const secret = hashToken(token);
  // In the Replit dev environment the app is previewed inside a cross-site
  // iframe (top-level origin: replit.com, iframe origin: *.riker.replit.dev).
  // SameSite=Strict prevents cookies from being sent on cross-site subrequests,
  // so the _csrf_secret cookie never reaches the backend and every POST gets
  // a 403 missing_token. SameSite=None;Secure allows the cookie in cross-site
  // iframe contexts while still protecting against real CSRF (requires Secure).
  // In real production the app is accessed directly so Strict is fine.
  const isReplitSidecar = process.env.REPLIT_BACKEND_MODE === 'sidecar';
  const sameSite = isReplitSidecar ? 'none' : 'strict';
  const secure = process.env.NODE_ENV === 'production' || isReplitSidecar;
  const cookieOpts = {
    httpOnly: false, // client JS must be able to read it
    secure,
    sameSite,
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
  const secretOpts = { ...cookieOpts, httpOnly: true };
  res.cookie(TOKEN_COOKIE, token, cookieOpts);
  res.cookie(SECRET_COOKIE, secret, secretOpts);
  return token;
}

/**
 * Route handler: GET /api/csrf-token — issues a fresh token pair and
 * returns the public token in the JSON body so SPA clients can attach
 * it to subsequent state-mutating calls.
 */
function csrfTokenRoute(req, res) {
  const token = issueCsrfToken(res);
  setCsrfSecurityHeaders(res);
  res.json({ csrfToken: token });
}

/**
 * Middleware: requireCsrf — validates the double-submit token for
 * state-mutating methods. Safe methods (GET/HEAD/OPTIONS) and
 * bearer-authenticated requests are passed through.
 *
 * Token lookup order:
 *   1. `X-CSRF-Token` header (preferred — easier for SPA clients)
 *   2. `_csrf` body field (for traditional form posts)
 *
 * On failure the request is rejected with 403 and a stable
 * `error: 'csrf_invalid'` code so the frontend can refresh its token.
 */
function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (hasBearerAuth(req)) return next();

  // Allow opt-out via env (e.g. integration tests) — keeps the rest
  // of the suite from needing to plumb tokens through every request.
  if (process.env.CSRF_DISABLED === '1' || process.env.CSRF_DISABLED === 'true') {
    return next();
  }

  const headerToken = readHeader(req, HEADER_NAME) || readHeader(req, 'x-xsrf-token');
  const bodyToken = req.body && (req.body._csrf || req.body.csrfToken);
  const submitted = headerToken || bodyToken;

  const secret = req.cookies && req.cookies[SECRET_COOKIE];

  if (!submitted || !secret) {
    return rejectCsrf(req, res, 'missing_token');
  }

  const expected = hashToken(submitted);
  if (!timingSafeEqual(expected, secret)) {
    return rejectCsrf(req, res, 'mismatch');
  }

  return next();
}

module.exports = {
  csrfTokenRoute,
  issueCsrfToken,
  requireCsrf,
  hashToken,
  generateToken,
  hasBearerAuth,
  readHeader,
  rejectCsrf,
  setCsrfSecurityHeaders,
  TOKEN_COOKIE,
  SECRET_COOKIE,
  HEADER_NAME,
};
