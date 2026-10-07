const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildRouteTestApp, installAuthSessionMock, mockResolvedModule } = require('./http-test-utils');
const { resolveSessionIdentity } = require('../src/services/computer/member-key');

test('browser controls preserve existing authenticated desktop ownership and report confirmed state', async t => {
  const auth = installAuthSessionMock();
  let enabled = true, failure = false, navigationFailure;
  const requests = [], controls = [], reads = [];
  const validateBrowserAction = require('../src/services/computer/live-page').validateBrowserAction;
  const browser = { tabs: [{ id: 'target-1', title: 'Página', url: 'https://example.com/' }], activeTabId: 'target-1', canGoBack: true, canGoForward: false, presentation: 'embedded', viewport: { width: 1000, height: 700 } };
  // The HTTP fixture derives the member from the same verified auth session.
  const chatOwner = resolveSessionIdentity(auth.user, 'chat-a').userId;
  const homeOwner = resolveSessionIdentity(auth.user, null).userId;
  let returnedOwner = chatOwner;
  const undo = [
    mockResolvedModule(require.resolve('../src/services/computer/flags'), { ...require('../src/services/computer/flags'), agentComputerEnabled: () => enabled }),
    mockResolvedModule(require.resolve('../src/services/computer/orch-client'), {
      resolveOrchConfig: () => ({ url: 'http://test.invalid' }), rewriteUrls: x => x,
      orchFetch: async (path, init) => {
        requests.push({ path, init });
        assert.equal(path, '/sessions/owned-desktop');
        assert.equal(init, undefined, 'read inventory must never create an orchestrator session');
        return { sessionId: 'owned-desktop', userId: returnedOwner };
      },
    }),
    mockResolvedModule(require.resolve('../src/services/computer/live-page'), {
      validateBrowserAction: action => {
        if (!['browser_tab_select', 'browser_tab_create', 'browser_tab_close', 'browser_back', 'browser_forward', 'browser_reload', 'browser_present', 'browser_restore'].includes(action.type)) {
          throw Object.assign(new Error('invalid'), { code: 'browser_action_invalid', status: 400 });
        }
      },
      browserState: async (session, _env, signal) => { reads.push({ session, signal }); return browser; },
      navigatePage: async () => { if (navigationFailure) throw navigationFailure; return { ok: true, url: 'https://example.com/' }; },
      browserAction: async (session, action, _env, signal) => {
        validateBrowserAction(action);
        controls.push({ session, action, signal });
        if (failure) throw new Error('private-session-or-secret-diagnostic');
        return browser;
      },
    }),
  ];
  const routePath = require.resolve('../src/routes/agent-computer');
  const previous = require.cache[routePath]; delete require.cache[routePath];
  const app = buildRouteTestApp('/api/agent-computer', require(routePath));
  const identityApp = app;
  const send = (type, conversationId = 'chat-a') => {
    return request(identityApp).post('/api/agent-computer/action').set('Authorization', auth.authHeader).send({ sessionId: 'owned-desktop', conversationId, action: { type, tabId: 'target-1' }, userId: 'untrusted' });
  };
  t.after(() => { auth.restore(); for (const restore of undo.reverse()) restore(); if (previous) require.cache[routePath] = previous; else delete require.cache[routePath]; });

  await t.test('inventory is read-only and carries bound metadata', async () => {
    const res = await request(identityApp).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop&conversationId=chat-a').set('Authorization', auth.authHeader);
    assert.equal(res.status, 200); assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.browser, browser); assert.equal(res.body.conversationId, 'chat-a');
    assert.equal(res.body.conversationBound, true); assert.equal(reads.length, 1);
    assert.ok(reads[0].signal instanceof AbortSignal);
  });
  await t.test('home inventory uses verified member ownership without inventing a chat', async () => {
    returnedOwner = homeOwner;
    const res = await request(identityApp).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop').set('Authorization', auth.authHeader);
    assert.equal(res.status, 200); assert.equal(res.body.conversationBound, false);
    returnedOwner = chatOwner;
  });
  await t.test('actions report only returned browser state and use the requested existing session', async () => {
    const res = await send('browser_tab_select');
    assert.equal(res.status, 200, JSON.stringify(res.body)); assert.deepEqual(res.body.browser, browser);
    assert.equal(controls.at(-1).session.sessionId, 'owned-desktop');
    assert.equal(controls.at(-1).action.tabId, 'target-1');
    assert.ok(controls.at(-1).signal instanceof AbortSignal);
  });
  await t.test('navigation preserves a repairable viewport failure without exposing its private cause', async () => {
    navigationFailure = Object.assign(new Error('browser_viewport_failed'), {
      code: 'browser_viewport_failed', status: 502,
      publicMessage: 'No se pudo completar la acción del navegador. Vuelve a intentarlo.',
      cause: new Error('private-session-or-secret-diagnostic'),
    });
    const res = await request(identityApp).post('/api/agent-computer/navigate').set('Authorization', auth.authHeader)
      .send({ sessionId: 'owned-desktop', conversationId: 'chat-a', tabId: 'target-1', url: 'https://example.com/' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'browser_viewport_failed');
    assert.equal(res.body.message, navigationFailure.publicMessage);
    assert.notEqual(res.body.ok, true);
    assert.doesNotMatch(JSON.stringify(res.body), /private-session|secret-diagnostic/);
    navigationFailure = undefined;
  });
  await t.test('an address Chromium cannot resolve is the caller\'s 422 with a plain Spanish message, never a 502 ERROR', async () => {
    navigationFailure = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://google/\nCall log:\n  - navigating to "https://google/", waiting until "domcontentloaded"');
    const res = await request(identityApp).post('/api/agent-computer/navigate').set('Authorization', auth.authHeader)
      .send({ sessionId: 'owned-desktop', conversationId: 'chat-a', tabId: 'target-1', url: 'https://google/' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'navigate_host_unresolved');
    assert.match(res.body.message, /No se encontró el sitio «google»/);
    assert.doesNotMatch(JSON.stringify(res.body), /page\.goto|Call log|ERR_NAME_NOT_RESOLVED/);
    navigationFailure = new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://intranet.local/');
    const down = await request(identityApp).post('/api/agent-computer/navigate').set('Authorization', auth.authHeader)
      .send({ sessionId: 'owned-desktop', conversationId: 'chat-a', tabId: 'target-1', url: 'https://intranet.local/' });
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'navigate_site_unreachable');
    assert.match(down.body.message, /«intranet\.local»/);
    navigationFailure = new Error('browserContext.newPage: Target page, context or browser has been closed');
    const generic = await request(identityApp).post('/api/agent-computer/navigate').set('Authorization', auth.authHeader)
      .send({ sessionId: 'owned-desktop', conversationId: 'chat-a', tabId: 'target-1', url: 'https://example.com/' });
    assert.equal(generic.status, 502);
    assert.equal(generic.body.error, 'navigate_failed');
    navigationFailure = undefined;
  });
  await t.test('ownership, authentication, flag and missing session deny before CDP', async () => {
    const count = reads.length + controls.length;
    returnedOwner = 'different-member';
    assert.equal((await send('browser_tab_close')).status, 409);
    assert.equal((await request(identityApp).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop&conversationId=chat-a').set('Authorization', auth.authHeader)).status, 409);
    assert.equal((await request(identityApp).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop').set('Authorization', auth.authHeader)).status, 403, 'home cannot read another member desktop');
    returnedOwner = chatOwner;
    assert.equal((await request(identityApp).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop').set('Authorization', auth.authHeader)).status, 403, 'home cannot read even its own conversation-bound desktop without that conversation');
    assert.equal((await send('browser_tab_close', 'different-chat')).status, 409, 'changing chatId does not change the stored desktop owner');
    assert.equal((await request(identityApp).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop')).status, 401);
    assert.equal((await request(identityApp).get('/api/agent-computer/activity?browser=1').set('Authorization', auth.authHeader)).status, 400);
    enabled = false; assert.equal((await send('browser_tab_close')).status, 404); enabled = true;
    assert.equal(reads.length + controls.length, count);
  });
  await t.test('an invalid browser command cannot become raw shell, and failures never acknowledge success', async () => {
    const count = controls.length;
    assert.equal((await send('browser_eval')).status, 400);
    assert.equal(controls.length, count);
    failure = true;
    const res = await send('browser_reload');
    assert.equal(res.status, 502); assert.notEqual(res.body.ok, true);
    assert.equal(res.body.error, 'browser_action_failed');
    assert.doesNotMatch(JSON.stringify(res.body), /private-session|secret-diagnostic/);
  });
});
