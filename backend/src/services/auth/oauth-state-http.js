'use strict';

const STATE_INFRASTRUCTURE_CODES = new Set([
  'OAUTH_STATE_STORE_UNAVAILABLE',
  'OAUTH_STATE_STORE_CAPACITY',
]);

function isOAuthStateInfrastructureError(error) {
  return STATE_INFRASTRUCTURE_CODES.has(error?.code);
}

function retryAfterSeconds(env = process.env) {
  const parsed = Number(env.OAUTH_STATE_RETRY_AFTER_SECONDS);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(300, Math.ceil(parsed)));
}

function sendOAuthStateUnavailable(
  res,
  { provider = 'oauth', error = null, env = process.env } = {},
) {
  const retryAfter = retryAfterSeconds(env);
  res.set('Cache-Control', 'no-store');
  res.set('Retry-After', String(retryAfter));
  return res.status(503).json({
    error: 'OAuth state service is temporarily unavailable. Retry shortly.',
    code: 'oauth_state_store_unavailable',
    provider: String(provider || 'oauth'),
    retryable: true,
    retryAfterSeconds: retryAfter,
    ...(error?.code ? { causeCode: error.code } : {}),
  });
}

// A state that simply aged out (slow consent screen, reloaded callback) or was
// already used is ordinary user behaviour, not a warning for the error panel.
const EXPECTED_STATE_CODES = new Set([
  'OAUTH_STATE_EXPIRED',
  'OAUTH_STATE_REPLAYED_OR_EXPIRED',
]);

function isExpectedOAuthStateError(error) {
  return EXPECTED_STATE_CODES.has(error?.code) || error?.name === 'TokenExpiredError';
}

/**
 * Google login (top-level browser navigation) state failure → login page
 * error code + log level. These are browser tabs, so the caller always
 * redirects (never a raw JSON 503). Only codes app/auth/login/page.tsx
 * already maps are returned: that page toasts an unknown code verbatim.
 * phase 'issue' (/google) cannot mean an expired state: it is always
 * «No pudimos iniciar el flujo de Google».
 */
function googleLoginStateFailure(error, { phase = 'verify' } = {}) {
  if (phase === 'issue' || isOAuthStateInfrastructureError(error)) {
    return { redirectCode: 'oauth_state_unavailable', level: 'error' };
  }
  return {
    redirectCode: 'invalid_state',
    level: isExpectedOAuthStateError(error) ? 'info' : 'warn',
  };
}

module.exports = {
  googleLoginStateFailure,
  isExpectedOAuthStateError,
  isOAuthStateInfrastructureError,
  retryAfterSeconds,
  sendOAuthStateUnavailable,
};
