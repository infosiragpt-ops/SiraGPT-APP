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
