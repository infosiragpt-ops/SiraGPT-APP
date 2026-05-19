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

/**
 * Has bearer-auth — if so, CSRF does not apply because the browser
 * does not auto-send Authorization headers cross-origin.
 */
function hasBearerAuth(req) {
  const h = req.headers && req.headers.authorization;
  return typeof h === 'string' && /^bearer\s+\S+/i.test(h);
}

/**
 * Route handler: GET /api/csrf-token — issues a fresh token pair and
 * returns the public token in the JSON body so SPA clients can attach
 * it to subsequent state-mutating calls.
 */
function csrfTokenRoute(req, res) {
  const token = generateToken();
  const secret = hashToken(token);
  const cookieOpts = {
    httpOnly: false, // client JS must be able to read it
    secure: process.env.NODE_ENV === 'production',
    // CSRF tokens are issued by the SPA on demand and validated via
    // double-submit on same-origin XHR/fetch. They never need to survive
    // a top-level cross-site navigation (the SPA simply re-fetches a
    // fresh token on load), so 'strict' is safe and tightens CSRF
    // defense-in-depth against same-site stripping attacks.
    sameSite: 'strict',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
  const secretOpts = { ...cookieOpts, httpOnly: true };
  res.cookie(TOKEN_COOKIE, token, cookieOpts);
  res.cookie(SECRET_COOKIE, secret, secretOpts);
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

  const headerToken =
    req.headers && (req.headers[HEADER_NAME] || req.headers['x-xsrf-token']);
  const bodyToken = req.body && (req.body._csrf || req.body.csrfToken);
  const submitted = headerToken || bodyToken;

  const secret = req.cookies && req.cookies[SECRET_COOKIE];

  if (!submitted || !secret) {
    return res.status(403).json({ error: 'csrf_invalid', reason: 'missing_token' });
  }

  const expected = hashToken(submitted);
  if (!timingSafeEqual(expected, secret)) {
    return res.status(403).json({ error: 'csrf_invalid', reason: 'mismatch' });
  }

  return next();
}

module.exports = {
  csrfTokenRoute,
  requireCsrf,
  hashToken,
  generateToken,
  hasBearerAuth,
  TOKEN_COOKIE,
  SECRET_COOKIE,
  HEADER_NAME,
};
