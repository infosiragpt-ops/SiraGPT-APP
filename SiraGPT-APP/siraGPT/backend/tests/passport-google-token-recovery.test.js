'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const passportConfigPath = path.resolve(__dirname, '../src/config/passport.js');
const databasePath = path.resolve(__dirname, '../src/config/database.js');
const encryptionPath = path.resolve(__dirname, '../src/utils/encryption.js');
const oauthPolicyPath = path.resolve(__dirname, '../src/config/oauth-url-policy.js');

function installCacheMock(resolvedPath, exports) {
  const original = require.cache[resolvedPath];
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
  return () => {
    if (original) {
      require.cache[resolvedPath] = original;
    } else {
      delete require.cache[resolvedPath];
    }
  };
}

function applySelectedFields(record, select) {
  if (!select) return { ...record };
  const selected = {};
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) selected[key] = record[key];
  }
  return selected;
}

describe('passport Google OAuth token recovery', () => {
  const restores = [];
  const originalEnv = { ...process.env };
  let capturedGoogleVerify;
  let updateCalls;

  beforeEach(() => {
    for (const modulePath of [passportConfigPath, databasePath, encryptionPath, oauthPolicyPath]) {
      delete require.cache[modulePath];
    }
    capturedGoogleVerify = null;
    updateCalls = [];

    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.FRONTEND_URL = 'https://siragpt.test';
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

    const passportPath = require.resolve('passport');
    const googleStrategyPath = require.resolve('passport-google-oauth20');
    const jwtStrategyPath = require.resolve('passport-jwt');

    restores.push(installCacheMock(passportPath, {
      use(strategy) {
        return strategy;
      },
      serializeUser() {},
      deserializeUser() {},
    }));

    class GoogleStrategyMock {
      constructor(_options, verify) {
        capturedGoogleVerify = verify;
      }
    }

    class JwtStrategyMock {
      constructor(_options, verify) {
        this.verify = verify;
      }
    }

    restores.push(installCacheMock(googleStrategyPath, { Strategy: GoogleStrategyMock }));
    restores.push(installCacheMock(jwtStrategyPath, {
      Strategy: JwtStrategyMock,
      ExtractJwt: { fromAuthHeaderAsBearerToken: () => 'jwt-extractor' },
    }));

    const existingUser = {
      id: 'user-existing-1',
      email: 'oauth@example.com',
      gmailTokens: 'corrupt-ciphertext',
    };

    restores.push(installCacheMock(databasePath, {
      user: {
        async findUnique(args) {
          assert.equal(args.where.email, existingUser.email);
          return applySelectedFields(existingUser, args.select);
        },
        async update(args) {
          updateCalls.push(args);
          assert.equal(args.where.id, existingUser.id);
          return { ...existingUser, ...args.data };
        },
        async create() {
          assert.fail('corrupted existing token recovery must not create a replacement user');
        },
      },
    }));

    restores.push(installCacheMock(encryptionPath, {
      decrypt() {
        throw new Error('ciphertext authentication failed');
      },
      encrypt(value) {
        return `encrypted:${value}`;
      },
    }));
  });

  afterEach(() => {
    while (restores.length) restores.pop()();
    for (const modulePath of [passportConfigPath, databasePath, encryptionPath, oauthPolicyPath]) {
      delete require.cache[modulePath];
    }
    process.env = { ...originalEnv };
  });

  it('selects the existing user id before clearing corrupted stored Gmail tokens', async () => {
    require(passportConfigPath);
    assert.equal(typeof capturedGoogleVerify, 'function');

    let doneError;
    let doneUser;
    await capturedGoogleVerify(
      'new-access-token',
      '',
      {
        id: 'google-user-1',
        displayName: 'OAuth User',
        emails: [{ value: 'oauth@example.com' }],
        photos: [],
        _json: { scope: 'openid email profile' },
      },
      (error, user) => {
        doneError = error;
        doneUser = user;
      }
    );

    assert.equal(doneError, null);
    assert.ok(doneUser);
    assert.equal(updateCalls.length, 2);
    assert.equal(updateCalls[0].where.id, 'user-existing-1');
    assert.equal(updateCalls[0].data.gmailTokens, null);
  });
});
