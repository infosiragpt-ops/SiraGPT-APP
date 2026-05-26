'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNPlusOneDetector,
  signatureOf,
} = require('../src/db/n-plus-one-detector');

function silentLogger() {
  return { warn() {}, error() {}, info() {} };
}

function makeClock(initial = 1_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

test('signatureOf collapses identical shapes with different literals', () => {
  const a = signatureOf('User', 'findUnique', { where: { id: 1 } });
  const b = signatureOf('User', 'findUnique', { where: { id: 9999 } });
  const c = signatureOf('User', 'findUnique', { where: { email: 'x' } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('signatureOf differentiates select / include / orderBy shapes', () => {
  const base = signatureOf('Post', 'findMany', { where: { authorId: 1 } });
  const withSelect = signatureOf('Post', 'findMany', {
    where: { authorId: 1 },
    select: { id: true, title: true },
  });
  const withInclude = signatureOf('Post', 'findMany', {
    where: { authorId: 1 },
    include: { author: true },
  });
  const withOrder = signatureOf('Post', 'findMany', {
    where: { authorId: 1 },
    orderBy: { createdAt: 'desc' },
  });
  assert.notEqual(base, withSelect);
  assert.notEqual(base, withInclude);
  assert.notEqual(base, withOrder);
});

test('emits warning after threshold repetitions in same scope', () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 5,
    windowMs: 10_000,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  det.runInScope({ requestId: 'req-1', route: '/api/posts', method: 'GET' }, () => {
    for (let i = 0; i < 5; i++) {
      det.track({ model: 'User', operation: 'findUnique', args: { where: { id: i } } });
    }
  });

  assert.equal(events.length, 1);
  const w = events[0];
  assert.equal(w.requestId, 'req-1');
  assert.equal(w.route, '/api/posts');
  assert.equal(w.model, 'User');
  assert.equal(w.operation, 'findUnique');
  assert.equal(w.count, 5);
  assert.equal(w.threshold, 5);
  assert.match(w.signature, /User#findUnique/);
});

test('does not warn when below threshold', () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 5,
    windowMs: 10_000,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  det.runInScope({}, () => {
    for (let i = 0; i < 4; i++) {
      det.track({ model: 'User', operation: 'findUnique', args: { where: { id: i } } });
    }
  });

  assert.equal(events.length, 0);
});

test('different signatures are counted independently', () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 3,
    windowMs: 10_000,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  det.runInScope({}, () => {
    for (let i = 0; i < 2; i++) {
      det.track({ model: 'User', operation: 'findUnique', args: { where: { id: i } } });
    }
    for (let i = 0; i < 2; i++) {
      det.track({ model: 'Post', operation: 'findMany', args: { where: { authorId: i } } });
    }
  });

  assert.equal(events.length, 0, 'neither bucket reached threshold individually');
});

test('warns once per signature within a scope (no spam)', () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 3,
    windowMs: 10_000,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  det.runInScope({}, () => {
    for (let i = 0; i < 20; i++) {
      det.track({ model: 'User', operation: 'findUnique', args: { where: { id: i } } });
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].count, 3, 'fires at the threshold crossing');
});

test('window expiration resets the counter and re-arms warning', () => {
  const clock = makeClock();
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 3,
    windowMs: 1000,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
    now: clock.now,
  });

  det.runInScope({}, () => {
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 1 } } });
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 2 } } });
    clock.advance(2000); // window expires
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 3 } } });
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 4 } } });
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 5 } } });
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 6 } } });
  });

  assert.equal(events.length, 1);
  // After re-arm, count starts over from the post-expiration tick.
  assert.equal(events[0].count, 3);
});

test('scopes do not bleed across concurrent requests', async () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 3,
    windowMs: 10_000,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  async function simulateRequest(id) {
    return new Promise((resolve) => {
      det.runInScope({ requestId: id }, () => {
        // 2 hits per request — neither should trip the threshold alone
        setImmediate(() => {
          det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 1 } } });
          det.track({ model: 'User', operation: 'findUnique', args: { where: { id: 2 } } });
          resolve();
        });
      });
    });
  }

  await Promise.all([
    simulateRequest('A'),
    simulateRequest('B'),
    simulateRequest('C'),
  ]);

  assert.equal(events.length, 0, 'each scope keeps its own counter');
});

test('track outside of a scope is a no-op', () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 2,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  for (let i = 0; i < 10; i++) {
    det.track({ model: 'User', operation: 'findUnique', args: { where: { id: i } } });
  }
  assert.equal(events.length, 0);
});

