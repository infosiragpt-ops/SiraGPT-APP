'use strict';

// ──────────────────────────────────────────────────────────────
// SiraGPT — OAuth Callback URL Boot Validator
// ──────────────────────────────────────────────────────────────
// Provider-aware defense-in-depth check executed at boot and reused by the
// optional-provider route gates. It validates:
//
//   1. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are both present
//      when any Google credential is set.
//   2. GOOGLE_AUTH_BASE_URL (when present) is a well-formed URL
//      and does not point to localhost in production.
//   3. All three resolved OAuth callback URLs (Google, Gmail,
//      Google-Services) are well-formed and are not localhost in
//      production — a localhost callback in production silently
//      breaks the OAuth round-trip for every user.
//   4. The resolved Google callback host matches
//      GOOGLE_AUTH_BASE_URL when that variable is set.
//   5. GitHub and Spotify have complete credentials plus explicit callback
//      URLs and approved-origin post-callback URLs before either is enabled.
//
// Blocking policy: invalid configured Google/core OAuth blocks production.
// GitHub and Spotify are optional; invalid configuration disables only that
// provider and is surfaced as a sanitized degraded status.
// ──────────────────────────────────────────────────────────────

const {
  getGoogleCallbackURL,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
  getGithubCallbackURL,
  getSpotifyCallbackURL,
  isAllowedOAuthPostCallbackUrl,
  isLocalhostUrl,
} = require('../config/oauth-url-policy');

// Value-free Google/core reasons that block production startup.
const BLOCKING_ISSUE_CODES = new Set([
  'client_id_missing',
  'client_secret_missing',
  'base_url_malformed',
  'base_url_localhost_in_production',
  'base_url_https_required',
  'callback_url_missing',
  'callback_url_malformed',
  'callback_localhost_in_production',
  'callback_https_required',
  'callback_host_mismatch',
  'callback_resolution_failed',
  'validator_error',
]);

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function isWellFormedUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol);
  } catch {
    return false;
  }
}

const OPTIONAL_PROVIDER_ENV = Object.freeze({
  github: Object.freeze({
    clientId: 'GITHUB_CLIENT_ID',
    clientSecret: 'GITHUB_CLIENT_SECRET',
    callback: 'GITHUB_OAUTH_REDIRECT_URI',
    callbackGetter: getGithubCallbackURL,
    postCallbacks: Object.freeze([
      Object.freeze({
        key: 'GITHUB_OAUTH_SUCCESS_REDIRECT',
        prefix: 'post_callback',
      }),
    ]),
  }),
  spotify: Object.freeze({
    clientId: 'SPOTIFY_CLIENT_ID',
    clientSecret: 'SPOTIFY_CLIENT_SECRET',
    callback: 'SPOTIFY_REDIRECT_URI',
    callbackGetter: getSpotifyCallbackURL,
    postCallbacks: Object.freeze([
      Object.freeze({
        key: 'SPOTIFY_OAUTH_SUCCESS_REDIRECT',
        prefix: 'success_post_callback',
      }),
      Object.freeze({
        key: 'SPOTIFY_OAUTH_FAILURE_REDIRECT',
        prefix: 'failure_post_callback',
      }),
    ]),
  }),
});

