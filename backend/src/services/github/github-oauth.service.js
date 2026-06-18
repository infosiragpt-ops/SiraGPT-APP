'use strict';

/**
 * GitHub OAuth service — server-side authorization-code flow.
 *
 * Mirrors the project's existing provider-integration shape (Gmail/Google/
 * Spotify): tokens are sealed with the shared AES-256 TokenVault before they
 * ever touch the database, and the OAuth `state` is a short-lived signed JWT
 * so the /callback hit (which arrives without a session cookie) can still be
 * bound to the user who started the flow — no server-side state store needed.
 *
 * SRP: this module only talks to GitHub's OAuth + identity endpoints and
 * seals/opens the token blob. Persistence lives in GithubAccountRepository;
 * HTTP wiring lives in routes/github.js.
 */

const jwt = require('jsonwebtoken');
const { TokenVault } = require('../TokenVault');
const { encrypt, decrypt } = require('../../utils/encryption');
const githubConfig = require('../../config/github');

const vault = new TokenVault({ encrypt, decrypt });

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

const STATE_TTL_SECONDS = 600; // 10 min — enough to complete the consent screen
// Classic OAuth tokens (scope `repo`) do not expire; represent that with a
// far-future expiry so TokenVault's default (+1h) never marks them stale.
const NON_EXPIRING_MS = 10 * 365 * 24 * 3600 * 1000;

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  throw new Error('global fetch is unavailable — Node >= 18 is required for GitHub OAuth');
}

/** Sign a short-lived state token that binds the callback to this user. */
function signState(userId) {
  return jwt.sign({ uid: userId, kind: 'github_oauth' }, process.env.JWT_SECRET, {
    expiresIn: STATE_TTL_SECONDS,
  });
}

/** Verify + decode the state token. Returns the userId, or null if invalid/expired. */
function verifyState(state) {
  try {
    const decoded = jwt.verify(String(state || ''), process.env.JWT_SECRET);
    if (!decoded || decoded.kind !== 'github_oauth' || !decoded.uid) return null;
    return String(decoded.uid);
  } catch {
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
  _internal: { GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL, STATE_TTL_SECONDS },
};
