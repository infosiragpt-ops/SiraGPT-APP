'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function findRouteLayer(router, routePath, method = 'get') {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath);
  if (!layer) return null;
  if (!layer.route.methods[method]) return null;
  return layer;
}

function getUserHandler(routeLayer) {
  // Last entry in the route stack is the user-supplied async handler;
  // earlier entries are middleware (noCacheHeaders, optionalAuth, etc.).
  return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;
}

function makeRes() {
  const captured = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(body) { captured.body = body; return this; },
    set(nameOrObj, value) {
      if (typeof nameOrObj === 'object' && nameOrObj !== null) {
        Object.assign(captured.headers, nameOrObj);
      } else {
        captured.headers[nameOrObj] = value;
      }
      return this;
    },
  };
  return { res, captured };
}

// Walk the route's middleware stack and invoke each handler in sequence
// until one of them responds (status/json) or all run through next().
async function runRoute(routeLayer, req) {
  const { res, captured } = makeRes();
  const stack = routeLayer.route.stack;
  for (let i = 0; i < stack.length; i++) {
    let advance = false;
    const next = () => { advance = true; };
    await stack[i].handle(req, res, next);
    if (!advance) break;
  }
  return { res, captured };
}

test('orchestration route exports an Express Router with /health, /health/ready, /health/live', () => {
  const route = require('../src/routes/orchestration');
  assert.ok(route);
  assert.equal(typeof route, 'function');
  for (const p of ['/health', '/health/ready', '/health/live']) {
    const layer = findRouteLayer(route, p);
    assert.ok(layer, `should register ${p}`);
    assert.ok(layer.route.methods.get, `should respond to GET ${p}`);
  }
});

test('all three health probes set Cache-Control: no-store (avoid CDN/proxy caching)', async () => {
  const route = require('../src/routes/orchestration');
  for (const p of ['/health', '/health/ready', '/health/live']) {
    const layer = findRouteLayer(route, p);
    const { captured } = await runRoute(layer, { user: null });
    assert.match(captured.headers['Cache-Control'] || '', /no-store/, `${p} must set no-store`);
    assert.equal(captured.headers.Pragma, 'no-cache', `${p} must set Pragma: no-cache for HTTP/1.0 caches`);
    assert.equal(captured.headers.Expires, '0', `${p} must set Expires: 0`);
  }
});

test('orchestration /health returns subsystem snapshot or 503', async () => {
  const route = require('../src/routes/orchestration');
  const layer = findRouteLayer(route, '/health');
  const handler = getUserHandler(layer);
  const { res, captured } = makeRes();
  await handler({ user: null }, res);
  assert.ok([200, 503].includes(captured.statusCode));
  assert.ok(captured.body);
  if (captured.statusCode === 200) {
    assert.equal(typeof captured.body.gateway, 'boolean');
    assert.equal(typeof captured.body.memory, 'object');
    assert.equal(typeof captured.body.search, 'object');
  } else {
    assert.equal(captured.body.status, 'unhealthy');
  }
});

test('orchestration /health/ready returns 200 + ready when gateway is up', async () => {
  const route = require('../src/routes/orchestration');
  const layer = findRouteLayer(route, '/health/ready');
  const handler = getUserHandler(layer);
  const { res, captured } = makeRes();
  await handler({}, res);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.status, 'ready');
  assert.equal(captured.body.gateway, true);
});

test('orchestration /health/live always returns 200 + alive', () => {
  const route = require('../src/routes/orchestration');
  const layer = findRouteLayer(route, '/health/live');
  const handler = getUserHandler(layer);
  const { res, captured } = makeRes();
  const before = Date.now();
  handler({}, res);
  const after = Date.now();
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.status, 'alive');
  assert.equal(typeof captured.body.timestamp, 'number');
  assert.ok(captured.body.timestamp >= before && captured.body.timestamp <= after);
});

test('orchestration /health/ready returns 503 when wireup fails to boot', async () => {
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
  const routePath = require.resolve('../src/routes/orchestration');
  const routeOriginal = require.cache[routePath];
  delete require.cache[routePath];
  try {
    const route = require('../src/routes/orchestration');
    const layer = findRouteLayer(route, '/health/ready');
    const handler = getUserHandler(layer);
    const { res, captured } = makeRes();
    await handler({}, res);
    assert.equal(captured.statusCode, 503);
    assert.equal(captured.body.status, 'not_ready');
    assert.match(captured.body.error, /boot failed/);
  } finally {
    if (original) require.cache[wireupPath] = original;
    else delete require.cache[wireupPath];
    if (routeOriginal) require.cache[routePath] = routeOriginal;
    else delete require.cache[routePath];
  }
});
