'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizePublicBackendBaseUrl,
  resolvePublicBackendUrl,
  getGoogleCallbackURL,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
  getFrontendUrl,
} = require('../src/config/oauth-url-policy');

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