const GOOGLE_PROVIDER_ENV_KEYS = Object.freeze([
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_AUTH_BASE_URL',
  'GOOGLE_AUTH_URI',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_REDIRECT_CALENDAR_DRIVE_URI',
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Return value-free reason codes for one required OAuth URL. These codes are
 * safe to expose through /health and route errors: no URL, host, query value,
 * credential, or provider response is retained.
 */
function configuredUrlReasons(value, prefix, isProd) {
  if (!nonEmpty(value)) return [`${prefix}_url_missing`];
  if (!isWellFormedUrl(value)) return [`${prefix}_url_malformed`];

  const reasons = [];
  if (isProd && isLocalhostUrl(value)) {
    reasons.push(`${prefix}_localhost_in_production`);
  }
  if (isProd && new URL(value).protocol !== 'https:') {
    reasons.push(`${prefix}_https_required`);
  }
  return reasons;
}

function callbackHostMismatch(configured, resolved) {
  if (!isWellFormedUrl(configured) || !isWellFormedUrl(resolved)) return false;
  return normalizeHostname(new URL(configured).hostname)
    !== normalizeHostname(new URL(resolved).hostname);
}

function optionalProviderStatus(provider, env, isProd) {
  const descriptor = OPTIONAL_PROVIDER_ENV[provider];
  const relevantKeys = [
    descriptor.clientId,
    descriptor.clientSecret,
    descriptor.callback,
    ...descriptor.postCallbacks.map(({ key }) => key),
  ];
  const configured = relevantKeys.some((key) => nonEmpty(env[key]));
  if (!configured) {
    return {
      configured: false,
      enabled: false,
      status: 'disabled',
      blocking: false,
      reasons: [],
    };
  }

  const reasons = [];
  if (!nonEmpty(env[descriptor.clientId])) reasons.push('client_id_missing');
  if (!nonEmpty(env[descriptor.clientSecret])) reasons.push('client_secret_missing');

  const callbackReasons = configuredUrlReasons(env[descriptor.callback], 'callback', isProd);
  reasons.push(...callbackReasons);
  for (const { key, prefix } of descriptor.postCallbacks) {
    const postCallbackReasons = configuredUrlReasons(env[key], prefix, isProd);
    reasons.push(...postCallbackReasons);
    if (
      isProd
      && postCallbackReasons.length === 0
      && !isAllowedOAuthPostCallbackUrl(env[key], env)
    ) {
      reasons.push(`${prefix}_origin_not_allowed`);
    }
  }

  // oauth-url-policy intentionally refuses a callback on a different host.
  // Surface that refusal instead of silently authorizing with a derived URL
  // that does not match the provider dashboard registration.
  if (callbackReasons.length === 0) {
    try {
      const resolved = descriptor.callbackGetter(env);
      if (callbackHostMismatch(env[descriptor.callback], resolved)) {
        reasons.push('callback_host_mismatch');
      }
    } catch {
      reasons.push('callback_resolution_failed');
    }
  }

  const safeReasons = unique(reasons);
  const enabled = safeReasons.length === 0;
  return {
    configured: true,
    enabled,
    status: enabled ? 'healthy' : 'degraded',
    blocking: false,
    reasons: safeReasons,
  };
}

function googleProviderStatus(env, isProd) {
  const hasClientId = nonEmpty(env.GOOGLE_CLIENT_ID);
  const hasClientSecret = nonEmpty(env.GOOGLE_CLIENT_SECRET);
  const validationActive = GOOGLE_PROVIDER_ENV_KEYS.some((key) => nonEmpty(env[key]));
  const reasons = [];

  // Preserve the existing paired-credential policy: a valid public base URL
  // may be shared by optional providers without enabling Google OAuth.
  if (hasClientId && !hasClientSecret) reasons.push('client_secret_missing');
  if (hasClientSecret && !hasClientId) reasons.push('client_id_missing');

  if (nonEmpty(env.GOOGLE_AUTH_BASE_URL)) {
    reasons.push(...configuredUrlReasons(env.GOOGLE_AUTH_BASE_URL, 'base', isProd).map(
      (reason) => reason.replace(/^base_(localhost|https)/, 'base_url_$1'),
    ));
  }
  for (const key of [
    'GOOGLE_AUTH_URI',
    'GOOGLE_REDIRECT_URI',
    'GOOGLE_REDIRECT_CALENDAR_DRIVE_URI',
  ]) {
    if (nonEmpty(env[key])) {
      reasons.push(...configuredUrlReasons(env[key], 'callback', isProd));
    }
  }

  if (hasClientId || hasClientSecret || nonEmpty(env.GOOGLE_AUTH_BASE_URL)) {
    try {
      const resolvedCallbacks = [
        getGoogleCallbackURL(env),
        getGoogleGmailCallbackURL(env),
        getGoogleServicesCallbackURL(env),
      ];
      for (const callback of resolvedCallbacks) {
        reasons.push(...configuredUrlReasons(callback, 'callback', isProd));
      }

      if (
        nonEmpty(env.GOOGLE_AUTH_BASE_URL)
        && callbackHostMismatch(env.GOOGLE_AUTH_BASE_URL, resolvedCallbacks[0])
      ) {
        reasons.push('callback_host_mismatch');
      }
    } catch {
      reasons.push('callback_resolution_failed');
    }
  }

  const safeReasons = unique(reasons);
  const enabled = hasClientId && hasClientSecret && safeReasons.length === 0;
  const blocking = isProd && safeReasons.some((reason) => BLOCKING_ISSUE_CODES.has(reason));
  return {
    configured: validationActive,
    enabled,
    status: safeReasons.length > 0 ? 'degraded' : (enabled ? 'healthy' : 'disabled'),
    blocking,
    reasons: safeReasons,
  };
}

function providerEnvKeys(provider) {
  if (provider === 'google') return GOOGLE_PROVIDER_ENV_KEYS;
  const descriptor = OPTIONAL_PROVIDER_ENV[provider];
  if (!descriptor) return [];
  return [
    descriptor.clientId,
    descriptor.clientSecret,
    descriptor.callback,
    ...descriptor.postCallbacks.map(({ key }) => key),
  ];
}

function providerConfiguredHint(provider, env) {
  try {
    return providerEnvKeys(provider).some((key) => nonEmpty(env[key]));
  } catch {
    // If configuration cannot be inspected, production core OAuth must not
    // be allowed to fail open.
    return true;
  }
}

function validatorErrorStatus(provider, env, isProd) {
  const configured = providerConfiguredHint(provider, env);
  return {
    configured,
    enabled: false,
    status: 'degraded',
    blocking: provider === 'google' && isProd && configured,
    reasons: ['validator_error'],
  };
}

function normalizeProviderStatus(provider, status) {
  if (!status || typeof status !== 'object') {
    throw new TypeError(`${provider} validator returned no status`);
  }
  if (!['healthy', 'degraded', 'disabled'].includes(status.status)) {
    throw new TypeError(`${provider} validator returned an invalid status`);
  }
  if (!Array.isArray(status.reasons)) {
    throw new TypeError(`${provider} validator returned invalid reasons`);
  }
  const reasons = unique(status.reasons.map((reason) => String(reason || '').trim()));
  if (reasons.some((reason) => !/^[a-z][a-z0-9_]{0,79}$/.test(reason))) {
    throw new TypeError(`${provider} validator returned unsafe reasons`);
  }
  return {
    configured: Boolean(status.configured),
    enabled: Boolean(status.enabled),
    status: status.status,
    blocking: provider === 'google' ? Boolean(status.blocking) : false,
    reasons,
  };
}

function defaultProviderValidator(provider, env, isProd) {
  if (provider === 'google') return googleProviderStatus(env, isProd);
  return optionalProviderStatus(provider, env, isProd);
}

function productionEnvironmentHint(env) {
  try {
    return env.NODE_ENV === 'production';
  } catch {
    // An unreadable environment must use the stricter policy.
    return true;
  }
}

function classifyOAuthProviders(env = process.env, deps = {}) {
  const isProd = productionEnvironmentHint(env);
  const validators = deps.providerValidators || {};
  const providers = {};
  for (const provider of ['google', 'github', 'spotify']) {
    try {
      const validator = typeof validators[provider] === 'function'
        ? validators[provider]
        : defaultProviderValidator;
      const status = validator === defaultProviderValidator
        ? validator(provider, env, isProd)
        : validator(env, isProd);
      providers[provider] = normalizeProviderStatus(provider, status);
    } catch {
      providers[provider] = validatorErrorStatus(provider, env, isProd);
    }
  }
  return providers;
}

function providerIssues(providers) {
  return Object.entries(providers).flatMap(([provider, status]) => (
    status.reasons.map((reason) => `${provider}_${reason}`)
  ));
}

function providerResult(env, deps = {}) {
  const providers = classifyOAuthProviders(env, deps);
  const issues = providerIssues(providers);
  return {
    providers,
    issues,
    shouldBlock: Object.values(providers).some((status) => status.blocking),
    checked: Object.values(providers).some(
      (status) => status.configured || status.reasons.includes('validator_error'),
    ),
    mismatch: providers.google.reasons.includes('callback_host_mismatch'),
  };
}

function logProviderClassifications(logger, providers) {
  for (const [provider, status] of Object.entries(providers)) {
    if (status.status !== 'degraded') continue;
    try {
      const log = status.blocking ? logger.error : logger.warn;
      log.call(logger, {
        provider,
        blocking: status.blocking,
        reasons: status.reasons,
      }, 'oauth_provider_config_degraded');
    } catch (_error) {
      // Configuration telemetry must never alter the boot decision.
    }
  }
}

/**
 * Validate and classify every OAuth provider without retaining configuration
 * values. The returned reasons are safe for health output and startup logs.
 */
function validateOAuthCallbackUrl(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  let result;
  try {
    result = providerResult(env, deps);
  } catch (_error) {
    const providers = Object.fromEntries(
      ['google', 'github', 'spotify'].map((provider) => [
        provider,
        validatorErrorStatus(provider, env, productionEnvironmentHint(env)),
      ]),
    );
    result = {
      checked: true,
      mismatch: false,
      issues: providerIssues(providers),
      shouldBlock: Object.values(providers).some((status) => status.blocking),
      providers,
    };
  }
  logProviderClassifications(logger, result.providers);
  return result;
}

module.exports = {
  validateOAuthCallbackUrl,
  classifyOAuthProviders,
  BLOCKING_ISSUE_CODES,
  OPTIONAL_PROVIDER_ENV,
};
