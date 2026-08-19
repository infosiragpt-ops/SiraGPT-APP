'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  normalizePublicBackendBaseUrl,
  resolvePublicBackendUrl,
  getGoogleCallbackURL,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
  getGithubCallbackURL,
  getSpotifyCallbackURL,
  getGooglePostCallbackURL,
  getGithubPostCallbackURL,
  getSpotifyPostCallbackURL,
  getFrontendUrl,
} = require('../src/config/oauth-url-policy');
const {
  validateOAuthCallbackUrl,
} = require('../src/utils/oauth-callback-boot-validator');

test('normalizes backend API bases before building OAuth callbacks', () => {
  assert.equal(
    normalizePublicBackendBaseUrl('https://api.siragpt.com/api/'),
    'https://api.siragpt.com'
  );
  assert.equal(
    getGoogleCallbackURL({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'https://api.siragpt.com/api',
    }),
    'https://api.siragpt.com/api/auth/google/callback'
  );
});

test('production rejects frontend-domain Google callback when API host is separate', () => {
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://siragpt.com',
    GOOGLE_AUTH_URI: 'https://siragpt.com/api/auth/google/callback',
  };

  assert.equal(resolvePublicBackendUrl(env), 'https://api.siragpt.com');
  assert.equal(
    getGoogleCallbackURL(env),
    'https://api.siragpt.com/api/auth/google/callback'
  );
});

test('production honors explicit API-host callbacks for all Google flows', () => {
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://siragpt.com',
    GOOGLE_AUTH_BASE_URL: 'https://api.siragpt.com',
    GOOGLE_AUTH_URI: 'https://api.siragpt.com/api/auth/google/callback',
    GOOGLE_REDIRECT_URI: 'https://api.siragpt.com/api/auth/gmail/callback',
    GOOGLE_REDIRECT_CALENDAR_DRIVE_URI: 'https://api.siragpt.com/api/auth/google-services/callback',
  };

  assert.equal(getGoogleCallbackURL(env), 'https://api.siragpt.com/api/auth/google/callback');
  assert.equal(getGoogleGmailCallbackURL(env), 'https://api.siragpt.com/api/auth/gmail/callback');
  assert.equal(getGoogleServicesCallbackURL(env), 'https://api.siragpt.com/api/auth/google-services/callback');
});

test('production frontend URL ignores stale localhost process env', () => {
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'http://127.0.0.1',
    PUBLIC_FRONTEND_URL: 'https://siragpt.com',
    NEXT_PUBLIC_URL: 'https://siragpt.com',
  };

  assert.equal(getFrontendUrl(env), 'https://siragpt.com');
});

test('development keeps localhost callbacks for local OAuth testing', () => {
  const env = {
    NODE_ENV: 'development',
    GOOGLE_AUTH_URI: 'http://localhost:5000/api/auth/google/callback',
    GOOGLE_REDIRECT_URI: 'http://localhost:5000/api/auth/gmail/callback',
    GOOGLE_REDIRECT_CALENDAR_DRIVE_URI: 'http://localhost:5000/api/auth/google-services/callback',
    FRONTEND_URL: 'http://localhost:3000/',
  };

  assert.equal(getGoogleCallbackURL(env), 'http://localhost:5000/api/auth/google/callback');
  assert.equal(getGoogleGmailCallbackURL(env), 'http://localhost:5000/api/auth/gmail/callback');
  assert.equal(getGoogleServicesCallbackURL(env), 'http://localhost:5000/api/auth/google-services/callback');
  assert.equal(getFrontendUrl(env), 'http://localhost:3000');
});

test('all provider callback URLs are centralized on the public backend origin', () => {
  const env = {
    NODE_ENV: 'production',
    GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
    GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback',
    SPOTIFY_REDIRECT_URI: 'https://api.example.test/api/spotify/callback',
  };

  assert.equal(getGoogleCallbackURL(env), 'https://api.example.test/api/auth/google/callback');
  assert.equal(getGoogleGmailCallbackURL(env), 'https://api.example.test/api/auth/gmail/callback');
  assert.equal(
    getGoogleServicesCallbackURL(env),
    'https://api.example.test/api/auth/google-services/callback',
  );
  assert.equal(getGithubCallbackURL(env), 'https://api.example.test/api/github/callback');
  assert.equal(getSpotifyCallbackURL(env), 'https://api.example.test/api/spotify/callback');
});

