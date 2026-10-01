'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// Exercise the real one-use state codec, encrypted vault and Express routes.
// Only the identity provider and database are fixtures; no personal account.
const envKeys = ['NODE_ENV', 'JWT_SECRET', 'ENCRYPTION_KEY', 'REDIS_URL', 'FRONTEND_URL', 'PUBLIC_FRONTEND_URL', 'GOOGLE_AUTH_BASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_OAUTH_REDIRECT_URI', 'GITHUB_OAUTH_SUCCESS_REDIRECT'];
const envBefore = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
Object.assign(process.env, {
  NODE_ENV: 'test', JWT_SECRET: 'github-chat-state-test-signing-key', ENCRYPTION_KEY: 'a'.repeat(64), REDIS_URL: '',
  FRONTEND_URL: 'https://app.example.test', PUBLIC_FRONTEND_URL: 'https://app.example.test', GOOGLE_AUTH_BASE_URL: 'https://api.example.test',
  GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret',
  GITHUB_OAUTH_REDIRECT_URI: 'https://api.example.test/api/github/callback', GITHUB_OAUTH_SUCCESS_REDIRECT: 'https://app.example.test/settings',
});
const { mockResolvedModule } = require('./http-test-utils');
let userId = 'u1';
const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, res, next) { if (!userId) return res.status(401).json({ code: 'auth_required' }); req.user = { id: userId }; return next(); },
});
const restoreApps = mockResolvedModule(require.resolve('../src/services/apps'), {
  async upsertFromOAuth() {}, async auditAppEvent() {},
});
const prisma = require('../src/config/database');
const accounts = require('../src/repositories/GithubAccountRepository');
const oauth = require('../src/services/github/github-oauth.service');
const stateService = require('../src/services/oauth-state');
const chatOAuth = require('../src/services/github/github-chat-oauth');
const originals = { chat: prisma.chat.findFirst, ...Object.fromEntries(['findByUserId', 'findByGithubUserId', 'upsertForUser'].map((key) => [key, accounts[key]])), exchange: oauth.exchangeCodeForToken, fetchUser: oauth.fetchGithubUser };
const app = express();
app.use('/api/github', require('../src/routes/github'));
let rows;
let chats;
let fetchError;
let githubUser;
let exchangeCalls;
let fetchCalls;
const fixtureAccessToken = 'fixture-access-value';

beforeEach(async () => {
  await chatOAuth.closeReceiptStore();
  stateService._testOnly_clearUsedJtis();
  userId = 'u1'; rows = new Map(); chats = new Map([['chat-1', 'u1'], ['chat-2', 'u2']]);
  fetchError = null; githubUser = { id: 42, login: 'fixture-user', name: 'Fixture User', avatar_url: null }; exchangeCalls = 0; fetchCalls = 0;
  prisma.chat.findFirst = async ({ where }) => chats.get(where.id) === where.userId ? { id: where.id } : null;
  accounts.findByUserId = async (id) => rows.get(id) || null;
  accounts.findByGithubUserId = async (id) => [...rows.values()].find((row) => row.githubUserId === id) || null;
  accounts.upsertForUser = async (id, data) => { const row = { id: `account-${id}`, userId: id, connectedAt: new Date('2026-01-01'), updatedAt: new Date(), ...data }; rows.set(id, row); return row; };
  oauth.exchangeCodeForToken = async () => { exchangeCalls += 1; return { accessToken: fixtureAccessToken, scope: 'repo read:user', tokenType: 'bearer' }; };
  oauth.fetchGithubUser = async (token, options) => { fetchCalls += 1; assert.equal(token, fixtureAccessToken); if (options) assert.ok(options.signal); if (fetchError) throw fetchError; return githubUser; };
});

