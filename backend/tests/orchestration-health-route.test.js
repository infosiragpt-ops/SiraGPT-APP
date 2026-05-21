'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('orchestration route exports an Express Router with /health', () => {
  const route = require('../src/routes/orchestration');
  assert.ok(route, 'route module should export something');
  assert.equal(typeof route, 'function', 'Express Router is a function');
  assert.ok(Array.isArray(route.stack), 'router.stack should be an array');
  const healthLayer = route.stack.find(
    (l) => l.route && l.route.path === '/health'
  );
  assert.ok(healthLayer, 'should register /health');
  assert.ok(healthLayer.route.methods.get, 'should respond to GET');
});

test('orchestration /health handler returns subsystem snapshot or 503', async () => {
  const route = require('../src/routes/orchestration');
  const healthLayer = route.stack.find(
    (l) => l.route && l.route.path === '/health'
  );
  const handler = healthLayer.route.stack[healthLayer.route.stack.length - 1].handle;

  const req = { user: null };
  let statusCode = 200;
  let bodyCaptured = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { bodyCaptured = body; return this; },
  };

  await handler(req, res);

  assert.ok([200, 503].includes(statusCode), `unexpected status: ${statusCode}`);
  assert.ok(bodyCaptured, 'should return a body');
  if (statusCode === 200) {
    assert.equal(typeof bodyCaptured.gateway, 'boolean', 'gateway must be boolean');
    assert.equal(typeof bodyCaptured.memory, 'object', 'memory must be object');
    assert.equal(typeof bodyCaptured.search, 'object', 'search must be object');
  } else {
    assert.equal(bodyCaptured.status, 'unhealthy', '503 must carry unhealthy status');
  }
});