test('Express middleware opens scope and captures route/requestId', (t, done) => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 2,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  const mw = det.middleware();
  const req = {
    id: 'req-xyz',
    originalUrl: '/api/posts/1',
    method: 'GET',
    headers: {},
  };
  const res = {};

  mw(req, res, () => {
    det.track({ model: 'Comment', operation: 'findMany', args: { where: { postId: 1 } } });
    det.track({ model: 'Comment', operation: 'findMany', args: { where: { postId: 2 } } });
    assert.equal(events.length, 1);
    assert.equal(events[0].requestId, 'req-xyz');
    assert.equal(events[0].route, '/api/posts/1');
    assert.equal(events[0].method, 'GET');
    done();
  });
});

test('middleware falls back to x-request-id header when req.id missing', (t, done) => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 2,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  const req = {
    url: '/api/x',
    method: 'POST',
    headers: { 'x-request-id': 'header-id' },
  };

  det.middleware()(req, {}, () => {
    det.track({ model: 'A', operation: 'findMany', args: { where: { k: 1 } } });
    det.track({ model: 'A', operation: 'findMany', args: { where: { k: 2 } } });
    assert.equal(events.length, 1);
    assert.equal(events[0].requestId, 'header-id');
    done();
  });
});

test('getWarnings returns newest first and respects buffer cap', () => {
  const det = createNPlusOneDetector({
    threshold: 2,
    logger: silentLogger(),
    maxWarnings: 3,
  });

  for (let r = 0; r < 5; r++) {
    det.runInScope({ requestId: `r-${r}` }, () => {
      det.track({ model: 'M', operation: 'findUnique', args: { where: { id: 1 } } });
      det.track({ model: 'M', operation: 'findUnique', args: { where: { id: 2 } } });
    });
  }

  const ws = det.getWarnings();
  assert.equal(ws.length, 3, 'buffer capped at maxWarnings');
  assert.equal(ws[0].requestId, 'r-4', 'newest first');
  assert.equal(ws[2].requestId, 'r-2');

  const stats = det.getStats();
  assert.equal(stats.warningsTotal, 5);
  assert.equal(stats.warningsBuffered, 3);

  det.reset();
  assert.equal(det.getWarnings().length, 0);
  assert.equal(det.getStats().warningsTotal, 0);
});

test('default logger.warn is invoked when no onWarn supplied', () => {
  const calls = [];
  const det = createNPlusOneDetector({
    threshold: 2,
    logger: { warn: (...args) => calls.push(args) },
  });

  det.runInScope({ requestId: 'r1', route: '/a', method: 'GET' }, () => {
    det.track({ model: 'X', operation: 'findUnique', args: { where: { id: 1 } } });
    det.track({ model: 'X', operation: 'findUnique', args: { where: { id: 2 } } });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '[n+1-detected]');
  const payload = JSON.parse(calls[0][1]);
  assert.equal(payload.requestId, 'r1');
  assert.equal(payload.model, 'X');
  assert.equal(payload.operation, 'findUnique');
  assert.equal(payload.count, 2);
});

test('extension hook triggers track for each Prisma-style invocation', async () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 3,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  const hook = det.extension.query.$allModels.$allOperations;

  await det.runInScope({ requestId: 'ext' }, async () => {
    for (let i = 0; i < 3; i++) {
      await hook({
        model: 'User',
        operation: 'findUnique',
        args: { where: { id: i } },
        query: async (a) => ({ ok: true, args: a }),
      });
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].count, 3);
});

test('onWarn errors are swallowed and do not break tracking', () => {
  const det = createNPlusOneDetector({
    threshold: 2,
    logger: silentLogger(),
    onWarn: () => { throw new Error('listener boom'); },
  });

  assert.doesNotThrow(() => {
    det.runInScope({}, () => {
      det.track({ model: 'M', operation: 'findUnique', args: { where: { id: 1 } } });
      det.track({ model: 'M', operation: 'findUnique', args: { where: { id: 2 } } });
    });
  });
});

test('handles missing args / null where without crashing', () => {
  const events = [];
  const det = createNPlusOneDetector({
    threshold: 3,
    logger: silentLogger(),
    onWarn: (info) => events.push(info),
  });

  det.runInScope({}, () => {
    det.track({ model: 'User', operation: 'count' });
    det.track({ model: 'User', operation: 'count', args: null });
    det.track({ model: 'User', operation: 'count', args: {} });
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'count');
});
