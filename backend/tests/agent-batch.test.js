const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');
const prisma = require('../src/config/database');

// ── Tiny SSE client ──────────────────────────────────────────────
// Drives a real HTTP request against an ephemeral server and parses
// `data:` lines into structured events. Mirrors what supertest does
// for non-streaming routes, but supertest buffers the body which
// loses ordering signal we rely on here.
function postSseAndCollect(server, path, body, headers = {}) {
  const port = server.address().port;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = chunks.join('');
        const events = raw
          .split('\n\n')
          .map((line) => line.replace(/^data:\s*/, '').trim())
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line); } catch { return { _raw: line }; }
          });
        resolve({ status: res.statusCode, headers: res.headers, events, raw });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function postJson(server, path, body, headers = {}) {
  const port = server.address().port;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = chunks.join('');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('POST /api/agent/batch', () => {
  let auth;
  let server;
  let route;

  beforeEach(async () => {
    auth = installAuthSessionMock();
    route = reloadModule('../src/routes/agent-batch');
    const app = buildRouteTestApp('/api/agent', route);
    server = await listen(app);
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    auth.restore();
    route.INTERNAL.setRunner(route.INTERNAL.defaultRunner);
  });

  test('rejects unauthenticated requests', async () => {
    const res = await postJson(server, '/api/agent/batch', {
      tasks: [{ goal: 'Hello world' }],
    });
    assert.equal(res.status, 401);
  });

  test('validates body and rejects empty/oversized batches', async () => {
    const empty = await postJson(server, '/api/agent/batch', { tasks: [] }, { Authorization: auth.authHeader });
    assert.equal(empty.status, 400);
    assert.ok(Array.isArray(empty.body.errors));

    const tooMany = await postJson(server, '/api/agent/batch', {
      tasks: Array.from({ length: route.INTERNAL.limits.MAX_TASKS_PER_BATCH + 1 }, () => ({ goal: 'ok task' })),
    }, { Authorization: auth.authHeader });
    assert.equal(tooMany.status, 400);

    const badGoal = await postJson(server, '/api/agent/batch', {
      tasks: [{ goal: 'no' }],
    }, { Authorization: auth.authHeader });
    assert.equal(badGoal.status, 400);
  });

  test('runs all tasks and emits started/done plus batch_done summary', async () => {
    const seen = [];
    route.INTERNAL.setRunner(async (task, ctx) => {
      seen.push(task.goal);
      assert.ok(ctx.signal instanceof AbortSignal);
      ctx.onProgress({ stage: 'thinking', goal: task.goal });
      // Tiny async tick so scheduling is observable.
      await new Promise((r) => setImmediate(r));
      return { ok: true, summary: `done:${task.goal}` };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [
        { goal: 'task one' },
        { goal: 'task two' },
        { goal: 'task three' },
      ],
      options: { concurrency: 2 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const types = res.events.map((e) => e.type);
    const meta = res.events.find((e) => e.type === 'batch_meta');
    assert.equal(meta.total, 3);
    assert.equal(meta.concurrency, 2);

    assert.equal(types.filter((t) => t === 'started').length, 3);
    assert.equal(types.filter((t) => t === 'done').length, 3);
    assert.equal(types.filter((t) => t === 'progress').length, 3);

    const last = res.events[res.events.length - 1];
    assert.equal(last.type, 'batch_done');
    assert.equal(last.summary.ok, 3);
    assert.equal(last.summary.failed, 0);
    assert.equal(last.summary.cancelled, 0);
    assert.equal(last.summary.total, 3);

    assert.deepEqual(seen.sort(), ['task one', 'task three', 'task two']);
  });

  test('respects concurrency limit (no more than N tasks in-flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    route.INTERNAL.setRunner(async (task) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: Array.from({ length: 6 }, (_, i) => ({ goal: `task ${i}` })),
      options: { concurrency: 2 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    assert.ok(peak <= 2, `expected peak <= 2, got ${peak}`);
    const done = res.events.filter((e) => e.type === 'done').length;
    assert.equal(done, 6);
  });

  test('failFast aborts pending tasks once one fails', async () => {
    let started = 0;
    route.INTERNAL.setRunner(async (task, ctx) => {
      started++;
      if (task.goal === 'boom') {
        throw new Error('intentional failure');
      }
      // Long-running so fail-fast can interrupt before we resolve.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
      return { ok: true };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [
        { goal: 'slow 1' },
        { goal: 'boom' },
        { goal: 'slow 2' },
        { goal: 'slow 3' },
      ],
      options: { concurrency: 2, failFast: true },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.failed, 1);
    assert.ok(summary.cancelled >= 1, `expected >=1 cancelled, got ${summary.cancelled}`);
    assert.equal(summary.ok + summary.failed + summary.cancelled, summary.total);
    // Should have stopped before dispatching all 4.
    assert.ok(started <= 4);
  });

  test('per-task timeout fires when runner exceeds budget', async () => {
    route.INTERNAL.setRunner(async (task, ctx) => {
      await new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
      return { ok: true };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [{ goal: 'will time out' }],
      options: { timeoutMs: 1000 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    const errEvt = res.events.find((e) => e.type === 'error');
    assert.ok(errEvt, 'expected error event after timeout');
    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.failed + summary.cancelled, 1);
  });

  test('reports per-task errors without aborting the batch when failFast=false', async () => {
    route.INTERNAL.setRunner(async (task) => {
      if (task.goal === 'bad') throw new Error('nope');
      return { ok: true };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [
        { goal: 'good 1' },
        { goal: 'bad' },
        { goal: 'good 2' },
      ],
      options: { concurrency: 1, failFast: false },
    }, { Authorization: auth.authHeader });

    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.ok, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, 0);
    const errEvt = res.events.find((e) => e.type === 'error');
    assert.equal(errEvt.error.message, 'nope');
  });

  test('enforces plan quota: FREE user over daily cap is 429ed before any runner runs', async () => {
    // FREE plan is metered at FREE_CALL_LIMIT (3) daily calls. Mock the
    // apiUsage count high so the plan-quota snapshot reports `exceeded`.
    const freeAuth = installAuthSessionMock({ plan: 'FREE', id: 'free-user-1' });
    const prevEnforced = process.env.PLAN_QUOTAS_ENFORCED;
    process.env.PLAN_QUOTAS_ENFORCED = 'true';
    const originalCount = prisma.apiUsage && prisma.apiUsage.count;
    if (!prisma.apiUsage) prisma.apiUsage = {};
    prisma.apiUsage.count = async () => 99;

    const freeRoute = reloadModule('../src/routes/agent-batch');
    let runnerCalls = 0;
    freeRoute.INTERNAL.setRunner(async () => {
      runnerCalls++;
      return { ok: true };
    });
    const freeApp = buildRouteTestApp('/api/agent', freeRoute);
    const freeServer = await listen(freeApp);

    try {
      const res = await postJson(freeServer, '/api/agent/batch', {
        tasks: [{ goal: 'expensive batch task' }],
      }, { Authorization: freeAuth.authHeader });

      assert.equal(res.status, 429);
      assert.equal(res.body.plan, 'FREE');
      assert.equal(res.body.surface, 'agent.batch');
      assert.equal(runnerCalls, 0, 'runner must not be invoked when quota is exceeded');
    } finally {
      await new Promise((r) => freeServer.close(r));
      freeRoute.INTERNAL.setRunner(freeRoute.INTERNAL.defaultRunner);
      freeAuth.restore();
      if (originalCount) prisma.apiUsage.count = originalCount;
      else delete prisma.apiUsage.count;
      if (prevEnforced === undefined) delete process.env.PLAN_QUOTAS_ENFORCED;
      else process.env.PLAN_QUOTAS_ENFORCED = prevEnforced;
    }
  });
});
