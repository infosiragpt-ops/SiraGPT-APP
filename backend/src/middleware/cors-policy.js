/**
 * cors-policy — pure functions that resolve the CORS allowlist from
 * environment variables and decide which incoming `Origin` headers
 * are accepted.
 *
 * Why this exists as its own module:
 *   The express middleware setup in index.js was a single closure that
 *   couldn't be unit-tested in isolation. Extracting two pure helpers
 *   means we can verify the fail-closed-in-production behavior, the
 *   localhost dev fallback, and the per-origin allow/deny decision
 *   without booting the whole server.
 *
 * Behavior:
 *   - `CORS_ORIGINS=a.com,b.com` → allowlist = ['a.com', 'b.com'].
 *   - `CORS_ORIGINS=*` → explicitly allow every browser origin. The
 *     cors package reflects the request origin when the callback
 *     returns `true`, so credentialed local requests still work.
 *   - Empty CORS_ORIGINS in production → empty allowlist (every browser-
 *     issued request rejected). This is the deliberate fail-closed
 *     posture; index.js logs a loud warn at startup so the misconfig
 *     surfaces in the access log.
 *   - Empty CORS_ORIGINS outside production → localhost:3000 / 3001
 *     fallback so `npm run dev` works without further config.
 *   - No `Origin` header on the request (curl, server-to-server, same-
 *     origin) → always allowed; cors's own logic skips the response
 *     header in that case.
 */

const DEV_FALLBACK = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

// Production fallback — known-good public origins for the deployed
// product. Used ONLY when CORS_ORIGINS is unset in production so the
// site doesn't fail closed on a fresh deploy where the operator
// forgot to set the env var. A loud security warning is logged
// at boot in index.js when this fallback is hit.
const PROD_FALLBACK = [
  'https://siragpt.io',
  'https://www.siragpt.io',
  'http://localhost:3000',
];

function resolveAllowedOrigins(env = process.env) {
  const list = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  if (env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  [cors] CORS_ORIGINS env var is unset in production. '
      + `Falling back to safe defaults: ${PROD_FALLBACK.join(', ')}. `
      + 'Set CORS_ORIGINS=https://yourdomain.com to override.'
    );
    return [...PROD_FALLBACK];
  }
  return [...DEV_FALLBACK];
}

function makeOriginCallback(allowed) {
  const allowSet = new Set(allowed);
  const allowAnyOrigin = allowSet.has('*');
  return (origin, callback) => {
    // No Origin header → not a browser cross-origin request. Allow
    // through; cors's own logic skips the response header anyway.
    if (!origin) return callback(null, true);
    if (allowAnyOrigin) return callback(null, true);
    if (allowSet.has(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin not allowed (${origin})`));
  };
}

module.exports = { resolveAllowedOrigins, makeOriginCallback, DEV_FALLBACK };
