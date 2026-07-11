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
 *   - Webhooks are exempt only through exact-path selectors at the mount
 *     point (Stripe uses `stripe-webhook-ingress.js`); sibling cookie-auth
 *     routes remain under `requireCsrf`.
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
const { resolveAllowedOrigins } = require('./cors-policy');
const { isProductionLike } = require('../utils/environment');

const TOKEN_BYTES = 32;
const TOKEN_COOKIE = 'csrf_token';
const SECRET_COOKIE = '_csrf_secret';
const HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// How long a stateless self-signed token stays valid. Bounds the replay
// window for the cookieless fallback path (see makeStatelessToken).
const STATELESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * Mint a self-signed CSRF token: `<nonce>.<ts>.<sig>` where
 * `sig = HMAC(nonce.ts, pepper)`. Unlike a bare random token this can be
 * validated WITHOUT the httpOnly secret cookie — the server just recomputes
 * the HMAC. That makes it work in cross-site iframe contexts (Replit canvas
 * preview) and browsers that block third-party cookies (Safari ITP), where
 * the `_csrf_secret` cookie never reaches the backend.
 *
 * When an Express session id is available, the signature also includes that
 * server-known id. The id itself is never embedded in the public token. This
 * prevents a stateless token minted in one browser session from being replayed
 * in another. Requests without a session retain the header-only fallback.
 */
function makeStatelessToken(sessionBinding) {
  const nonce = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const ts = Date.now().toString(36);
  const payload = `${nonce}.${ts}`;
  const sig = hashToken(statelessSignaturePayload(payload, sessionBinding));
  return `${payload}.${sig}`;
}

// Tolerance for clock drift between the issuing and verifying clocks. Bounds
// how far in the "future" an embedded timestamp may be before we reject it as
// malformed/forged (a legitimate token can never be issued in the future).
const STATELESS_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a self-signed token minted by makeStatelessToken. Returns true only
 * when the HMAC signature matches AND the embedded timestamp is within the
 * `[now - maxAgeMs, now + skew]` window. Old-format bare-hex tokens (no dots)
 * return false.
 *
 * SECURITY: a valid signature only proves the token was minted by THIS server
 * — it is NOT bound to any session/user. Callers MUST therefore only honor a
 * stateless token submitted via a custom request header (X-CSRF-Token), never
 * from a body/form field. A custom header cannot be set on a cross-site
 * request without a CORS preflight (which the server rejects for unknown
 * origins), so the header requirement is what preserves CSRF protection. See
 * requireCsrf for the enforcement.
 */
function statelessSignaturePayload(payload, sessionBinding) {
  const binding = normalizeSessionBinding(sessionBinding);
  return binding ? `${payload}\0session:${binding}` : payload;
}

function normalizeSessionBinding(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  return normalized.slice(0, 2048);
}

function csrfSessionBinding(req) {
  if (!req || typeof req !== 'object') return '';
  return normalizeSessionBinding(
    req.sessionID
    || req.session?.id
    || req.session?.sessionID,
  );
}

