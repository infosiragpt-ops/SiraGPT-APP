'use strict';

/**
 * GitHub OAuth service — server-side authorization-code flow.
 *
 * Mirrors the project's existing provider-integration shape (Gmail/Google/
 * Spotify): tokens are sealed with the shared AES-256 TokenVault before they
 * ever touch the database, and OAuth `state` is signed plus consumed through
 * the shared bounded Redis-backed one-time store.
 *
 * SRP: this module only talks to GitHub's OAuth + identity endpoints and
 * seals/opens the token blob. Persistence lives in GithubAccountRepository;
 * HTTP wiring lives in routes/github.js.
 */

const { TokenVault } = require('../TokenVault');
const { encrypt, decrypt } = require('../../utils/encryption');
const githubConfig = require('../../config/github');
const {
  signOAuthState,
  verifyOAuthState,
} = require('../oauth-state');

const vault = new TokenVault({ encrypt, decrypt });

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

// Classic OAuth tokens (scope `repo`) do not expire; represent that with a
// far-future expiry so TokenVault's default (+1h) never marks them stale.
const NON_EXPIRING_MS = 10 * 365 * 24 * 3600 * 1000;

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  throw new Error('global fetch is unavailable — Node >= 18 is required for GitHub OAuth');
}

/** Sign and register a short-lived state token that binds this user + callback. */
async function signState(userId) {
  const cfg = githubConfig.require();
  return signOAuthState({
    userId,
    service: 'github',
    redirectUri: cfg.redirectUri,
  });
}

/** Atomically consume state. Returns the userId, or null if invalid/expired. */
async function verifyState(state) {
  try {
    const cfg = githubConfig.require();
    const decoded = await verifyOAuthState(state, {
      service: 'github',
      redirectUri: cfg.redirectUri,
    });
    return decoded.userId;
  } catch (error) {
    if (error?.code === 'OAUTH_STATE_STORE_UNAVAILABLE') throw error;
    return null;
  }
}

/** Build the GitHub consent URL for a given signed state. */
function buildAuthorizeUrl(state) {
  const cfg = githubConfig.require();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    allow_signup: 'false',
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange the authorization code for an access token bundle. */
async function exchangeCodeForToken(code) {
  const cfg = githubConfig.require();
  const res = await getFetch()(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (data.error || !data.access_token) {
    throw new Error(
      `GitHub token exchange rejected: ${data.error_description || data.error || 'no access_token returned'}`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null, // present only for GitHub Apps w/ expiring tokens
    tokenType: data.token_type || 'bearer',
    scope: data.scope || cfg.scopes,
    expiresIn: data.expires_in || null, // seconds, only for expiring tokens
  };
}

/** Fetch the authenticated GitHub user's profile. */
async function fetchGithubUser(accessToken) {
  const res = await getFetch()(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'siraGPT-git-integration',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub user lookup failed (HTTP ${res.status})`);
  }
  return res.json();
}

/** Seal a token bundle for at-rest storage. Returns ciphertext. */
function sealTokens(tokens) {
  return vault.sealProviderTokens({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : Date.now() + NON_EXPIRING_MS,
  });
}

/** Open a stored token blob → { accessToken, refreshToken, scope, expiresAt } or null. */
function openTokens(blob) {
  return vault.openProviderTokens(blob);
}

module.exports = {
  signState,
  verifyState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubUser,
  sealTokens,
  openTokens,
  // exported for tests
  _internal: { GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL },
};
