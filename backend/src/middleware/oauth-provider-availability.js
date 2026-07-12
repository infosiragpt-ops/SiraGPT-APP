'use strict';

const {
  classifyOAuthProviders,
  OPTIONAL_PROVIDER_ENV,
} = require('../utils/oauth-callback-boot-validator');

function requiredEnvFor(provider) {
  const descriptor = OPTIONAL_PROVIDER_ENV[provider];
  if (!descriptor) return [];
  return [
    descriptor.clientId,
    descriptor.clientSecret,
    descriptor.callback,
    ...descriptor.postCallbacks.map(({ key }) => key),
  ];
}

function unavailablePayload(provider, status) {
  const configured = Boolean(status?.configured);
  return {
    error: 'oauth_provider_unavailable',
    code: configured
      ? 'OAUTH_PROVIDER_CONFIG_INVALID'
      : 'OAUTH_PROVIDER_NOT_CONFIGURED',
    provider,
    reason: status?.reasons?.[0] || 'not_configured',
    action:
      `Configure ${provider} OAuth credentials and a public HTTPS callback; ` +
      'post-callback URLs must use a configured frontend or explicitly allowed origin.',
    requiredEnv: requiredEnvFor(provider),
  };
}

function getOptionalOAuthProviderStatus(provider, env = process.env) {
  if (!OPTIONAL_PROVIDER_ENV[provider]) {
    throw new TypeError(`Unknown optional OAuth provider: ${provider}`);
  }
  const status = classifyOAuthProviders(env)[provider];
  return {
    configured: Boolean(status.configured),
    enabled: Boolean(status.enabled),
    status: status.status,
    reasons: [...status.reasons],
  };
}

function requireOptionalOAuthProvider(provider, deps = {}) {
  if (!OPTIONAL_PROVIDER_ENV[provider]) {
    throw new TypeError(`Unknown optional OAuth provider: ${provider}`);
  }

  return function optionalOAuthProviderAvailability(_req, res, next) {
    const env = deps.env || process.env;
    const status = getOptionalOAuthProviderStatus(provider, env);
    if (status.enabled) return next();
    return res.status(503).json(unavailablePayload(provider, status));
  };
}

module.exports = {
  requireOptionalOAuthProvider,
  getOptionalOAuthProviderStatus,
  requiredEnvFor,
  unavailablePayload,
};
