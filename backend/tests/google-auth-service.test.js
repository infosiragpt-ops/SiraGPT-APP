'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleAuthService } = require('../src/services/GoogleAuthService');

const silentLogger = { warn: () => {}, log: () => {}, error: () => {} };

function makeUsers(initial = {}) {
  const state = { ...initial };
  const calls = [];
  return {
    state,
    calls,
    findByEmail: async (email, opts) => { calls.push(['findByEmail', email, opts]); return state.byEmail?.[email] ?? null; },
    findById: async (id) => { calls.push(['findById', id]); return state.byId?.[id] ?? null; },
    updateGoogleIdentity: async (id, data) => { calls.push(['updateGoogleIdentity', id, data]); return { id, ...data }; },
    clearGmailTokens: async (id) => { calls.push(['clearGmailTokens', id]); return { id, gmailTokens: null }; },
    createOAuthUser: async (data) => { calls.push(['createOAuthUser', data]); return { id: 'new-user', ...data }; },
  };
}

function makeTokens(decryptResult = null, { corrupt = false } = {}) {
  const calls = [];
  return {
    calls,
    sealProviderTokens: (b) => { calls.push(['seal', b]); return `SEALED:${b.scope}:${b.refreshToken}`; },
    openProviderTokens: (blob) => { calls.push(['open', blob]); return decryptResult; },
    extractRefreshToken: (blob) => { calls.push(['extract', blob]); return decryptResult?.refreshToken ?? null; },
    inspectProviderTokens: (blob) => {
      calls.push(['inspect', blob]);
      if (!blob) return { status: 'empty', value: null };
      if (corrupt) return { status: 'corrupt', value: null };
      return { status: 'ok', value: decryptResult };
    },
  };
}

const fakeBcrypt = { hash: async () => 'HASHED' };
const fixedPassword = () => 'fixed-pw';

const profile = {
  id: 'g123',
  displayName: 'Sira',
  emails: [{ value: 'sira@x.com' }],
  photos: [{ value: 'http://img' }],
};

test('GoogleAuthService: constructor validates deps', () => {
  assert.throws(
    () => new GoogleAuthService({ tokens: makeTokens(), bcrypt: fakeBcrypt }),
    /users repository is required/
  );
  assert.throws(
    () => new GoogleAuthService({ users: makeUsers(), bcrypt: fakeBcrypt }),
    /tokens vault is required/
  );
  assert.throws(
    () => new GoogleAuthService({ users: makeUsers(), tokens: makeTokens(), bcrypt: {} }),
    /bcrypt with hash\(\) is required/
  );
});

test('handleVerify: throws NO_EMAIL when profile has no email', async () => {
  const svc = new GoogleAuthService({
    users: makeUsers(), tokens: makeTokens(), bcrypt: fakeBcrypt, logger: silentLogger,
  });
  await assert.rejects(
    () => svc.handleVerify({ accessToken: 'at', refreshToken: 'rt', profile: { id: 'g1' } }),
    (e) => e.code === 'NO_EMAIL'
  );
});

test('handleVerify: creates user on first login', async () => {
  const users = makeUsers();
  const tokens = makeTokens();
  const svc = new GoogleAuthService({
    users, tokens, bcrypt: fakeBcrypt,
    generateRandomPassword: fixedPassword, logger: silentLogger,
  });
  const out = await svc.handleVerify({ accessToken: 'at', refreshToken: 'rt', profile });
  assert.equal(out.ok, true);
  assert.equal(out.user.id, 'new-user');
  assert.equal(out.user.email, 'sira@x.com');
  assert.equal(out.user.passwordHash, 'HASHED');
  // Tokens were sealed twice (gmail + google services), both with rt.
  const seals = tokens.calls.filter((c) => c[0] === 'seal');
  assert.equal(seals.length, 2);
  assert.equal(seals[0][1].refreshToken, 'rt');
});

test('handleVerify: updates existing user without re-creating', async () => {
  const existing = { id: 'u1', email: 'sira@x.com' };
  const users = makeUsers({ byEmail: { 'sira@x.com': existing } });
  const tokens = makeTokens();
  const svc = new GoogleAuthService({
    users, tokens, bcrypt: fakeBcrypt, logger: silentLogger,
  });
  const out = await svc.handleVerify({ accessToken: 'at', refreshToken: 'rt', profile });
  assert.equal(out.ok, true);
  assert.equal(out.user.id, 'u1');
  // Should NOT have created a new user.
  assert.ok(!users.calls.find((c) => c[0] === 'createOAuthUser'));
  // Should have called updateGoogleIdentity with the new tokens.
  const upd = users.calls.find((c) => c[0] === 'updateGoogleIdentity');
  assert.ok(upd);
  assert.equal(upd[1], 'u1');
  assert.equal(upd[2].googleId, 'g123');
});

