/**
 * rate-limit-policy — pure helpers that turn environment variables
 * into the four numbers the rate-limit middlewares need (window +
 * three caps), plus a key-generator factory that buckets requests by
 * authenticated user-id when present, falling back to IP for
 * anonymous traffic.
 *
 * Why this exists as its own module:
 *   index.js was parsing four `parseInt` expressions inline, each
 *   with a fallback default. Extracting the parsing logic gives us a
 *   single place to assert that defaults kick in for missing /
 *   malformed values and that valid env values are honored — without
 *   booting express-rate-limit just to test integer parsing. The
 *   key-generator lives here for the same reason: testable in
 *   isolation, no express runtime required.
 */

const jwt = require('jsonwebtoken');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function resolveRateLimitConfig(env = process.env) {
  return {
    windowMs: parsePositiveInt(env.RATE_LIMIT_WINDOW_MS, FIFTEEN_MINUTES_MS),
    auth: parsePositiveInt(env.RATE_LIMIT_AUTH_MAX, 30),
    expensive: parsePositiveInt(env.RATE_LIMIT_EXPENSIVE_MAX, 60),
    api: parsePositiveInt(env.RATE_LIMIT_API_MAX, 1000),
  };
}

/**
 * Pull a Bearer token off the request without trusting headers blindly.
 * Honors both the Authorization header and the `token` cookie that
 * `authenticateToken` / `optionalAuth` already accept, so the rate-
 * limit bucket matches whatever later auth middleware would see.
 */
function extractBearerToken(req) {
  if (!req || !req.headers) return null;
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header === 'string') {
    const [scheme, value] = header.split(' ');
    if (scheme && scheme.toLowerCase() === 'bearer' && value) return value;
  }
  if (req.cookies && typeof req.cookies.token === 'string' && req.cookies.token) {
    return req.cookies.token;
  }
  return null;
}

/**
 * makeJwtAwareKeyGenerator — returns a function suitable as
 * express-rate-limit's `keyGenerator`. Decodes the bearer token using
 * the supplied JWT secret and buckets by `user:<userId>` when the
 * signature verifies. Anonymous and expired-token traffic falls back
 * to `ip:<req.ip>`.
 *
 * Two design choices worth stating explicitly:
 *
 *   1. We DO verify the JWT signature (`jwt.verify`), not just
 *      `jwt.decode`, so an attacker can't pin their abuse to a
 *      victim's bucket by forging a token. Forgeries silently fall
 *      back to the IP bucket.
 *   2. We DO NOT hit the database to confirm the session row still
 *      exists. The auth middleware does that downstream; for rate-
 *      limiting purposes "this request was signed by a known user"
 *      is the right precondition. Removing the DB lookup keeps the
 *      limiter cheap on the hot path (every /api/ request).
 *
 * If `jwtSecret` is missing/empty, the generator degrades gracefully
 * to IP-only bucketing — a misconfigured deploy is rate-limited, not
 * unlimited.
 */
function makeJwtAwareKeyGenerator(jwtSecret) {
  return function keyGenerator(req) {
    if (jwtSecret) {
      const token = extractBearerToken(req);
      if (token) {
        try {
          const decoded = jwt.verify(token, jwtSecret);
          const userId = decoded && (decoded.userId || decoded.id || decoded.sub);
          if (userId) return `user:${userId}`;
        } catch (_err) {
          // Forged / expired / wrong-secret token → drop to IP bucket.
        }
      }
    }
    // Match express-rate-limit's default. `app.set('trust proxy', 1)`
    // is already set in index.js so req.ip reflects X-Forwarded-For.
    return `ip:${req.ip || 'unknown'}`;
  };
}

module.exports = {
  resolveRateLimitConfig,
  makeJwtAwareKeyGenerator,
  extractBearerToken,
  FIFTEEN_MINUTES_MS,
};