test('production rejects HTTP and localhost callback/post-callback configuration', () => {
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'http://localhost:3000',
    PUBLIC_FRONTEND_URL: 'https://app.example.test',
    GOOGLE_AUTH_BASE_URL: 'http://localhost:5000',
    BACKEND_PUBLIC_URL: 'http://api.example.test',
    API_PUBLIC_URL: 'https://api.example.test',
    GITHUB_OAUTH_REDIRECT_URI: 'http://localhost:5000/api/github/callback',
    SPOTIFY_REDIRECT_URI: 'http://spotify.example.test/callback',
    GITHUB_OAUTH_SUCCESS_REDIRECT: 'http://localhost:3000/settings',
    SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'http://localhost:3000/chat',
  };

  for (const value of [
    getGoogleCallbackURL(env),
    getGithubCallbackURL(env),
    getSpotifyCallbackURL(env),
    getGooglePostCallbackURL('success', env),
    getGithubPostCallbackURL('connected', env),
    getSpotifyPostCallbackURL('connected', env),
  ]) {
    const parsed = new URL(value);
    assert.equal(parsed.protocol, 'https:');
    assert.notEqual(parsed.hostname, 'localhost');
  }
});

test('provider post-callback destinations are centralized and preserve status safely', () => {
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.example.test',
  };

  assert.equal(
    getGooglePostCallbackURL('success', env),
    'https://app.example.test/auth/callback?sso=success',
  );
  assert.equal(
    getGooglePostCallbackURL('invalid_state', env),
    'https://app.example.test/auth/login?error=invalid_state',
  );
  assert.equal(
    getGithubPostCallbackURL('already_linked', env),
    'https://app.example.test/settings?github=already_linked',
  );
  assert.equal(
    getSpotifyPostCallbackURL('connected', env),
    'https://app.example.test/chat?spotify_connected=true',
  );
  assert.equal(
    getSpotifyPostCallbackURL('invalid_state', env),
    'https://app.example.test/connections?spotify_connected=false&error=invalid_state',
  );
});

test('production U2 fixture degrades legacy localhost Spotify while valid Google stays available', () => {
  const logs = [];
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://siragpt.com',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GOOGLE_AUTH_BASE_URL: 'https://api.siragpt.com',
      GOOGLE_AUTH_URI: 'https://api.siragpt.com/api/auth/google/callback',
      GOOGLE_REDIRECT_URI: 'https://api.siragpt.com/api/auth/gmail/callback',
      GOOGLE_REDIRECT_CALENDAR_DRIVE_URI:
        'https://api.siragpt.com/api/auth/google-services/callback',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
      SPOTIFY_REDIRECT_URI: 'http://localhost:5000/api/spotify/callback',
      SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://siragpt.com/chat',
      SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://siragpt.com/connections',
    },
    logger: {
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.shouldBlock, false);
  assert.deepEqual(result.providers.google, {
    configured: true,
    enabled: true,
    status: 'healthy',
    blocking: false,
    reasons: [],
  });
  assert.deepEqual(result.providers.spotify, {
    configured: true,
    enabled: false,
    status: 'degraded',
    blocking: false,
    reasons: [
      'callback_localhost_in_production',
      'callback_https_required',
    ],
  });
  assert.doesNotMatch(JSON.stringify(result.providers), /localhost:5000|spotify-secret/);
  assert.ok(logs.length >= 1);
});

test('production still blocks an invalid configured Google/core provider', () => {
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GOOGLE_AUTH_BASE_URL: 'http://localhost:5000',
      GOOGLE_AUTH_URI: 'http://localhost:5000/api/auth/google/callback',
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.providers.google.configured, true);
  assert.equal(result.providers.google.enabled, false);
  assert.equal(result.providers.google.status, 'degraded');
  assert.equal(result.providers.google.blocking, true);
  assert.ok(result.providers.google.reasons.includes('base_url_localhost_in_production'));
});

