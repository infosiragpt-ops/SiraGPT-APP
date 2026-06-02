'use strict';

// ──────────────────────────────────────────────────────────────
// SiraGPT — OAuth Callback URL Boot Validator
// ──────────────────────────────────────────────────────────────
// Defense-in-depth check executed at boot. When GOOGLE_AUTH_BASE_URL
// is set, the resolved OAuth callback host must match. A mismatch
// means env vars were changed mid-deploy or loaded in an unexpected
// order — the user would silently get a redirect error on OAuth login.
//
// Emits a structured logger.warn with both the expected and actual
// URLs so the problem surfaces immediately in server logs and is
// picked up by existing monitoring (Sentry / PostHog).
//
// Non-blocking — never throws, never exits. Fire-and-forget.
// ──────────────────────────────────────────────────────────────

const {
  getGoogleCallbackURL,
  resolvePublicBackendUrl,
} = require('../config/oauth-url-policy');

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function parseHostname(urlValue) {
  if (!urlValue) return '';
  try {
    return normalizeHostname(new URL(urlValue).hostname);
  } catch {
    return '';
  }
}

/**
 * At startup, assert that the OAuth callback URL resolves to a host
 * that matches GOOGLE_AUTH_BASE_URL when that variable is present.
 *
 * Fire-and-forget — callers MUST NOT await on the result for
 * critical-path startup. All exceptions are swallowed (logged at
 * warn level) so a bug in this validator never crashes boot.
 *
 * @param {object} [deps]
 * @param {object} [deps.logger]  - pino-like logger (defaults to console)
 * @param {object} [deps.env]     - defaults to process.env (test injection)
 * @returns {{ checked: boolean, mismatch: boolean }}
 */
function validateOAuthCallbackUrl(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;

  // Only meaningful when the operator has pinned the base URL.
  if (!env.GOOGLE_AUTH_BASE_URL) {
    return { checked: false, mismatch: false };
  }

  let resolvedCallback;
  let resolvedBase;
  try {
    resolvedCallback = getGoogleCallbackURL(env);
    resolvedBase = resolvePublicBackendUrl(env);
  } catch (err) {
    try {
      logger.warn(
        { err: err && err.message },
        'oauth_callback_boot_validator_resolve_failed',
      );
    } catch (_e) { /* swallow */ }
    return { checked: false, mismatch: false };
  }

  const expectedHost = parseHostname(env.GOOGLE_AUTH_BASE_URL);
  const resolvedHost = parseHostname(resolvedCallback);

  if (!expectedHost || !resolvedHost) {
    return { checked: false, mismatch: false };
  }

  if (expectedHost !== resolvedHost) {
    try {
      logger.warn(
        {
          expectedBaseUrl: env.GOOGLE_AUTH_BASE_URL,
          resolvedCallbackUrl: resolvedCallback,
          resolvedBaseUrl: resolvedBase,
          expectedHost,
          resolvedHost,
          hint:
            'GOOGLE_AUTH_BASE_URL host does not match the resolved OAuth callback host. ' +
            'Check that GOOGLE_AUTH_BASE_URL, GOOGLE_AUTH_URI, and related secrets are ' +
            'consistent. OAuth logins will redirect to the wrong host.',
        },
        'oauth_callback_host_mismatch',
      );
    } catch (_e) { /* swallow */ }
    return { checked: true, mismatch: true };
  }

  return { checked: true, mismatch: false };
}

module.exports = { validateOAuthCallbackUrl };
