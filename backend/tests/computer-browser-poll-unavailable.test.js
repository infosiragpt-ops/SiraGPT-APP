'use strict';

// Prod 2026-10-03: GET /api/agent-computer/activity?browser=1 answered 502 on
// every 4-second tick while the desktop's Chrome was gone (346 «request
// errored» lines in one afternoon) and the log never named the cause. The
// poll now reports an unreachable desktop as a plain probe result (200,
// ok:false, never ok:true) and one rate-limited WARN names the cause; actions
// and navigation keep their 5xx with the real code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildRouteTestApp, installAuthSessionMock, mockResolvedModule } = require('./http-test-utils');
const { resolveSessionIdentity } = require('../src/services/computer/member-key');

test('browser poll reports an unreachable desktop without a 5xx storm', async t => {
  const auth = installAuthSessionMock();
  const owner = resolveSessionIdentity(auth.user, 'chat-a').userId;
  let failure = null;
  const undo = [
    mockResolvedModule(require.resolve('../src/services/computer/flags'), { ...require('../src/services/computer/flags'), agentComputerEnabled: () => true }),
    mockResolvedModule(require.resolve('../src/services/computer/orch-client'), {
      resolveOrchConfig: () => ({ url: 'http://test.invalid' }), rewriteUrls: x => x,
      orchFetch: async () => ({ sessionId: 'owned-desktop', userId: owner }),
    }),
    mockResolvedModule(require.resolve('../src/services/computer/live-page'), {
      validateBrowserAction: () => {},
      browserState: async () => { throw failure; },
      navigatePage: async () => { throw failure; },
      browserAction: async () => { throw failure; },
    }),
  ];
  const routePath = require.resolve('../src/routes/agent-computer');
  const previous = require.cache[routePath]; delete require.cache[routePath];
  const app = buildRouteTestApp('/api/agent-computer', require(routePath));
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  t.after(() => { console.warn = originalWarn; auth.restore(); for (const restore of undo.reverse()) restore(); if (previous) require.cache[routePath] = previous; else delete require.cache[routePath]; });
  const poll = () => request(app).get('/api/agent-computer/activity?browser=1&sessionId=owned-desktop&conversationId=chat-a').set('Authorization', auth.authHeader);

  await t.test('CDP unreachable → 200 ok:false with the code, cause in one WARN, repeats suppressed', async () => {
    failure = Object.assign(new Error('browser_observation_unavailable'), { code: 'browser_observation_unavailable', status: 502, publicMessage: 'El navegador de la computadora no responde. Inténtalo de nuevo en unos segundos.', cause: new Error('cdp_http_502') });
    const first = await poll();
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, false);
    assert.equal(first.body.error, 'browser_observation_unavailable');
    assert.equal(first.body.browser, null);
    assert.match(first.body.message, /no responde/);
    assert.equal(first.body.conversationId, 'chat-a');
    const second = await poll();
    assert.equal(second.status, 200);
    const lines = warned.filter(line => line.includes('[agent-computer] browser_observation_unavailable'));
    assert.equal(lines.length, 1, 'one WARN per code per window');
    assert.match(lines[0], /route=GET \/api\/agent-computer\/activity/);
    assert.match(lines[0], /session=owned-desktop/);
    assert.match(lines[0], /cause=cdp_http_502/);
  });

  await t.test('a dead container is desktop_unavailable, still ok:false and never a 5xx tick', async () => {
    failure = Object.assign(new Error('desktop_unavailable'), { code: 'desktop_unavailable', status: 503, publicMessage: 'El escritorio de esta conversación no está disponible. Vuelve a abrir la computadora e inténtalo de nuevo.' });
    const res = await poll();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'desktop_unavailable');
    assert.match(res.body.message, /Vuelve a abrir la computadora/);
  });

  await t.test('viewport failures keep their repairable 502 on the poll', async () => {
    failure = Object.assign(new Error('browser_viewport_failed'), { code: 'browser_viewport_failed', status: 502, publicMessage: 'No se pudo completar la acción del navegador. Vuelve a intentarlo.' });
    const res = await poll();
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'browser_viewport_failed');
  });

  await t.test('actions and navigation surface the unavailable code with a 5xx, cause logged without secrets', async () => {
    failure = Object.assign(new Error('browser_observation_unavailable'), { code: 'browser_observation_unavailable', status: 502, publicMessage: 'El navegador de la computadora no responde. Inténtalo de nuevo en unos segundos.', cause: new Error('Bearer sk-abcdefghijklmnop leaked') });
    const action = await request(app).post('/api/agent-computer/action').set('Authorization', auth.authHeader)
      .send({ sessionId: 'owned-desktop', conversationId: 'chat-a', action: { type: 'browser_reload' } });
    assert.equal(action.status, 502);
    assert.equal(action.body.error, 'browser_observation_unavailable');
    assert.notEqual(action.body.ok, true);
    assert.doesNotMatch(JSON.stringify(action.body), /sk-abcdefgh/);
    const nav = await request(app).post('/api/agent-computer/navigate').set('Authorization', auth.authHeader)
      .send({ sessionId: 'owned-desktop', conversationId: 'chat-a', url: 'https://example.com/' });
    assert.equal(nav.status, 502);
    assert.equal(nav.body.error, 'browser_observation_unavailable');
    assert.ok(warned.every(line => !line.includes('sk-abcdefgh')), 'the WARN line must not carry a secret');
  });
});
