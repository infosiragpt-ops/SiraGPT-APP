'use strict';

/**
 * Tests for the API-key path of the auth middleware (ratchet 45).
 *
 * Verifies that:
 *   - A valid `sk_` Bearer token populates req.user / req.organization
 *   - An invalid `sk_` token is rejected with 401 and never falls
 *     through to JWT verification
 *   - A non-`sk_` token does NOT short-circuit (the JWT path runs)
 *   - Expired keys are rejected
 *
 * Mocks Prisma + JWT so no DB / real secret is involved.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const dbPath = path.resolve(__dirname, '../src/config/database.js');
const authPath = path.resolve(__dirname, '../src/middleware/auth.js');

const apiKeysService = require('../src/services/api-keys-service');

const prismaState = {
  apiKey: null, // single row used by findFirst
  sessions: [],
};

const prismaMock = {
  apiKey: {
    findFirst: async ({ where }) => {
      if (!prismaState.apiKey) return null;
      if (where.prefix && prismaState.apiKey.prefix !== where.prefix) return null;
      return prismaState.apiKey;
    },
    update: async () => ({}),
  },
  session: {
    findUnique: async ({ where }) => prismaState.sessions.find((s) => s.token === where.token) || null,
    deleteMany: async () => ({ count: 0 }),
  },
  user: { update: async () => ({}) },
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };

process.env.JWT_SECRET = 'unused-in-api-key-tests-but-set-to-avoid-undefined-throw';

delete require.cache[authPath];
const {
  authenticateToken,
  __extractAccessToken,
  __parseAuthorizationHeader,
  __validateAccessTokenValue,
  MAX_ACCESS_TOKEN_LENGTH,
} = require(authPath);

function buildReqRes(token, { useCookie = false } = {}) {
  const req = {
    headers: useCookie ? {} : { authorization: `Bearer ${token}` },
    cookies: useCookie ? { token } : {},
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

function runMiddleware(req, res) {
  return new Promise((resolve, reject) => {
    Promise.resolve(authenticateToken(req, res, (err) => {
      if (err) return reject(err);
      resolve('next');
    })).catch(reject);
    // If next isn't called, the middleware resolves by sending a response.
    setImmediate(() => {
      if (res.body !== null) resolve('responded');
    });
  });
}

describe('authenticateToken · API key path', () => {
  beforeEach(() => {
    prismaState.apiKey = null;
    prismaState.sessions = [];
  });

  test('accepts a valid sk_ token and populates req.user + req.organization', async () => {
    const minted = apiKeysService.generateToken();
    const user = { id: 'u-1', email: 'pat@example.com' };
    const organization = { id: 'org-1', name: 'Acme' };
    prismaState.apiKey = {
      id: 'k-1',
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      organizationId: 'org-1',
      userId: 'u-1',
      scopes: ['read'],
      expiresAt: null,
      user,
      organization,
    };

    const { req, res } = buildReqRes(minted.token);
    let called = false;
    await new Promise((resolve, reject) => {
      authenticateToken(req, res, (err) => {
        if (err) return reject(err);
        called = true;
        resolve();
      }).catch(reject);
    });
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(req.user, user);
    assert.equal(req.authMethod, 'api_key');
    assert.equal(req.apiKey.id, 'k-1');
    assert.deepEqual(req.apiKey.scopes, ['read']);
    assert.equal(req.organization.id, 'org-1');
  });

  test('rejects unknown sk_ token with 401 and does not call next', async () => {
    const minted = apiKeysService.generateToken();
    // prismaState.apiKey stays null → no match
    const { req, res } = buildReqRes(minted.token);
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'invalid_api_key');
    assert.match(res.body.error, /Invalid API key/);
  });

  test('rejects malformed sk_ token as API key without JWT fallback', async () => {
    const { req, res } = buildReqRes('sk_short');
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'invalid_api_key');
    assert.match(res.body.error, /Invalid API key/);
  });

  test('rejects expired sk_ token with 401', async () => {
    const minted = apiKeysService.generateToken();
    prismaState.apiKey = {
      id: 'k-2',
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      organizationId: null,
      userId: 'u-1',
      scopes: [],
      expiresAt: new Date(Date.now() - 1000),
      user: { id: 'u-1' },
      organization: null,
    };
    const { req, res } = buildReqRes(minted.token);
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'api_key_expired');
    assert.match(res.body.error, /expired/);
  });

  test('rejects soft-deleted sk_ token with 401 (TrueDelete)', async () => {
    // Ratchet 45 (TrueDelete) — once `deletedAt` is stamped on a row the
    // middleware MUST refuse the credential, even if the hash still
    // matches. We surface the opaque "revoked" message so callers can't
    // distinguish a tombstoned key from a never-existed one.
    const minted = apiKeysService.generateToken();
    prismaState.apiKey = {
      id: 'k-tombstoned',
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      organizationId: null,
      userId: 'u-1',
      scopes: [],
      expiresAt: null,
      deletedAt: new Date(),
      user: { id: 'u-1' },
      organization: null,
    };
    const { req, res } = buildReqRes(minted.token);
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'api_key_revoked');
    assert.match(res.body.error, /revoked/);
  });

  test('rejects sk_ token with wrong secret (prefix collision)', async () => {
    const minted = apiKeysService.generateToken();
    // Plant a row with the same prefix but a different hash to simulate
    // a token whose plaintext body doesn't match the stored hash.
    prismaState.apiKey = {
      id: 'k-3',
      prefix: minted.prefix,
      tokenHash: 'definitely-not-the-matching-hash',
      organizationId: null,
      userId: 'u-1',
      scopes: [],
      expiresAt: null,
      user: { id: 'u-1' },
      organization: null,
    };
    const { req, res } = buildReqRes(minted.token);
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });

  test('non-sk_ token falls through to JWT path (which fails here)', async () => {
    // Token doesn't start with sk_; the API-key path returns false and
    // the JWT path runs. We don't have a valid session row, so it
    // produces 401 / 403 — the key assertion is just that the JWT
    // branch is what produces the error, not the api-key branch.
    const { req, res } = buildReqRes('not-an-sk-token');
    let called = false;
    await authenticateToken(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });

  test('rejects wrong-signature JWT as 401 without logging a server error', async () => {
    const badToken = jwt.sign({ userId: 'u-1' }, 'wrong-secret', {
      issuer: 'siragpt-api',
      audience: 'siragpt-clients',
    });
    const { req, res } = buildReqRes(badToken);
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
      let called = false;
      await authenticateToken(req, res, () => { called = true; });
      assert.equal(called, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'invalid_token');
      assert.equal(errors.length, 0);
    } finally {
      console.error = originalError;
    }
  });

  test('rejects malformed Authorization header before cookie fallback', async () => {
    const { req, res } = buildReqRes('cookie-token', { useCookie: true });
    req.headers.authorization = 'Bearer ';

    await authenticateToken(req, res, () => assert.fail('next should not be called'));

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'unsupported_authorization_scheme');
  });
});

describe('auth token extraction helpers', () => {
  test('__parseAuthorizationHeader accepts Bearer case-insensitively', () => {
    assert.deepEqual(__parseAuthorizationHeader('Bearer abc.def'), {
      present: true,
      token: 'abc.def',
    });
    assert.deepEqual(__parseAuthorizationHeader('bearer sk_test'), {
      present: true,
      token: 'sk_test',
    });
  });

  test('__parseAuthorizationHeader rejects non-Bearer, controls and oversize headers', () => {
    assert.equal(__parseAuthorizationHeader('Basic abc').error, 'unsupported_authorization_scheme');
    assert.equal(__parseAuthorizationHeader('Bearer abc\r\nx: y').error, 'invalid_authorization_header');
    assert.equal(
      __parseAuthorizationHeader(`Bearer ${'x'.repeat(MAX_ACCESS_TOKEN_LENGTH + 1)}`).error,
      'token_too_large',
    );
    assert.equal(__parseAuthorizationHeader('x'.repeat(MAX_ACCESS_TOKEN_LENGTH + 40)).error, 'authorization_header_too_large');
  });

  test('__validateAccessTokenValue rejects whitespace/control characters', () => {
    assert.equal(__validateAccessTokenValue('abc def').error, 'invalid_token_format');
    assert.equal(__validateAccessTokenValue('abc\n').error, 'invalid_token_format');
    assert.equal(__validateAccessTokenValue('x'.repeat(MAX_ACCESS_TOKEN_LENGTH + 1)).error, 'token_too_large');
  });

  test('__extractAccessToken prefers Authorization and treats malformed headers as terminal', () => {
    assert.deepEqual(__extractAccessToken({
      headers: { authorization: 'Bearer header-token' },
      cookies: { token: 'cookie-token' },
    }), {
      present: true,
      token: 'header-token',
    });
    assert.equal(__extractAccessToken({
      headers: { authorization: 'Basic abc' },
      cookies: { token: 'cookie-token' },
    }).error, 'unsupported_authorization_scheme');
    assert.deepEqual(__extractAccessToken({
      headers: {},
      cookies: { token: 'cookie-token' },
    }), {
      present: true,
      source: 'cookie',
      token: 'cookie-token',
    });
  });
});
