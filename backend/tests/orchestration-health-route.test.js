'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function findRouteHandler(router, routePath, method = 'get') {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath);
  if (!layer) return null;
  const methods = layer.route.methods;
  if (!methods[method]) return null;
  // The actual user handler is the last entry in the route stack
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const captured = { statusCode: 200, body: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(body) { captured.body = body; return this; },
  };
  return { res, captured };
}

test('orchestration route exports an Express Router with /health', () => {
  const route = require('../src/routes/orchestration');
  assert.ok(route, 'route module should export something');
  assert.equal(typeof route, 'function', 'Express Router is a function');
  assert.ok(Array.isArray(route.stack), 'router.stack should be an array');
  for (const p of ['/health', '/health/ready', '/health/live']) {
    const layer = route.stack.find((l) => l.route && l.route.path === p);
    assert.ok(layer, `should register ${p}`);
    assert.ok(layer.route.methods.get, `should respond to GET ${p}`);
  }
});

test('orchestration /health handler returns subsystem snapshot or 503', async () => {
  const route = require('../src/routes/orchestration');
  const handler = findRouteHandler(route, '/health');
  assert.ok(handler, 'expected /health handler');
  const { res, captured } = makeRes();
  await handler({ user: null }, res);
  assert.ok([200, 503].includes(captured.statusCode), `unexpected status: ${captured.statusCode}`);
  assert.ok(captured.body, 'should return a body');
  if (captured.statusCode === 200) {
    assert.equal(typeof captured.body.gateway, 'boolean', 'gateway must be boolean');
    assert.equal(typeof captured.body.memory, 'object', 'memory must be object');
    assert.equal(typeof captured.body.search, 'object', 'search must be object');
  } else {
    assert.equal(captured.body.status, 'unhealthy', '503 must carry unhealthy status');
  }
});

test('orchestration /health/ready returns 200 with ready status when gateway is up', async () => {
  const route = require('../src/routes/orchestration');
  const handler = findRouteHandler(route, '/health/ready');
  assert.ok(handler, 'expected /health/ready handler');
  const { res, captured } = makeRes();
  await handler({}, res);
  // gateway is universally available (no provider keys required) so this
  // path should be 200 + ready in any environment.
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.status, 'ready');
  assert.equal(captured.body.gateway, true);
});

test('orchestration /health/live always returns 200 with alive status', () => {
  const route = require('../src/routes/orchestration');
  const handler = findRouteHandler(route, '/health/live');
  assert.ok(handler, 'expected /health/live handler');
  const { res, captured } = makeRes();
  const before = Date.now();
  handler({}, res);
  const after = Date.now();
  // liveness is synchronous so no await needed
  assert.equal(captured.statusCode, 200, 'liveness must always be 200');
  assert.equal(captured.body.status, 'alive');
  assert.ok(typeof captured.body.timestamp === 'number');
  assert.ok(captured.body.timestamp >= before && captured.body.timestamp <= after, 'timestamp must be a recent epoch ms');
});

test('orchestration /health/ready returns 503 when wireup fails to boot', async () => {
  // Inject a require-cache stub so getOrchestrationWireup throws.
  const wireupPath = require.resolve('../src/orchestration/orchestration-wireup');
  const original = require.cache[wireupPath];
  require.cache[wireupPath] = {
    id: wireupPath,
    filename: wireupPath,
    loaded: true,
    exports: {
      getOrchestrationWireup: () => { throw new Error('boot failed'); },
    },
  };
  // Force re-require of the route to pick up the stubbed wireup
  const routePath = require.resolve('../src/routes/orchestration');
  const routeOriginal = require.cache[routePath];
  delete require.cache[routePath];
  try {
    const route = require('../src/routes/orchestration');
    const handler = findRouteHandler(route, '/health/ready');
    const { res, captured } = makeRes();
    await handler({}, res);
    assert.equal(captured.statusCode, 503, 'boot failure must surface as 503');
    assert.equal(captured.body.status, 'not_ready');
    assert.match(captured.body.error, /boot failed/);
  } finally {
    // Restore caches so subsequent tests see the real modules
    if (original) require.cache[wireupPath] = original;
    else delete require.cache[wireupPath];
    if (routeOriginal) require.cache[routePath] = routeOriginal;
    else delete require.cache[routePath];
  }
});
