'use strict';

// ──────────────────────────────────────────────────────────────
// SiraGPT — OAuth Callback URL Boot Validator
// ──────────────────────────────────────────────────────────────
// Defense-in-depth check executed at boot. Validates:
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
//
// Severity policy:
//   - Production + localhost callback/base URL → logger.error
//   - Malformed URL, host mismatch              → logger.warn
//   - Missing paired credential                 → logger.warn
//
// Blocking policy (shouldBlock):
//   In production, the following issue codes are considered
//   critical enough to halt startup — callers should call
//   process.exit(1) when shouldBlock is true:
//     - malformed_google_auth_base_url
//     - google_auth_base_url_localhost_in_production
//     - oauth_callback_url_malformed
//     - oauth_callback_localhost_in_production
//     - host_mismatch
//
// Non-blocking in non-production environments — always warns,
// never exits. All exceptions are swallowed so a bug in this
// validator never crashes boot regardless of environment.
// ──────────────────────────────────────────────────────────────

const {
  getGoogleCallbackURL,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
  resolvePublicBackendUrl,
  isLocalhostUrl,
} = require('../config/oauth-url-policy');

// Issue codes that should block production startup.
// A mispaired credential is as fatal as a broken callback URL — OAuth
// will fail for every user at either the authorization or token-exchange
// step, and there is no graceful recovery path.
const BLOCKING_ISSUE_CODES = new Set([
  'missing_google_client_id',
  'missing_google_client_secret',
  'malformed_google_auth_base_url',
  'google_auth_base_url_localhost_in_production',
  'oauth_callback_url_malformed',
  'oauth_callback_localhost_in_production',
  'host_mismatch',
]);

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

function isWellFormedUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Audit a single resolved callback URL.
 * Returns an array of { level, event, data } findings.
 */
function auditCallbackUrl(resolvedUrl, label, isProd) {
  const findings = [];

  if (!resolvedUrl) {
    findings.push({
      level: 'warn',
      event: 'oauth_callback_url_empty',
      data: {
        label,
        hint:
          `${label} resolved to an empty string. ` +
          'Check that GOOGLE_AUTH_BASE_URL or the relevant redirect URI secret is set.',
      },
    });
    return findings;
  }

  if (!isWellFormedUrl(resolvedUrl)) {
    findings.push({
      level: 'warn',
      event: 'oauth_callback_url_malformed',
      data: {
        label,
        resolvedUrl,
        hint: `${label} resolved to a malformed URL: ${resolvedUrl}. OAuth logins will fail.`,
      },
    });
    return findings;
  }

  if (isProd && isLocalhostUrl(resolvedUrl)) {
    findings.push({
      level: 'error',
      event: 'oauth_callback_localhost_in_production',
      data: {
        label,
        resolvedUrl,
        hint:
          `${label} resolves to localhost in production: ${resolvedUrl}. ` +
          'Google will redirect users back to localhost and every OAuth login will fail. ' +
          'Set GOOGLE_AUTH_BASE_URL to your public production domain.',
      },
    });
  }

  return findings;
}

/**
 * At startup, validate the full Google OAuth configuration:
 *   - credential presence (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)
 *   - GOOGLE_AUTH_BASE_URL well-formedness and localhost check
 *   - all three resolved callback URLs (well-formed, not localhost in prod)
 *   - callback host matches GOOGLE_AUTH_BASE_URL (original check)
 *
 * Returns:
 *   { checked, mismatch, issues, shouldBlock }
 *
 *   shouldBlock — true when running in production AND at least one
 *   critical issue was found. Callers should process.exit(1) when
 *   shouldBlock is true; the validator itself never exits.
 *
 * All exceptions are swallowed so a bug in this validator never
 * crashes boot regardless of environment.
 *
 * @param {object} [deps]
 * @param {object} [deps.logger]  - pino-like logger (defaults to console)
 * @param {object} [deps.env]     - defaults to process.env (test injection)
 * @returns {{ checked: boolean, mismatch: boolean, issues: string[], shouldBlock: boolean }}
 */