test('configured optional providers require explicit callback and post-callback URLs', () => {
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.shouldBlock, false);
  assert.deepEqual(result.providers.github.reasons, [
    'callback_url_missing',
    'post_callback_url_missing',
  ]);
  assert.deepEqual(result.providers.spotify.reasons, [
    'callback_url_missing',
    'success_post_callback_url_missing',
    'failure_post_callback_url_missing',
  ]);
  assert.equal(result.providers.github.enabled, false);
  assert.equal(result.providers.spotify.enabled, false);
});

test('valid optional OAuth providers remain enabled', () => {
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://api.siragpt.com/api/github/callback',
      GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://siragpt.com/settings',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
      SPOTIFY_REDIRECT_URI: 'https://api.siragpt.com/api/spotify/callback',
      SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://siragpt.com/chat',
      SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://siragpt.com/connections',
      GOOGLE_AUTH_BASE_URL: 'https://api.siragpt.com',
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.providers.github.status, 'healthy');
  assert.equal(result.providers.github.enabled, true);
  assert.equal(result.providers.spotify.status, 'healthy');
  assert.equal(result.providers.spotify.enabled, true);
});

test('production fails closed when active Google provider validation throws', () => {
  const logs = [];
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GOOGLE_AUTH_BASE_URL: 'https://api.siragpt.com',
    },
    providerValidators: {
      google() {
        throw new Error('validator exploded at https://private.example.test?token=unsafe');
      },
    },
    logger: {
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
  });

  assert.equal(result.shouldBlock, true);
  assert.deepEqual(result.providers.google, {
    configured: true,
    enabled: false,
    status: 'degraded',
    blocking: true,
    reasons: ['validator_error'],
  });
  assert.ok(result.issues.includes('google_validator_error'));
  assert.doesNotMatch(JSON.stringify({ result, logs }), /private\.example|token=unsafe|exploded/);
});

test('optional provider validator exceptions degrade only that provider', () => {
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://siragpt.com',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      GOOGLE_AUTH_BASE_URL: 'https://api.siragpt.com',
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://api.siragpt.com/api/github/callback',
      GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://siragpt.com/settings',
      SPOTIFY_CLIENT_ID: 'spotify-id',
      SPOTIFY_CLIENT_SECRET: 'spotify-secret',
      SPOTIFY_REDIRECT_URI: 'https://api.siragpt.com/api/spotify/callback',
      SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://siragpt.com/chat',
      SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://siragpt.com/connections',
    },
    providerValidators: {
      spotify() {
        throw new Error('spotify validator leaked unsafe-secret');
      },
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.providers.google.status, 'healthy');
  assert.equal(result.providers.github.status, 'healthy');
  assert.deepEqual(result.providers.spotify, {
    configured: true,
    enabled: false,
    status: 'degraded',
    blocking: false,
    reasons: ['validator_error'],
  });
  assert.deepEqual(Object.keys(result.providers), ['google', 'github', 'spotify']);
  assert.doesNotMatch(JSON.stringify(result), /unsafe-secret/);
});

test('production rejects attacker-controlled OAuth post-callback origins', () => {
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.example.test',
    GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
    GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback',
    GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://attacker.example/settings',
    SPOTIFY_CLIENT_ID: 'spotify-id',
    SPOTIFY_CLIENT_SECRET: 'spotify-secret',
    SPOTIFY_REDIRECT_URI: 'https://api.example.test/api/spotify/callback',
    SPOTIFY_OAUTH_SUCCESS_REDIRECT: 'https://attacker.example/chat',
    SPOTIFY_OAUTH_FAILURE_REDIRECT: 'https://attacker.example/connections',
  };
  const result = validateOAuthCallbackUrl({
    env,
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.shouldBlock, false);
  assert.deepEqual(result.providers.github.reasons, [
    'post_callback_origin_not_allowed',
  ]);
  assert.deepEqual(result.providers.spotify.reasons, [
    'success_post_callback_origin_not_allowed',
    'failure_post_callback_origin_not_allowed',
  ]);
  assert.equal(result.providers.github.enabled, false);
  assert.equal(result.providers.spotify.enabled, false);
  assert.equal(
    getGithubPostCallbackURL('connected', env),
    'https://app.example.test/settings?github=connected',
  );
  assert.equal(
    getSpotifyPostCallbackURL('connected', env),
    'https://app.example.test/chat?spotify_connected=true',
  );
  assert.doesNotMatch(
    `${getGithubPostCallbackURL('connected', env)} ${getSpotifyPostCallbackURL('error', env)}`,
    /attacker\.example/,
  );
});

