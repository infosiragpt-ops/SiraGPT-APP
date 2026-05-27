'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub alerting BEFORE requiring the route so the route picks up our stub.
const alerting = require('../src/services/alerting');
const realNotify = alerting.notifyFrontendError;

const telemetryRoute = require('../src/routes/telemetry');

test.afterEach(() => {
  alerting.notifyFrontendError = realNotify;
});

function findRouteHandler(router, path, method = 'post') {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  if (!layer || !layer.route.methods[method]) return null;
  // Skip the express.json middleware layer; the handler is the last stack entry
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const state = { statusCode: 200, body: null };
  const res = {
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; return this; },
  };
  return { res, state };
}

test('exports an Express Router with POST /error', () => {
  assert.equal(typeof telemetryRoute, 'function');
  assert.ok(Array.isArray(telemetryRoute.stack));
  const handler = findRouteHandler(telemetryRoute, '/error');
  assert.ok(handler, 'POST /error must be registered');
});

test('always responds 202 + { accepted: true } even with empty body', async () => {
  alerting.notifyFrontendError = async () => {};
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res, state } = makeRes();
  await handler({ body: {}, headers: {} }, res);
  assert.equal(state.statusCode, 202);
  assert.deepEqual(state.body, { accepted: true });
});

test('forwards the documented fields to alerting.notifyFrontendError', async () => {
  let received = null;
  alerting.notifyFrontendError = async (payload) => { received = payload; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res } = makeRes();
  await handler({
    body: { page: '/chat', message: 'TypeError: x is null', stack: 'at foo()' },
    headers: { 'user-agent': 'Mozilla/5.0' },
    user: { id: 'u-1' },
  }, res);
  // Wait for the fire-and-forget microtask
  await new Promise((r) => setImmediate(r));
  assert.equal(received.page, '/chat');
  assert.equal(received.message, 'TypeError: x is null');
  assert.equal(received.stack, 'at foo()');
  assert.equal(received.userAgent, 'Mozilla/5.0');
  assert.equal(received.userId, 'u-1');
});

test('does not alert on expected auth API failures', async () => {
  let called = false;
  alerting.notifyFrontendError = async () => { called = true; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res, state } = makeRes();
  await handler({
    body: {
      source: 'api',
      page: '/chat',
      action: 'api_request_failed',
      method: 'POST',
      endpoint: '/ai/generate-video',
      status: 401,
      message: 'Invalid or expired token',
    },
    headers: {},
  }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(state.statusCode, 202);
  assert.equal(called, false);
});

test('falls back to body.url when page is missing', async () => {
  let received = null;
  alerting.notifyFrontendError = async (p) => { received = p; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res } = makeRes();
  await handler({ body: { url: 'https://app/x' }, headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(received.page, 'https://app/x');
});

test('defaults page to "unknown" when neither page nor url is supplied', async () => {
  let received = null;
  alerting.notifyFrontendError = async (p) => { received = p; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res } = makeRes();
  await handler({ body: { message: 'oops' }, headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(received.page, 'unknown');
});

test('falls back to body.error when message is missing', async () => {
  let received = null;
  alerting.notifyFrontendError = async (p) => { received = p; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res } = makeRes();
  await handler({ body: { error: 'fallback message' }, headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(received.message, 'fallback message');
});

test('userId defaults to null when req.user is absent', async () => {
  let received = null;
  alerting.notifyFrontendError = async (p) => { received = p; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res } = makeRes();
  await handler({ body: {}, headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(received.userId, null);
});

test('tolerates non-object body without crashing', async () => {
  let received = null;
  alerting.notifyFrontendError = async (p) => { received = p; };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res, state } = makeRes();
  await handler({ body: null, headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(state.statusCode, 202);
  assert.equal(received.page, 'unknown');
});

test('alerting errors are swallowed (never propagated to the client)', async () => {
  alerting.notifyFrontendError = async () => { throw new Error('alerting offline'); };
  const handler = findRouteHandler(telemetryRoute, '/error');
  const { res, state } = makeRes();
  // The handler returns synchronously after firing the alert; the throw
  // happens on the next microtask and is caught by .catch(() => {}).
  await handler({ body: { message: 'oops' }, headers: {} }, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(state.statusCode, 202, 'must still respond 202 even when alerting throws');
});
