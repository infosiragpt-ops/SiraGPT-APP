'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderOAuthService } = require('../src/services/ProviderOAuthService');

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

function makeVault({ sealedOut = 'SEALED', openReturns } = {}) {
  return {
    sealProviderTokens: (b) => `${sealedOut}(${JSON.stringify(b)})`,
    openProviderTokens: () => openReturns,
  };
}

function makeProvider(overrides = {}) {
  const persistCalls = [];
  const clearCalls = [];
  const readCalls = [];
  return {
    persistCalls, clearCalls, readCalls,
    descriptor: {
      service: 'gmail',
      redirectUri: 'https://api.example.test/oauth/gmail/callback',
      oauth2Client: {
        generateAuthUrl: (opts) => `https://auth.example/?scope=${opts.scope.join(',')}&prompt=${opts.prompt || 'none'}&state=${opts.state}`,
        getToken: async (code) => ({
          tokens: {
            access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer',
            scope: 'a b c', expiry_date: 1234,
          },
        }),
      },
      scopes: ['a', 'b', 'c'],
      scopeFallback: 'fallback-scope',
      requiredScopes: ['a', 'b'],
      scopeMatch: 'every',
      persistTokens: async (uid, sealed) => { persistCalls.push({ uid, sealed }); },
      clearTokens: async (uid) => { clearCalls.push(uid); },
      readSealedTokens: async (uid) => { readCalls.push(uid); return 'BLOB'; },
      ...overrides,
    },
  };
}

function makeService(extra = {}) {
  const p = makeProvider(extra.providerOverrides);
  const vault = extra.vault || makeVault();
  const svc = new ProviderOAuthService({
    provider: p.descriptor,
    tokenVault: vault,
    signState: ({ userId, service }) => `STATE:${userId}:${service}`,
    verifyState: extra.verifyState || ((raw, { service }) => {
      const [tag, userId, svcName] = raw.split(':');
      if (tag !== 'STATE' || svcName !== service) throw new Error('bad state');
      return { userId };
    }),
    logger: silentLogger,
  });
  return { svc, ...p, vault };
}

test('ProviderOAuthService: constructor enforces descriptor + dep contracts', () => {
  assert.throws(() => new ProviderOAuthService({}), /provider descriptor is required/);
  const { descriptor } = makeProvider();
  assert.throws(
    () => new ProviderOAuthService({ provider: { ...descriptor, scopeMatch: 'bogus' }, tokenVault: makeVault(), signState: () => '', verifyState: () => ({}) }),
    /scopeMatch must be 'every' or 'some'/
  );
  assert.throws(
    () => new ProviderOAuthService({ provider: descriptor, tokenVault: {}, signState: () => '', verifyState: () => ({}) }),
    /tokenVault is required/
  );
});

test('buildAuthUrl: forces consent by default and signs state with service id', async () => {
  const { svc } = makeService();
  const url = await svc.buildAuthUrl('user-1');
  assert.match(url, /scope=a,b,c/);
  assert.match(url, /prompt=consent/);
  assert.match(url, /state=STATE%3Auser-1%3Agmail|state=STATE:user-1:gmail/);
});

test('buildAuthUrl: forceConsent=false drops the prompt flag', async () => {
  const { svc } = makeService();
  const url = await svc.buildAuthUrl('user-1', { forceConsent: false });
  assert.doesNotMatch(url, /prompt=consent/);
});

test('handleCallback: missing code/state → auth_failed without verify/exchange', async () => {
  const { svc } = makeService();
  const r1 = await svc.handleCallback({ code: '', state: 'x' });
  const r2 = await svc.handleCallback({ code: 'x', state: '' });
  assert.deepEqual(r1, { ok: false, service: 'gmail', error: 'auth_failed' });
  assert.deepEqual(r2, { ok: false, service: 'gmail', error: 'auth_failed' });
});

test('handleCallback: invalid state → invalid_state, never exchanges or persists', async () => {
  const { svc, persistCalls } = makeService({
    verifyState: () => { throw new Error('bad sig'); },
  });
  const r = await svc.handleCallback({ code: 'C', state: 'X' });
  assert.deepEqual(r, { ok: false, service: 'gmail', error: 'invalid_state' });
  assert.equal(persistCalls.length, 0);
});

