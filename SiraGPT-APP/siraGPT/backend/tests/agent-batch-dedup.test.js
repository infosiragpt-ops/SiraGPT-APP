const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

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

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('agent-batch dedup', () => {
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

  test('computeTaskHash matches semantically equal tasks and differs otherwise', () => {
    const { computeTaskHash } = route.INTERNAL;
    const a = computeTaskHash({ goal: 'Write report', model: 'gpt-4o', files: [{ id: 'f1' }, { id: 'f2' }] });
    const b = computeTaskHash({ goal: 'Write report', model: 'gpt-4o', files: [{ id: 'f2' }, { id: 'f1' }] });
    assert.equal(a, b, 'file order should not affect hash');

    const c = computeTaskHash({ goal: 'Write report', model: 'gpt-4o', files: [{ id: 'f1' }, { id: 'f2' }], displayGoal: 'cosmetic' });
    assert.equal(a, c, 'displayGoal must not affect hash');

    const d = computeTaskHash({ goal: 'Write report', model: 'gpt-4o', files: [{ id: 'f1' }, { id: 'f3' }] });
    assert.notEqual(a, d, 'different files should hash differently');

    const e = computeTaskHash({ goal: 'Write report', model: 'gpt-4o-mini', files: [{ id: 'f1' }, { id: 'f2' }] });
    assert.notEqual(a, e, 'different model should hash differently');
  });

  test('runs duplicate tasks once and shares the result with followers', async () => {
    let calls = 0;
    route.INTERNAL.setRunner(async (task) => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, summary: `done:${task.goal}`, callIndex: calls };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [
        { goal: 'duplicate goal', model: 'gpt-4o' },
        { goal: 'duplicate goal', model: 'gpt-4o' },
        { goal: 'duplicate goal', model: 'gpt-4o' },
        { goal: 'unique goal', model: 'gpt-4o' },
      ],
      options: { concurrency: 1 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    // Only 2 actual runner invocations: leader of duplicates + the unique goal.
    assert.equal(calls, 2, `expected 2 runner calls, got ${calls}`);

    const dedupedEvents = res.events.filter((e) => e.type === 'deduped');
    assert.equal(dedupedEvents.length, 2, 'expected two follower deduped events');
    for (const evt of dedupedEvents) {
      assert.ok(evt.hash, 'deduped event carries hash');
      assert.ok(typeof evt.leaderTaskId === 'string' && evt.leaderTaskId.length > 0);
    }

    const doneEvents = res.events.filter((e) => e.type === 'done');
    assert.equal(doneEvents.length, 4, 'every task emits a done event');
    const dupResults = doneEvents.filter((e) => e.result && e.result.summary === 'done:duplicate goal');
    assert.equal(dupResults.length, 3, 'all duplicates share the leader result');
    // The leader's callIndex should be the same across all three duplicates.
    const callIndexes = new Set(dupResults.map((e) => e.result.callIndex));
    assert.equal(callIndexes.size, 1, 'duplicates share the same callIndex from one runner invocation');

    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.ok, 4);
    assert.equal(summary.failed, 0);
    assert.equal(summary.deduped, 2);
  });

  test('followers mirror leader error without re-running the runner', async () => {
    let calls = 0;
    route.INTERNAL.setRunner(async () => {
      calls++;
      throw new Error('boom');
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [
        { goal: 'same failing goal' },
        { goal: 'same failing goal' },
      ],
      options: { concurrency: 1, failFast: false },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    assert.equal(calls, 1, 'runner should be invoked exactly once');
    const errors = res.events.filter((e) => e.type === 'error');
    assert.equal(errors.length, 2);
    assert.equal(errors[0].error.message, 'boom');
    assert.equal(errors[1].error.message, 'boom');
    assert.equal(errors[1].deduped, true);
    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.failed, 2);
  });

  test('options.dedupe=false disables sharing and runs every task', async () => {
    let calls = 0;
    route.INTERNAL.setRunner(async () => {
      calls++;
      return { ok: true };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: [
        { goal: 'same goal' },
        { goal: 'same goal' },
        { goal: 'same goal' },
      ],
      options: { dedupe: false, concurrency: 1 },
    }, { Authorization: auth.authHeader });

    assert.equal(calls, 3);
    assert.equal(res.events.filter((e) => e.type === 'deduped').length, 0);
    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.ok, 3);
    assert.equal(summary.deduped, 0);
  });

  test('dedup is race-safe under concurrent dispatch', async () => {
    let calls = 0;
    route.INTERNAL.setRunner(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, n: calls };
    });

    const res = await postSseAndCollect(server, '/api/agent/batch', {
      tasks: Array.from({ length: 5 }, () => ({ goal: 'identical goal', model: 'gpt-4o' })),
      options: { concurrency: 5 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    assert.equal(calls, 1, 'concurrent identical tasks should still share one runner call');
    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.ok, 5);
    assert.equal(summary.deduped, 4);
  });
});