test('production allows an explicit bounded OAuth post-callback origin', () => {
  const env = {
    NODE_ENV: 'production',
    NEXT_PUBLIC_URL: 'https://app.example.test',
    GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
    OAUTH_POST_CALLBACK_ALLOWED_ORIGINS: 'https://trusted.example.test',
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
    GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback',
    GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://trusted.example.test/settings',
  };
  const result = validateOAuthCallbackUrl({
    env,
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.providers.github.enabled, true);
  assert.equal(result.providers.github.status, 'healthy');
  assert.equal(
    getGithubPostCallbackURL('connected', env),
    'https://trusted.example.test/settings?github=connected',
  );
});

test('OAuth post-callback origin allowlist is capped at ten entries', () => {
  const origins = Array.from(
    { length: 11 },
    (_value, index) => `https://allowed-${index + 1}.example.test`,
  );
  const result = validateOAuthCallbackUrl({
    env: {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://app.example.test',
      GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
      OAUTH_POST_CALLBACK_ALLOWED_ORIGINS: origins.join(','),
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback',
      GITHUB_OAUTH_SUCCESS_REDIRECT: `${origins[10]}/settings`,
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.providers.github.enabled, false);
  assert.deepEqual(result.providers.github.reasons, [
    'post_callback_origin_not_allowed',
  ]);
});

test('startup fatal output is generic and identifies blocking providers', () => {
  const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

  assert.match(indexSource, /blockingProviders/);
  assert.match(indexSource, /Required OAuth provider configuration is invalid/);
  assert.doesNotMatch(indexSource, /Google OAuth configuration is invalid/);
});

test('GOOGLE_AUTH_BASE_URL overrides stale per-flow URI secrets pointing to a different host', () => {
  // This is the real-world fix scenario: GOOGLE_AUTH_BASE_URL was set to
  // siragpt.com (single domain) but the GOOGLE_AUTH_URI secret was never
  // updated and still points to api.siragpt.com. GOOGLE_AUTH_BASE_URL must
  // win so republishing picks up the correct callback without requiring the
  // caller to also clear every per-flow URI secret manually.
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://siragpt.com',
    GOOGLE_AUTH_BASE_URL: 'https://siragpt.com',
    GOOGLE_AUTH_URI: 'https://api.siragpt.com/api/auth/google/callback',
    GOOGLE_REDIRECT_URI: 'https://api.siragpt.com/api/auth/gmail/callback',
    GOOGLE_REDIRECT_CALENDAR_DRIVE_URI: 'https://api.siragpt.com/api/auth/google-services/callback',
  };

  assert.equal(getGoogleCallbackURL(env), 'https://siragpt.com/api/auth/google/callback');
  assert.equal(getGoogleGmailCallbackURL(env), 'https://siragpt.com/api/auth/gmail/callback');
  assert.equal(getGoogleServicesCallbackURL(env), 'https://siragpt.com/api/auth/google-services/callback');
});

test('stale per-flow URI secrets are ignored without GOOGLE_AUTH_BASE_URL when host differs', () => {
  // GOOGLE_AUTH_BASE_URL is not set. The stale secrets still point to the
  // old api.siragpt.com subdomain. The cross-host detection must fire even
  // without GOOGLE_AUTH_BASE_URL so the production fallback (siragpt.com)
  // is used correctly.
  const env = {
    NODE_ENV: 'production',
    GOOGLE_AUTH_URI: 'https://api.siragpt.com/api/auth/google/callback',
    GOOGLE_REDIRECT_URI: 'https://api.siragpt.com/api/auth/gmail/callback',
    GOOGLE_REDIRECT_CALENDAR_DRIVE_URI: 'https://api.siragpt.com/api/auth/google-services/callback',
  };

  assert.equal(getGoogleCallbackURL(env), 'https://siragpt.com/api/auth/google/callback');
  assert.equal(getGoogleGmailCallbackURL(env), 'https://siragpt.com/api/auth/gmail/callback');
  assert.equal(getGoogleServicesCallbackURL(env), 'https://siragpt.com/api/auth/google-services/callback');
});

test('GOOGLE_AUTH_BASE_URL still allows consistent per-flow URI overrides on the same host', () => {
  // When GOOGLE_AUTH_BASE_URL and the explicit URI agree on the same host,
  // the explicit URI is accepted as-is (e.g. a custom path on the same domain).
  const env = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://siragpt.com',
    GOOGLE_AUTH_BASE_URL: 'https://siragpt.com',
    GOOGLE_AUTH_URI: 'https://siragpt.com/api/auth/google/callback',
  };

  assert.equal(getGoogleCallbackURL(env), 'https://siragpt.com/api/auth/google/callback');
});

test('production env snapshot: GOOGLE_AUTH_BASE_URL wins over stale GOOGLE_AUTH_URI on different host', () => {
  // Regression smoke test: mirrors the real production misconfiguration that
  // was caught only after users hit redirect errors. GOOGLE_AUTH_BASE_URL was
  // set to siragpt.com (single-domain deploy) but GOOGLE_AUTH_URI was never
  // updated and still pointed to api.siragpt.com. GOOGLE_AUTH_BASE_URL must
  // be the authoritative origin so the callback is always correct without
  // requiring every per-flow URI secret to also be cleared.
  const env = {
    NODE_ENV: 'production',
    GOOGLE_AUTH_BASE_URL: 'https://siragpt.com',
    GOOGLE_AUTH_URI: 'https://api.siragpt.com/api/auth/google/callback',
  };

  assert.equal(
    getGoogleCallbackURL(env),
    'https://siragpt.com/api/auth/google/callback'
  );
});

test('production env snapshot: GOOGLE_AUTH_BASE_URL wins over stale GOOGLE_redirect_URI for Gmail on different host', () => {
  // Minimal-env variant for the Gmail flow: only GOOGLE_AUTH_BASE_URL is set
  // (no FRONTEND_URL). GOOGLE_REDIRECT_URI still points to the old api.*
  // subdomain. GOOGLE_AUTH_BASE_URL must be authoritative so the Gmail OAuth
  // callback is built from the correct origin without requiring the stale
  // per-flow secret to be cleared first.
  const env = {
    NODE_ENV: 'production',
    GOOGLE_AUTH_BASE_URL: 'https://siragpt.com',
    GOOGLE_REDIRECT_URI: 'https://api.siragpt.com/api/auth/gmail/callback',
  };

  assert.equal(
    getGoogleGmailCallbackURL(env),
    'https://siragpt.com/api/auth/gmail/callback'
  );
});

test('production env snapshot: GOOGLE_AUTH_BASE_URL wins over stale GOOGLE_REDIRECT_CALENDAR_DRIVE_URI for Google Services on different host', () => {
  // Minimal-env variant for the Google Services (Calendar/Drive) flow: only
  // GOOGLE_AUTH_BASE_URL is set (no FRONTEND_URL). The stale
  // GOOGLE_REDIRECT_CALENDAR_DRIVE_URI still points to the old api.*
  // subdomain. GOOGLE_AUTH_BASE_URL must be authoritative so the callback is
  // built from the correct origin without requiring the stale per-flow secret
  // to be cleared first.
  const env = {
    NODE_ENV: 'production',
    GOOGLE_AUTH_BASE_URL: 'https://siragpt.com',
    GOOGLE_REDIRECT_CALENDAR_DRIVE_URI: 'https://api.siragpt.com/api/auth/google-services/callback',
  };

  assert.equal(
    getGoogleServicesCallbackURL(env),
    'https://siragpt.com/api/auth/google-services/callback'
  );
});

// backend/package.json enumerates test entrypoints explicitly. Keep the HTTP
// degradation regression in this registered OAuth entrypoint as well as in its
// independently runnable file.
require('./oauth-provider-route-degrade.test');