test('handleCallback: distributed state-store outage remains an actionable 503', async () => {
  const { svc, persistCalls } = makeService({
    verifyState: () => {
      const error = new Error('OAUTH_STATE_STORE_UNAVAILABLE');
      error.code = 'OAUTH_STATE_STORE_UNAVAILABLE';
      throw error;
    },
  });

  const result = await svc.handleCallback({ code: 'C', state: 'X' });

  assert.deepEqual(result, {
    ok: false,
    service: 'gmail',
    error: 'oauth_state_store_unavailable',
    status: 503,
    retryable: true,
  });
  assert.equal(persistCalls.length, 0);
});

test('handleCallback: happy path seals tokens, persists by userId from state', async () => {
  const { svc, persistCalls } = makeService();
  const r = await svc.handleCallback({ code: 'C', state: 'STATE:user-7:gmail' });
  assert.deepEqual(r, { ok: true, service: 'gmail', userId: 'user-7' });
  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0].uid, 'user-7');
  assert.match(persistCalls[0].sealed, /"accessToken":"AT"/);
  assert.match(persistCalls[0].sealed, /"refreshToken":"RT"/);
  // Provider's response scope ('a b c') is used, not the fallback.
  assert.match(persistCalls[0].sealed, /"scope":"a b c"/);
});

test('handleCallback: uses scopeFallback when google omits scope', async () => {
  const { svc, persistCalls } = makeService({
    providerOverrides: {
      oauth2Client: {
        generateAuthUrl: () => '',
        getToken: async () => ({ tokens: { access_token: 'AT' } }),
      },
    },
  });
  const r = await svc.handleCallback({ code: 'C', state: 'STATE:u1:gmail' });
  assert.equal(r.ok, true);
  assert.match(persistCalls[0].sealed, /"scope":"fallback-scope"/);
});

test('handleCallback: exchange throws → auth_failed (no leak)', async () => {
  const { svc, persistCalls } = makeService({
    providerOverrides: {
      oauth2Client: {
        generateAuthUrl: () => '',
        getToken: async () => { throw new Error('google said no'); },
      },
    },
  });
  const r = await svc.handleCallback({ code: 'C', state: 'STATE:u1:gmail' });
  assert.deepEqual(r, { ok: false, service: 'gmail', error: 'auth_failed' });
  assert.equal(persistCalls.length, 0);
});

test('disconnect: delegates to provider.clearTokens', async () => {
  const { svc, clearCalls } = makeService();
  await svc.disconnect('user-1');
  assert.deepEqual(clearCalls, ['user-1']);
});

test('getStatus: missing/corrupt blob → all-false, no needsReauth churn', async () => {
  const { svc } = makeService({ vault: makeVault({ openReturns: null }) });
  const s = await svc.getStatus('u1');
  assert.deepEqual(s, { isConnected: false, hasRefreshToken: false, hasRequiredScopes: false, needsReauth: false });
});

test("getStatus: scopeMatch='every' requires ALL required scopes", async () => {
  const partial = makeService({
    vault: makeVault({ openReturns: { refreshToken: 'RT', scope: 'a only' } }),
  });
  const r1 = await partial.svc.getStatus('u1');
  assert.equal(r1.isConnected, true);
  assert.equal(r1.hasRefreshToken, true);
  assert.equal(r1.hasRequiredScopes, false);
  assert.equal(r1.needsReauth, true);

  const full = makeService({
    vault: makeVault({ openReturns: { refreshToken: 'RT', scope: 'a b extra' } }),
  });
  const r2 = await full.svc.getStatus('u1');
  assert.equal(r2.hasRequiredScopes, true);
  assert.equal(r2.needsReauth, false);
});

test("getStatus: scopeMatch='some' accepts ANY required scope present", async () => {
  const svcAny = makeService({
    providerOverrides: { scopeMatch: 'some', requiredScopes: ['x', 'y'] },
    vault: makeVault({ openReturns: { refreshToken: 'RT', scope: 'noise x' } }),
  });
  const r = await svcAny.svc.getStatus('u1');
  assert.equal(r.hasRequiredScopes, true);

  const svcNone = makeService({
    providerOverrides: { scopeMatch: 'some', requiredScopes: ['x', 'y'] },
    vault: makeVault({ openReturns: { refreshToken: 'RT', scope: 'noise' } }),
  });
  const r2 = await svcNone.svc.getStatus('u1');
  assert.equal(r2.hasRequiredScopes, false);
});

test('getStatus: present blob without refreshToken → needsReauth', async () => {
  const { svc } = makeService({
    vault: makeVault({ openReturns: { scope: 'a b' } }),
  });
  const s = await svc.getStatus('u1');
  assert.equal(s.isConnected, true);
  assert.equal(s.hasRefreshToken, false);
  assert.equal(s.hasRequiredScopes, true);
  assert.equal(s.needsReauth, true);
});
