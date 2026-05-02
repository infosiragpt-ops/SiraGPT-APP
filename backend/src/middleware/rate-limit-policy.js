/**
 * rate-limit-policy — pure helper that turns environment variables
 * into the four numbers the rate-limit middlewares need (window +
 * three caps).
 *
 * Why this exists as its own module:
 *   index.js was parsing four `parseInt` expressions inline, each
 *   with a fallback default. Extracting the parsing logic gives us a
 *   single place to assert that defaults kick in for missing /
 *   malformed values and that valid env values are honored — without
 *   booting express-rate-limit just to test integer parsing.
 */

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

module.exports = { resolveRateLimitConfig, FIFTEEN_MINUTES_MS };
