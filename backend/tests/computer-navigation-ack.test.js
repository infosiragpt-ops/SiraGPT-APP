const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildRouteTestApp, installAuthSessionMock, mockResolvedModule } = require('./http-test-utils');

const safeFailure = 'No se pudo abrir la página. Revisa la dirección e inténtalo de nuevo.';

test('authenticated navigation acknowledges the bound live page, never a background launcher', async (t) => {
  const auth = installAuthSessionMock();
  const originalFetch = global.fetch;
  let enabled = true;
  let wrongOwner = false;
  let navigateError;
  const navigations = [];
  let launches = 0;
  let shellNavigations = 0;
  const restore = [
    mockResolvedModule(require.resolve('../src/services/computer/flags'), {
      agentComputerEnabled: () => enabled,
    }),
    mockResolvedModule(require.resolve('../src/services/computer/orch-client'), {
      resolveOrchConfig: () => ({ url: 'http://test-orchestrator.invalid', secret: '' }),
      rewriteUrls: value => value,
      orchFetch: async (path, init) => {
        assert.equal(path, '/sessions');
        return { sessionId: 'bound-desktop', userId: wrongOwner ? 'another-user' : init.body.userId };
      },
    }),
    mockResolvedModule(require.resolve('../src/services/computer/live-page'), {
      navigatePage: async (session, url, env, signal) => {
        navigations.push({ session, url, signal });
        if (navigateError) throw navigateError;
        return { ok: true, url: 'https://example.com/redirected' };
      },
    }),
    mockResolvedModule(require.resolve('../src/services/computer/persistent'), {
      openUrlInChrome: async () => { launches++; return { ok: true, stdout: 'Opening' }; },
    }),
  ];
  global.fetch = async () => {
    shellNavigations++;
    return { ok: true, json: async () => ({ ok: true, stdout: 'Opening' }) };
  };
  const routePath = require.resolve('../src/routes/agent-computer');
  const cachedRoute = require.cache[routePath];
  delete require.cache[routePath];
  const route = require(routePath);
  const app = buildRouteTestApp('/api/agent-computer', route);
  const send = (body, authenticated = true) => {
    const req = request(app).post('/api/agent-computer/navigate');
    if (authenticated) req.set('Authorization', auth.authHeader);
    return req.send(body);
  };
  t.after(() => {
    auth.restore();
    global.fetch = originalFetch;
    for (const undo of restore.reverse()) undo();
    if (cachedRoute) require.cache[routePath] = cachedRoute;
    else delete require.cache[routePath];
  });

  await t.test('returns the loaded URL and preserves authenticated conversation binding', async () => {
    const res = await send({ url: 'https://example.com/', conversationId: 'qa-chat', userId: 'ignored-client-user' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.url, 'https://example.com/redirected');
    assert.equal(res.body.conversationId, 'qa-chat');
    assert.equal(res.body.conversationBound, true);
    assert.equal(navigations.length, 1);
    assert.equal(navigations[0].session.sessionId, 'bound-desktop');
    assert.notEqual(navigations[0].session.userId, 'ignored-client-user');
    assert.equal(navigations[0].url, 'https://example.com/');
    assert.ok(navigations[0].signal instanceof AbortSignal);
    assert.equal(shellNavigations, 0);
    assert.equal(launches, 0);
  });

  await t.test('navigation failure is visible and cannot fall back to a false launch acknowledgment', async () => {
    navigateError = new Error('page.goto failed; internal-host / secret-browser-detail');
    const count = navigations.length;
    const res = await send({ url: 'https://example.com/', conversationId: 'qa-chat' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'navigate_failed');
    assert.equal(res.body.message, safeFailure);
    assert.equal(navigations.length, count + 1);
    assert.equal(launches, 0);
    assert.equal(shellNavigations, 0);
    assert.doesNotMatch(JSON.stringify(res.body), /secret-browser-detail|internal-host|Opening/);
    navigateError = undefined;
  });

  await t.test('flag, authentication, URL and conversation isolation still fail closed', async () => {
    const count = navigations.length;
    enabled = false;
    assert.equal((await send({ url: 'https://example.com/', conversationId: 'qa-chat' })).status, 404);
    enabled = true;
    assert.equal((await send({ url: 'https://example.com/' }, false)).status, 401);
    assert.equal((await send({ url: 'file:///etc/passwd', conversationId: 'qa-chat' })).status, 400);
    wrongOwner = true;
    assert.equal((await send({ url: 'https://example.com/', conversationId: 'qa-chat' })).status, 409);
    wrongOwner = false;
    assert.equal(navigations.length, count);
  });
});

function livePageHarness({ focused = true, failure } = {}) {
  const calls = [];
  const oldPage = { evaluate: async () => false };
  const selected = {
    evaluate: async () => focused,
    bringToFront: async () => { calls.push('front'); },
    goto: async (url, options) => { calls.push({ url, options }); if (failure) throw failure; },
    url: () => 'https://example.com/redirected',
  };
  const browser = {
    contexts: () => [{ pages: () => [oldPage, selected] }],
    close: async () => { calls.push('disconnect'); },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/computer/live-page'), 'utf8'), {
    module, exports: module.exports, process, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://test.invalid/browser' }) }),
    require: name => {
      if (name === './orch-client') return { resolveOrchConfig: () => ({ url: 'http://test.invalid' }) };
      if (name === './cdp-client') return { rewriteCdpWs: (url) => url };
      if (name === 'playwright') return { chromium: { connectOverCDP: async () => browser } };
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  return { navigatePage: module.exports.navigatePage, calls };
}

test('live navigation uses the focused page, brings it forward and waits for DOM before reporting actual URL', async () => {
  const { navigatePage, calls } = livePageHarness();
  const result = await navigatePage({ sessionId: 'desktop' }, 'https://example.com/');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.com/redirected');
  assert.equal(calls[0], 'front');
  assert.equal(calls[1].url, 'https://example.com/');
  assert.equal(calls[1].options.waitUntil, 'domcontentloaded');
  assert.equal(calls[1].options.timeout, 15000);
  assert.equal(calls[2], 'disconnect');
});

test('live navigation propagates goto failure and disconnects without a second page or launch', async () => {
  const failure = new Error('controlled navigation failure');
  const { navigatePage, calls } = livePageHarness({ failure });
  await assert.rejects(navigatePage({ sessionId: 'desktop' }, 'https://example.com/'), error => error === failure);
  assert.equal(calls.length, 3);
  assert.equal(calls[2], 'disconnect');
});