function verifyStatelessToken(
  token,
  maxAgeMs = STATELESS_MAX_AGE_MS,
  sessionBinding,
) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!nonce || !ts || !sig) return false;
  const payload = `${nonce}.${ts}`;
  const expectedSig = hashToken(statelessSignaturePayload(payload, sessionBinding));
  if (!timingSafeEqual(expectedSig, sig)) return false;
  const issuedAt = parseInt(ts, 36);
  if (!Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  if (age > maxAgeMs) return false; // expired
  if (age < -STATELESS_CLOCK_SKEW_MS) return false; // issued in the future → forged/malformed
  return true;
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

function hasCookieAuth(req) {
  const token = req?.cookies?.token;
  return typeof token === 'string' && token.trim().length > 0;
}

function cookieRequestContextFailure(req, env = process.env) {
  if (!hasCookieAuth(req)) return null;
  const origin = readHeader(req, 'origin');
  let allowedOrigins;
  try {
    allowedOrigins = resolveAllowedOrigins(env);
  } catch (_error) {
    return 'untrusted_origin';
  }
  if (
    typeof origin !== 'string'
    || origin === 'null'
    || !allowedOrigins.includes(origin)
  ) {
    return 'untrusted_origin';
  }

  const fetchSite = String(readHeader(req, 'sec-fetch-site') || '').trim().toLowerCase();
  if (fetchSite !== 'same-origin' && fetchSite !== 'same-site') {
    return 'invalid_fetch_site';
  }
  return null;
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
function issueCsrfToken(res, req) {
  const token = makeStatelessToken(csrfSessionBinding(req));
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
  const secure = isProductionLike(process.env) || isReplitSidecar;
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
  const token = issueCsrfToken(res, req);
  setCsrfSecurityHeaders(res);
  res.json({ csrfToken: token });
}

/**
 * Middleware: requireCsrf — validates the double-submit token for
 * state-mutating methods. Safe methods (GET/HEAD/OPTIONS) and
 * bearer-authenticated requests are passed through.
 *
 * Two validation paths:
 *   1. Double-submit cookie (PRIMARY) — accepts the token from EITHER the
 *      `X-CSRF-Token` header OR the `_csrf`/`csrfToken` body field, because
 *      security comes from the un-readable httpOnly `_csrf_secret` cookie that
 *      must round-trip. Used whenever the browser stores cookies (direct
 *      top-level access, e.g. production siragpt.com).
 *   2. Stateless self-signed token (FALLBACK) — used when the secret cookie
 *      never arrives (cross-site iframe previews, Safari ITP). Only honored
 *      from the `X-CSRF-Token` HEADER, never from the body/form field: a
 *      stateless token is global (not session-bound), so accepting it from a
 *      body field would let an attacker mint a valid token and replay it via a
 *      plain cross-site <form> POST. A custom header requires a CORS preflight
 *      the server rejects for unknown origins, which is what keeps this safe.
 *
 * On failure the request is rejected with 403 and a stable
 * `error: 'csrf_invalid'` code so the frontend can refresh its token.
 */
function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (hasBearerAuth(req)) return next();

  // Allow opt-out via env (e.g. integration tests) — keeps the rest
  // of the suite from needing to plumb tokens through every request. The
  // production validator blocks this setting and runtime ignores it as
  // defense in depth.
  if (
    !isProductionLike(process.env)
    && ['1', 'true'].includes(String(process.env.CSRF_DISABLED || '').trim().toLowerCase())
  ) {
    return next();
  }

  const contextFailure = cookieRequestContextFailure(req, process.env);
  if (contextFailure) return rejectCsrf(req, res, contextFailure);

  const headerToken = readHeader(req, HEADER_NAME) || readHeader(req, 'x-xsrf-token');
  const bodyToken = req.body && (req.body._csrf || req.body.csrfToken);
  const submitted = headerToken || bodyToken;

  const secret = req.cookies && req.cookies[SECRET_COOKIE];

  if (!submitted) {
    return rejectCsrf(req, res, 'missing_token');
  }

  // Primary path — double-submit cookie. Strongest defense: requires the
  // httpOnly _csrf_secret cookie to round-trip, which it does whenever the
  // browser stores cookies (direct top-level access, e.g. production
  // siragpt.com).
  if (secret) {
    const expected = hashToken(submitted);
    if (timingSafeEqual(expected, secret)) {
      return next();
    }
    // Secret present but mismatched — fall through to the stateless check
    // below before rejecting, so a freshly-issued self-signed token still
    // validates even if the browser kept a stale secret cookie.
  }

  // Fallback path — stateless self-signed token. Required when the
  // _csrf_secret cookie never arrives: cross-site iframe previews (Replit
  // canvas) and browsers that block third-party cookies (Safari ITP).
  //
  // CRITICAL: only the HEADER token is eligible here, never the body/form
  // field. A stateless token is global (not session-bound), so an attacker can
  // mint a valid one for themselves; if it were accepted from a body field they
  // could replay it via a plain cross-site <form> POST and bypass CSRF. A
  // custom header cannot be set cross-site without a CORS preflight (rejected
  // for unknown origins), which is what keeps this path safe.
  if (
    headerToken
    && verifyStatelessToken(
      headerToken,
      STATELESS_MAX_AGE_MS,
      csrfSessionBinding(req),
    )
  ) {
    return next();
  }

  return rejectCsrf(req, res, secret ? 'mismatch' : 'missing_token');
}

module.exports = {
  csrfTokenRoute,
  issueCsrfToken,
  requireCsrf,
  hashToken,
  generateToken,
  makeStatelessToken,
  verifyStatelessToken,
  csrfSessionBinding,
  cookieRequestContextFailure,
  hasBearerAuth,
  hasCookieAuth,
  readHeader,
  rejectCsrf,
  setCsrfSecurityHeaders,
  TOKEN_COOKIE,
  SECRET_COOKIE,
  HEADER_NAME,
};
