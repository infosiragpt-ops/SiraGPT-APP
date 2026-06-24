'use strict';

/**
 * GitHub integration config — single source of truth for OAuth credentials
 * and the URLs the flow depends on. Keeps raw `process.env` reads (and the
 * "are we even configured?" decision) out of the routes/services so the
 * OAuth code never half-runs with missing credentials.
 *
 * Env vars (see .env):
 *   GITHUB_CLIENT_ID            — OAuth App client id              (required)
 *   GITHUB_CLIENT_SECRET        — OAuth App client secret          (required)
 *   GITHUB_OAUTH_REDIRECT_URI   — must equal the OAuth App's callback URL.
 *                                 Defaults to <BACKEND_BASE_URL>/api/github/callback
 *   GITHUB_OAUTH_SCOPES         — space-separated scopes. Default: "repo read:user"
 *   GITHUB_OAUTH_SUCCESS_REDIRECT — frontend URL to return to after callback.
 *                                 Defaults to <FRONTEND_URL>/settings
 */

function clientId() {
  return process.env.GITHUB_CLIENT_ID || '';
}

function clientSecret() {
  return process.env.GITHUB_CLIENT_SECRET || '';
}

function backendBase() {
  const base =
    process.env.BACKEND_BASE_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 5000}`;
  return base.replace(/\/+$/, '');
}

function redirectUri() {
  if (process.env.GITHUB_OAUTH_REDIRECT_URI) {
    return process.env.GITHUB_OAUTH_REDIRECT_URI;
  }
  return `${backendBase()}/api/github/callback`;
}

function scopes() {
  return process.env.GITHUB_OAUTH_SCOPES || 'repo read:user';
}

function frontendBase() {
  const base =
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_URL ||
    'http://localhost:3000';
  return base.replace(/\/+$/, '');
}

/** Where to send the browser after the OAuth callback resolves. */
function postCallbackRedirect(status) {
  const base = process.env.GITHUB_OAUTH_SUCCESS_REDIRECT || `${frontendBase()}/settings`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}github=${encodeURIComponent(status)}`;
}

function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

/** Returns validated config or throws a clear, actionable error. */
function requireConfig() {
  if (!isConfigured()) {
    throw new Error(
      'GitHub OAuth is not configured — set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in the environment',
    );
  }
  return {
    clientId: clientId(),
    clientSecret: clientSecret(),
    redirectUri: redirectUri(),
    scopes: scopes(),
  };
}

module.exports = {
  clientId,
  clientSecret,
  redirectUri,
  scopes,
  frontendBase,
  postCallbackRedirect,
  isConfigured,
  require: requireConfig,
};
