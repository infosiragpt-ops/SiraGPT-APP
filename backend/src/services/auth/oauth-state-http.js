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

module.exports = {
  isOAuthStateInfrastructureError,
  retryAfterSeconds,
  sendOAuthStateUnavailable,
};