function validateOAuthCallbackUrl(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const isProd = env.NODE_ENV === 'production';
  const collectedIssues = [];

  try {
    const hasClientId = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_ID.trim());
    const hasClientSecret = !!(env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CLIENT_SECRET.trim());
    const googleOAuthActive = hasClientId || hasClientSecret;

    // ── 1. Paired credential check ──────────────────────────────
    if (googleOAuthActive) {
      if (!hasClientId) {
        collectedIssues.push('missing_google_client_id');
        try {
          logger.warn(
            {
              hint:
                'GOOGLE_CLIENT_SECRET is set but GOOGLE_CLIENT_ID is missing. ' +
                'Google OAuth will fail at the authorization step.',
            },
            'oauth_config_missing_client_id',
          );
        } catch (_e) { /* swallow */ }
      }
      if (!hasClientSecret) {
        collectedIssues.push('missing_google_client_secret');
        try {
          logger.warn(
            {
              hint:
                'GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is missing. ' +
                'Google OAuth will fail at the token exchange step.',
            },
            'oauth_config_missing_client_secret',
          );
        } catch (_e) { /* swallow */ }
      }
    }

    // ── 2. GOOGLE_AUTH_BASE_URL well-formedness ─────────────────
    if (env.GOOGLE_AUTH_BASE_URL) {
      if (!isWellFormedUrl(env.GOOGLE_AUTH_BASE_URL)) {
        collectedIssues.push('malformed_google_auth_base_url');
        try {
          logger.warn(
            {
              GOOGLE_AUTH_BASE_URL: env.GOOGLE_AUTH_BASE_URL,
              hint:
                'GOOGLE_AUTH_BASE_URL is not a valid http/https URL. ' +
                'All resolved OAuth callback URLs will be incorrect and logins will fail.',
            },
            'oauth_config_malformed_base_url',
          );
        } catch (_e) { /* swallow */ }
      } else if (isProd && isLocalhostUrl(env.GOOGLE_AUTH_BASE_URL)) {
        collectedIssues.push('google_auth_base_url_localhost_in_production');
        try {
          logger.error(
            {
              GOOGLE_AUTH_BASE_URL: env.GOOGLE_AUTH_BASE_URL,
              hint:
                'GOOGLE_AUTH_BASE_URL points to localhost in production. ' +
                'All Google OAuth callback URLs will resolve to localhost and logins will fail. ' +
                'Set GOOGLE_AUTH_BASE_URL to your public production domain (e.g. https://siragpt.com).',
            },
            'oauth_config_base_url_localhost_in_production',
          );
        } catch (_e) { /* swallow */ }
      }
    }

    // ── 3. Resolved callback URL audits ─────────────────────────
    // Run if any Google OAuth env var is in play.
    if (googleOAuthActive || env.GOOGLE_AUTH_BASE_URL) {
      let googleCallbackUrl, gmailCallbackUrl, servicesCallbackUrl, resolvedBase;
      try {
        googleCallbackUrl = getGoogleCallbackURL(env);
        gmailCallbackUrl = getGoogleGmailCallbackURL(env);
        servicesCallbackUrl = getGoogleServicesCallbackURL(env);
        resolvedBase = resolvePublicBackendUrl(env);
      } catch (resolveErr) {
        try {
          logger.warn(
            { err: resolveErr && resolveErr.message },
            'oauth_callback_boot_validator_resolve_failed',
          );
        } catch (_e) { /* swallow */ }
        const shouldBlock = isProd && collectedIssues.some(c => BLOCKING_ISSUE_CODES.has(c));
        return { checked: false, mismatch: false, issues: collectedIssues, shouldBlock };
      }

      const urlsToAudit = [
        { url: googleCallbackUrl, label: 'Google OAuth callback URL' },
        { url: gmailCallbackUrl, label: 'Gmail OAuth callback URL' },
        { url: servicesCallbackUrl, label: 'Google-Services OAuth callback URL' },
      ];

      for (const { url, label } of urlsToAudit) {
        const findings = auditCallbackUrl(url, label, isProd);
        for (const finding of findings) {
          collectedIssues.push(finding.event);
          try {
            const logFn = finding.level === 'error' ? logger.error : logger.warn;
            logFn.call(logger, finding.data, finding.event);
          } catch (_e) { /* swallow */ }
        }
      }

      // ── 4. Host mismatch check (original behaviour) ───────────
      if (env.GOOGLE_AUTH_BASE_URL) {
        const expectedHost = parseHostname(env.GOOGLE_AUTH_BASE_URL);
        const resolvedHost = parseHostname(googleCallbackUrl);

        if (expectedHost && resolvedHost && expectedHost !== resolvedHost) {
          collectedIssues.push('host_mismatch');
          try {
            logger.warn(
              {
                expectedBaseUrl: env.GOOGLE_AUTH_BASE_URL,
                resolvedCallbackUrl: googleCallbackUrl,
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

          const shouldBlock = isProd && collectedIssues.some(c => BLOCKING_ISSUE_CODES.has(c));
          return { checked: true, mismatch: true, issues: collectedIssues, shouldBlock };
        }

        if (expectedHost && resolvedHost) {
          const shouldBlock = isProd && collectedIssues.some(c => BLOCKING_ISSUE_CODES.has(c));
          return { checked: true, mismatch: false, issues: collectedIssues, shouldBlock };
        }
      }
    }
  } catch (outerErr) {
    try {
      logger.warn(
        { err: outerErr && outerErr.message },
        'oauth_callback_boot_validator_unexpected_error',
      );
    } catch (_e) { /* swallow */ }
    return { checked: false, mismatch: false, issues: collectedIssues, shouldBlock: false };
  }

  const checked = !!(
    env.GOOGLE_CLIENT_ID ||
    env.GOOGLE_CLIENT_SECRET ||
    env.GOOGLE_AUTH_BASE_URL
  );
  const shouldBlock = isProd && collectedIssues.some(c => BLOCKING_ISSUE_CODES.has(c));
  return { checked, mismatch: false, issues: collectedIssues, shouldBlock };
}

module.exports = { validateOAuthCallbackUrl, BLOCKING_ISSUE_CODES };