test('handleVerify: rejects a soft-deleted provider account before updating identity data', async () => {
  const existing = {
    id: 'deleted-oauth-user',
    email: 'sira@x.com',
    deletedAt: new Date('2026-07-01T00:00:00Z'),
  };
  const users = makeUsers({ byEmail: { 'sira@x.com': existing } });
  const svc = new GoogleAuthService({
    users,
    tokens: makeTokens(),
    bcrypt: fakeBcrypt,
    logger: silentLogger,
  });

  await assert.rejects(
    svc.handleVerify({ accessToken: 'at', refreshToken: 'rt', profile }),
    { code: 'ACCOUNT_INACTIVE' },
  );
  assert.equal(
    users.calls.some(([name]) => (
      name === 'updateGoogleIdentity' || name === 'createOAuthUser'
    )),
    false,
  );
});

test('handleVerify: recovers refresh token from stored blob when Google omits it', async () => {
  const existing = { id: 'u1', gmailTokens: 'BLOB' };
  const users = makeUsers({ byEmail: { 'sira@x.com': existing } });
  const tokens = makeTokens({ refreshToken: 'recovered-rt' });
  const svc = new GoogleAuthService({
    users, tokens, bcrypt: fakeBcrypt, logger: silentLogger,
  });
  const out = await svc.handleVerify({ accessToken: 'at', refreshToken: null, profile });
  assert.equal(out.ok, true);
  // The seal call should reflect the recovered token, not null.
  const firstSeal = tokens.calls.find((c) => c[0] === 'seal');
  assert.equal(firstSeal[1].refreshToken, 'recovered-rt');
});

test('handleVerify: clears corrupted tokens when recovery fails to decrypt', async () => {
  const existing = { id: 'u1', gmailTokens: 'CORRUPT' };
  const users = makeUsers({ byEmail: { 'sira@x.com': existing } });
  const tokens = makeTokens(null, { corrupt: true }); // inspect → corrupt
  const svc = new GoogleAuthService({
    users, tokens, bcrypt: fakeBcrypt, logger: silentLogger,
  });
  await svc.handleVerify({ accessToken: 'at', refreshToken: null, profile });
  assert.ok(users.calls.find((c) => c[0] === 'clearGmailTokens' && c[1] === 'u1'));
});

test('handleVerify: does NOT clear tokens when blob decrypts cleanly but has no refresh token (regression guard)', async () => {
  // Pre-refactor parity: a valid-but-refreshTokenless blob must not
  // trigger clearGmailTokens. Earlier iteration of this refactor
  // cleared in that case, which architect flagged.
  const existing = { id: 'u1', gmailTokens: 'VALID_BLOB' };
  const users = makeUsers({ byEmail: { 'sira@x.com': existing } });
  const tokens = makeTokens({ accessToken: 'old-at', refreshToken: null });
  const svc = new GoogleAuthService({
    users, tokens, bcrypt: fakeBcrypt, logger: silentLogger,
  });
  await svc.handleVerify({ accessToken: 'at', refreshToken: null, profile });
  assert.equal(
    users.calls.find((c) => c[0] === 'clearGmailTokens'),
    undefined,
    'clearGmailTokens must NOT be called when blob is valid'
  );
});

test('handleVerify: when no existing user AND no refresh token, proceeds with null rt', async () => {
  const users = makeUsers();
  const tokens = makeTokens();
  const svc = new GoogleAuthService({
    users, tokens, bcrypt: fakeBcrypt,
    generateRandomPassword: fixedPassword, logger: silentLogger,
  });
  const out = await svc.handleVerify({ accessToken: 'at', refreshToken: null, profile });
  assert.equal(out.ok, true);
  const firstSeal = tokens.calls.find((c) => c[0] === 'seal');
  assert.equal(firstSeal[1].refreshToken, null);
});

test('recoverRefreshTokenForEmail: returns null when no stored tokens', async () => {
  const users = makeUsers();
  const svc = new GoogleAuthService({
    users, tokens: makeTokens(), bcrypt: fakeBcrypt, logger: silentLogger,
  });
  const rt = await svc.recoverRefreshTokenForEmail('nobody@x.com');
  assert.equal(rt, null);
});
