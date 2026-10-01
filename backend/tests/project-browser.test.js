'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyProjectPreviewForChat, _internal } = require('../src/services/codex/project-browser');
const { signPreviewToken, previewTokenFor } = require('../src/services/code/preview-proxy');
const env = { NODE_ENV: 'test', PUBLIC_FRONTEND_URL: 'https://siragpt.com', CODE_RUNNER_PREVIEW_TOKEN_SECRET: 'fixture-project-browser-secret-only' };
function setup(overrides = {}) {
  const token = previewTokenFor({ projectId: 'p1', userId: 'u1' }, env);
  const state = { project: 'p1', running: true, ready: true, basePath: `/api/codex/projects/p1/preview/${token}/app/`, ...overrides.status };
  const calls = [];
  return { calls, token, deps: {
    env, db: { user: { findUnique: async () => overrides.user || { id: 'u1', isAdmin: true } } },
    projectService: {}, githubApi: null,
    binding: { findProjectForChat: async args => { calls.push(['binding', args.userId, args.chatId]); return overrides.project || { id: 'p1' }; } },
    runner: { devStatus: async id => { calls.push(['status', id]); return state; } },
    playwrightImpl: { chromium: { launch: async () => { calls.push(['launch']); throw new Error(`private ${token} https://siragpt.com${state.basePath}`); } } },
  } };
}
const args = { userId: 'u1', chatId: 'c1', projectId: 'p1' };

test('browser verification requires account access before resolving a project', async () => {
  const { calls, deps } = setup({ user: { id: 'u1', isAdmin: false } });
  const result = await verifyProjectPreviewForChat(args, deps);
  assert.equal(result.code, 'codex_forbidden'); assert.equal(result.ok, false); assert.equal(calls.length, 0);
});
test('browser verification refuses a foreign chat binding or runner project before launching', async () => {
  for (const overrides of [{ project: { id: 'p2' } }, { status: { project: 'p2' } }, { status: { project: undefined } }]) {
    const { deps, calls } = setup(overrides);
    assert.equal((await verifyProjectPreviewForChat(args, deps)).code, 'preview_identity_invalid');
    assert.ok(!calls.some(call => call[0] === 'launch'));
  }
});
test('browser verification refuses stopped, pending or errored previews', async () => {
  for (const status of [{ running: false }, { ready: false }, { error: 'broken' }]) {
    const { deps, calls } = setup({ status });
    assert.equal((await verifyProjectPreviewForChat(args, deps)).code, 'preview_not_ready');
    assert.ok(!calls.some(call => call[0] === 'launch'));
  }
});
test('browser verification validates token signature, expiry and both owners', async () => {
  const valid = previewTokenFor({ projectId: 'p1', userId: 'u1' }, env);
  const expired = signPreviewToken({ projectId: 'p1', userId: 'u1', iat: Date.now() - 3000, exp: Date.now() + 1 }, env);
  await new Promise(resolve => setTimeout(resolve, 3));
  for (const token of ['bad.token', expired, previewTokenFor({ projectId: 'p2', userId: 'u1' }, env), previewTokenFor({ projectId: 'p1', userId: 'u2' }, env), `${valid}x`]) {
    const { deps, calls } = setup({ status: { basePath: `/api/codex/projects/p1/preview/${token}/app/` } });
    assert.equal((await verifyProjectPreviewForChat(args, deps)).code, 'preview_identity_invalid');
    assert.ok(!calls.some(call => call[0] === 'launch'));
  }
});
test('missing Chromium is a strict failure and never exposes raw URLs or errors', async () => {
  const { deps, token, calls } = setup();
  const result = await verifyProjectPreviewForChat({ ...args, url: 'http://localhost/metadata' }, deps);
  assert.equal(result.code, 'browser_unavailable'); assert.equal(result.ok, false);
  assert.deepEqual(calls, [['binding', 'u1', 'c1'], ['status', 'p1'], ['launch']]);
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes('https://'));
});
test('production never accepts the loopback test override', async () => {
  const { deps, calls } = setup();
  deps.env = { ...env, NODE_ENV: 'production', PUBLIC_FRONTEND_URL: 'http://127.0.0.1:3456' };
  deps.allowTestLoopback = true;
  assert.equal((await verifyProjectPreviewForChat(args, deps)).code, 'preview_identity_invalid');
  assert.ok(!calls.some(call => call[0] === 'launch'));
});
test('Stop before and during authorization does not launch Chromium', async () => {
  const controller = new AbortController(); controller.abort();
  const { deps, calls } = setup();
  assert.equal((await verifyProjectPreviewForChat({ ...args, signal: controller.signal }, deps)).code, 'E_CANCELLED');
  assert.equal(calls.length, 0);
  const later = new AbortController();
  deps.db.user.findUnique = async () => { later.abort(); return { id: 'u1', isAdmin: true }; };
  assert.equal((await verifyProjectPreviewForChat({ ...args, signal: later.signal }, deps)).code, 'E_CANCELLED');
  assert.equal(calls.length, 0);
});
test('request gate allows only the exact preview prefix and rejects encoded escapes', () => {
  const target = new URL('https://siragpt.com/api/codex/projects/p1/preview/signed.token/app/');
  assert.equal(_internal.requestIsOwned(`${target}assets/main.js?x=1`, target), true);
  assert.equal(_internal.requestIsOwned(target.href.slice(0, -1), target), true);
  for (const url of [
    'http://127.0.0.1/metadata', 'https://siragpt.com/api/auth/me', 'https://elsewhere.com/',
    `${target}../admin`, `${target}%2e%2e/admin`, `${target}%2Fapi`, `${target}%5cadmin`,
    'https://siragpt.com/api/codex/projects/p2/preview/signed.token/app/', `${target.href.slice(0, -1)}-other/`,
  ]) assert.equal(_internal.requestIsOwned(url, target), false, url);
});

test('socket gate preserves transport security and rejects external or foreign project sockets', () => {
  const target = new URL('https://siragpt.com/api/codex/projects/p1/preview/signed.token/app/');
  assert.equal(_internal.socketIsOwned(target.href.replace('https:', 'wss:'), target), true);
  for (const raw of [
    target.href.replace('https:', 'ws:'), target.href,
    'wss://elsewhere.com/api/codex/projects/p1/preview/signed.token/app/',
    'wss://siragpt.com/api/codex/projects/p2/preview/signed.token/app/',
    `${target.href.replace('https:', 'wss:')}../admin`,
  ]) assert.equal(_internal.socketIsOwned(raw, target), false, raw);
});

test('Stop and deadline interrupt a pending ownership or runner preflight without a late browser launch', async () => {
  for (const phase of ['binding', 'status']) {
    for (const interrupt of ['stop', 'deadline']) {
      const { deps, calls } = setup();
      let release, entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      const pending = new Promise(resolve => { release = resolve; });
      if (phase === 'binding') deps.binding.findProjectForChat = () => { entered(); return pending; };
      else deps.runner.devStatus = () => { entered(); return pending; };
      const controller = new AbortController();
      const result = verifyProjectPreviewForChat({ ...args, signal: controller.signal }, { ...deps, timeoutMs: 100 });
      await waiting;
      if (interrupt === 'stop') controller.abort();
      const out = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve({ code: 'test_timeout' }), 1000))]);
      assert.equal(out.code, interrupt === 'stop' ? 'E_CANCELLED' : 'browser_timeout', `${phase}:${interrupt}`);
      release(phase === 'binding' ? { id: 'p1' } : { project: 'p1', running: true, ready: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(!calls.some(call => call[0] === 'launch'));
    }
  }
});
