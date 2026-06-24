'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const maintenanceMode = require('../src/middleware/maintenance-mode');
const { mockResolvedModule } = require('./http-test-utils');

/**
 * While maintenance mode is engaged, the blocked-request counter used the
 * raw, pre-route req.path as a metric label (e.g. /api/chats/<uuid>), minting
 * a new time-series per request — unbounded label cardinality during an
 * outage. The label must bucket to a bounded path prefix.
 */

function fakePrismaEnabled() {
  return {
    systemSettings: {
      async findUnique({ where }) {
        if (where.key === maintenanceMode.KEY) {
          return { key: maintenanceMode.KEY, value: JSON.stringify({ enabled: true, message: 'down', since: null }) };
        }
        return null;
      },
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function runBlocked(captured, reqPath) {
  const mw = maintenanceMode.maintenanceMiddleware({ prisma: fakePrismaEnabled() });
  const res = makeRes();
  let nextCalled = false;
  await mw({ path: reqPath, method: 'GET' }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('blocked-request metric buckets the route label to a bounded prefix', async () => {
  const captured = [];
  const restore = mockResolvedModule(require.resolve('../src/utils/metrics'), {
    counter: (name, labels, val) => captured.push({ name, labels, val }),
  });
  try {
    const { res, nextCalled } = await runBlocked(captured, '/api/chats/3f2a-90bd-uuid');
    assert.equal(nextCalled, false, 'request must be blocked during maintenance');
    assert.equal(res.statusCode, 503);

    const blocked = captured.find((c) => c.name === 'siragpt_maintenance_blocked_total');
    assert.ok(blocked, 'blocked counter should be recorded');
    assert.equal(blocked.labels.route, '/api/chats', 'label must bucket to the path prefix, not the raw URL');
  } finally {
    restore();
  }
});

test('distinct concrete URLs under one family collapse to the same label', async () => {
  const captured = [];
  const restore = mockResolvedModule(require.resolve('../src/utils/metrics'), {
    counter: (name, labels, val) => captured.push({ name, labels, val }),
  });
  try {
    await runBlocked(captured, '/api/files/aaaa');
    await runBlocked(captured, '/api/files/bbbb');
    const labels = captured
      .filter((c) => c.name === 'siragpt_maintenance_blocked_total')
      .map((c) => c.labels.route);
    assert.deepEqual(labels, ['/api/files', '/api/files'], 'both concrete URLs must share one bounded label');
  } finally {
    restore();
  }
});