after(async () => {
  prisma.chat.findFirst = originals.chat;
  for (const key of ['findByUserId', 'findByGithubUserId', 'upsertForUser']) accounts[key] = originals[key];
  oauth.exchangeCodeForToken = originals.exchange; oauth.fetchGithubUser = originals.fetchUser;
  restoreAuth(); restoreApps();
  await stateService.closeOAuthStateStore();
  await chatOAuth.closeReceiptStore();
  for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

async function connect(chatId = 'chat-1') {
  const handoffId = crypto.randomUUID();
  const res = await request(app).get('/api/github/connect').query({ chatId, handoffId, popup: '1' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const url = new URL(res.body.url);
  return { res, url, state: url.searchParams.get('state'), handoffId };
}
function callback(state, extra = {}) { return request(app).get('/api/github/callback').query({ code: 'fixture-code', state, ...extra }); }
function callbackMessage(res) {
  let payload; let targetOrigin; let closed = false;
  const script = res.text.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(script, res.text);
  assert.ok(res.headers['content-security-policy'].includes(`'nonce-${script[1]}'`));
  assert.ok(!res.headers['content-security-policy'].includes('unsafe-inline'));
  vm.runInNewContext(script[2], { window: { opener: { postMessage(value, origin) { payload = JSON.parse(JSON.stringify(value)); targetOrigin = origin; } }, close() { closed = true; } } });
  assert.equal(targetOrigin, 'https://app.example.test');
  assert.equal(closed, true);
  return payload;
}
async function addAccount(id = 'u1', overrides = {}) {
  return accounts.upsertForUser(id, { githubUserId: '42', login: 'fixture-user', encryptedTokens: oauth.sealTokens({ accessToken: fixtureAccessToken, scope: 'repo' }), ...overrides });
}

test('chat handoff uses a real GitHub URL and private one-use context, with owned chat isolation', async () => {
  const flow = await connect();
  assert.equal(flow.url.origin, 'https://github.com');
  assert.equal(flow.url.pathname, '/login/oauth/authorize');
  assert.equal(flow.url.searchParams.get('redirect_uri'), 'https://api.example.test/api/github/callback');
  assert.equal(flow.res.body.chatId, 'chat-1'); assert.equal(flow.res.body.handoffId, flow.handoffId);
  assert.equal(flow.res.headers['cache-control'], 'no-store');
  const claims = jwt.decode(flow.state);
  assert.equal(claims.userId, 'u1'); assert.equal(claims.context, undefined); assert.ok(!JSON.stringify(claims).includes(flow.handoffId));
  const denied = await request(app).get('/api/github/connect').query({ chatId: 'chat-2', handoffId: crypto.randomUUID(), popup: '1' });
  assert.equal(denied.status, 404); assert.equal(denied.body.url, undefined);
});

test('invalid/partial handoff, traversal and anonymous requests never start OAuth', async () => {
  for (const query of [{ chatId: 'chat-1' }, { chatId: 'chat-1', handoffId: 'bad', popup: '1' }, { chatId: '../chat-1', handoffId: crypto.randomUUID(), popup: '1' }, { handoffId: crypto.randomUUID(), popup: '1' }]) {
    const res = await request(app).get('/api/github/connect').query(query);
    assert.equal(res.status, 400); assert.equal(res.body.url, undefined);
  }
  userId = null;
  assert.equal((await request(app).get('/api/github/connect')).status, 401);
});

test('callback seals credentials, reports only correlated public result, and reuses authorization across requests', async () => {
  const flow = await connect();
  const res = await callback(flow.state);
  assert.equal(res.status, 200); assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(callbackMessage(res), { type: 'github_oauth_result', service: 'github', status: 'success', chatId: 'chat-1', handoffId: flow.handoffId });
  assert.ok(res.text.includes('https://app.example.test/agentes?id=chat-1'));
  for (const secret of [fixtureAccessToken, flow.state, 'fixture-code', 'fixture-client-secret']) assert.ok(!res.text.includes(secret));
  const saved = rows.get('u1');
  assert.ok(saved.encryptedTokens && !saved.encryptedTokens.includes(fixtureAccessToken));
  assert.equal(oauth.openTokens(saved.encryptedTokens).accessToken, fixtureAccessToken);
  const status = await request(app).get('/api/github/status?verify=1');
  assert.equal(status.body.connected, true); assert.equal(status.body.verified, true);
  assert.equal(status.body.login, 'fixture-user'); assert.ok(status.body.connectionVersion);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(status.body).includes(fixtureAccessToken));
  userId = 'u2';
  assert.deepEqual((await request(app).get('/api/github/status?verify=1')).body.connected, false);
});

test('a consumed or tampered state cannot persist an account or emit a success message', async () => {
  const flow = await connect();
  assert.equal((await callback(flow.state)).status, 200);
  const replay = await callback(flow.state);
  assert.equal(replay.status, 302); assert.match(replay.headers.location, /github=expired/);
  const tamper = await callback(`${flow.state.slice(0, -8)}tampered`);
  assert.equal(tamper.status, 302); assert.equal(exchangeCalls, 1);
});

test('denial consumes state, preserves handoff context, and never exchanges credentials', async () => {
  const flow = await connect();
  const res = await callback(flow.state, { error: 'access_denied', code: '' });
  assert.deepEqual(callbackMessage(res), { type: 'github_oauth_result', service: 'github', status: 'error', error: 'denied', chatId: 'chat-1', handoffId: flow.handoffId });
  assert.equal(exchangeCalls, 0); assert.equal(rows.size, 0);
  assert.equal((await callback(flow.state)).status, 302);
});

test('untrusted callback flags cannot redirect or invent a handoff', async () => {
  const flow = await connect();
  const res = await callback(flow.state, { chatId: 'chat-2', handoffId: crypto.randomUUID(), returnUrl: 'https://attacker.example', popup: '0' });
  assert.equal(callbackMessage(res).chatId, 'chat-1'); assert.equal(callbackMessage(res).handoffId, flow.handoffId);
  assert.ok(!res.text.includes('attacker.example'));
  const invalid = await request(app).get('/api/github/callback?error=access_denied&chatId=chat-1&popup=1');
  assert.equal(invalid.status, 302); assert.match(invalid.headers.location, /github=invalid/);
});

test('callback rejects a deleted chat and a GitHub identity linked to another user', async () => {
  const deleted = await connect(); chats.delete('chat-1');
  assert.equal(callbackMessage(await callback(deleted.state)).error, 'chat_unavailable');
  assert.equal(exchangeCalls, 0);
  chats.set('chat-1', 'u1'); await addAccount('u2');
  const linked = await connect();
  assert.equal(callbackMessage(await callback(linked.state)).error, 'already_linked');
  assert.equal(rows.has('u1'), false);
});

test('legacy connect and callback remain compatible without a chat handoff', async () => {
  const res = await request(app).get('/api/github/connect');
  assert.equal(res.status, 200); assert.deepEqual(Object.keys(res.body), ['url']);
  const state = new URL(res.body.url).searchParams.get('state');
  const result = await callback(state);
  assert.equal(result.status, 302); assert.equal(result.headers.location, 'https://app.example.test/settings?github=connected');
  const stateForLegacyConsumer = await oauth.signState('u1');
  assert.equal(await oauth.verifyState(stateForLegacyConsumer), 'u1');
  assert.equal(await oauth.verifyState(stateForLegacyConsumer), null);
});

test('verified status rejects revoked, corrupt and identity-mismatched tokens without deleting the account', async () => {
  await addAccount(); fetchError = { status: 401 };
  let res = await request(app).get('/api/github/status?verify=1');
  assert.equal(res.status, 200); assert.equal(res.body.connected, false); assert.equal(res.body.reconnectRequired, true); assert.equal(res.body.verified, false); assert.equal(rows.size, 1);
  fetchError = null; githubUser = { id: 99, login: 'other' };
  res = await request(app).get('/api/github/status?verify=1');
  assert.equal(res.body.connected, false); assert.equal(res.body.code, 'github_identity_mismatch');
  await addAccount('u1', { encryptedTokens: 'invalid' });
  res = await request(app).get('/api/github/status?verify=1');
  assert.equal(res.body.connected, false); assert.equal(res.body.code, 'github_token_invalid'); assert.equal(rows.size, 1);
});

test('provider outages and rate limits return 503 without claiming disconnect or exposing provider errors', async () => {
  await addAccount();
  for (const error of [{ status: 503, message: fixtureAccessToken }, { status: 403, message: 'rate limited' }, new Error('network down')]) {
    fetchError = error;
    const res = await request(app).get('/api/github/status?verify=1');
    assert.equal(res.status, 503); assert.equal(res.body.code, 'github_verification_unavailable'); assert.equal(res.body.connected, undefined); assert.ok(!JSON.stringify(res.body).includes(fixtureAccessToken));
  }
  assert.equal(rows.size, 1);
});

test('ordinary status remains inexpensive and does not claim live verification', async () => {
  await addAccount();
  const res = await request(app).get('/api/github/status');
  assert.equal(res.body.connected, true); assert.equal(res.body.verified, undefined); assert.equal(fetchCalls, 0);
});

function receipt(flow, chatId = 'chat-1') { return request(app).get('/api/github/connect/status').query({ chatId, handoffId: flow.handoffId }); }

test('completion receipt is correlated, account scoped, retryable and unavailable before callback', async () => {
  const first = await connect(); const second = await connect();
  assert.equal((await receipt(first)).body.status, 'pending');
  await callback(first.state);
  assert.equal((await receipt(second)).body.status, 'pending');
  userId = 'u2'; assert.equal((await receipt(first)).status, 404);
  userId = 'u1';
  const done = await receipt(first);
  assert.equal(done.body.status, 'success'); assert.equal(done.body.handoffId, first.handoffId); assert.equal(done.body.chatId, 'chat-1'); assert.ok(done.body.connectionVersion);
  assert.equal(done.headers['cache-control'], 'no-store');
  assert.equal((await receipt(first)).body.status, 'success');
  assert.equal((await receipt(first, 'chat-2')).status, 404);
});

test('denied receipt cannot be mistaken for another tab connecting GitHub', async () => {
  const denied = await connect(); const successful = await connect();
  await callback(denied.state, { error: 'access_denied' }); await callback(successful.state);
  assert.equal((await request(app).get('/api/github/status?verify=1')).body.connected, true);
  const result = (await receipt(denied)).body;
  assert.equal(result.status, 'error'); assert.equal(result.error, 'denied');
  assert.equal((await receipt(successful)).body.status, 'success');
});

test('connect rejects reused handoff ids and completion endpoint requires complete owned binding', async () => {
  const flow = await connect();
  const duplicate = await request(app).get('/api/github/connect').query({ chatId: 'chat-1', handoffId: flow.handoffId, popup: '1' });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'github_handoff_reused');
  assert.equal((await request(app).get('/api/github/connect/status')).status, 400);
  assert.equal((await request(app).get('/api/github/connect/status?chatId=chat-1&handoffId=bad')).status, 400);
});

test('receipt survives verification outages and a later retry without replaying OAuth', async () => {
  const flow = await connect(); await callback(flow.state);
  assert.equal((await receipt(flow)).body.status, 'success');
  fetchError = { status: 503 };
  assert.equal((await request(app).get('/api/github/status?verify=1')).status, 503);
  fetchError = null;
  assert.equal((await receipt(flow)).body.status, 'success');
  assert.equal((await request(app).get('/api/github/status?verify=1')).body.verified, true);
  assert.equal(exchangeCalls, 1);
});

test('failure to save a completion receipt cannot report success or permit automatic continuation', async () => {
  const record = chatOAuth.recordHandoff;
  try {
    chatOAuth.recordHandoff = async () => { throw Object.assign(new Error('fixture unavailable'), { code: 'OAUTH_STATE_STORE_UNAVAILABLE' }); };
    const flow = await connect(); const result = await callback(flow.state);
    assert.equal(callbackMessage(result).status, 'error');
    assert.equal((await receipt(flow)).body.status, 'pending');
    assert.equal(rows.has('u1'), true);
  } finally { chatOAuth.recordHandoff = record; }
});
