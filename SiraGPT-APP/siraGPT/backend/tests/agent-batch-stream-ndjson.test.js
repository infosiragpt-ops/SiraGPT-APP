const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

// Collect an NDJSON response into structured events. Each line is one
// JSON object; we also track the order in which lines are flushed so
// tests can assert that early tasks emit a `done` event before later
// (slower) tasks finish.
function postNdjsonAndCollect(server, path, body, headers = {}) {
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
      let buf = '';
      const events = [];
      const arrivalOrder = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch { parsed = { _raw: line }; }
          events.push(parsed);
          arrivalOrder.push({ event: parsed, atMs: Date.now() });
        }
      });
      res.on('end', () => {
        const tail = buf.trim();
        if (tail) {
          try { events.push(JSON.parse(tail)); } catch { events.push({ _raw: tail }); }
        }
        resolve({ status: res.statusCode, headers: res.headers, events, arrivalOrder });
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

describe('POST /api/agent/batch (stream=ndjson)', () => {
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

  test('pickStreamMode resolves stream:true and stream:"ndjson" to ndjson', () => {
    const { pickStreamMode } = route.INTERNAL;
    assert.equal(pickStreamMode({ stream: true }), 'ndjson');
    assert.equal(pickStreamMode({ stream: 'ndjson' }), 'ndjson');
    assert.equal(pickStreamMode({ stream: 'JSONL' }), 'ndjson');
    assert.equal(pickStreamMode({ options: { stream: true } }), 'ndjson');
    assert.equal(pickStreamMode({ stream: 'sse' }), 'sse');
    assert.equal(pickStreamMode({}), 'sse');
    assert.equal(pickStreamMode({ stream: false }), 'sse');
  });

  test('emits NDJSON content-type and one JSON object per task event', async () => {
    route.INTERNAL.setRunner(async (task) => {
      await new Promise((r) => setImmediate(r));
      return { ok: true, summary: `done:${task.goal}` };
    });

    const res = await postNdjsonAndCollect(server, '/api/agent/batch', {
      stream: true,
      tasks: [
        { goal: 'task one' },
        { goal: 'task two' },
        { goal: 'task three' },
      ],
      options: { concurrency: 2 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/x-ndjson/);

    // No `data:` SSE prefixes leak through.
    for (const ev of res.events) {
      assert.equal(typeof ev, 'object');
      assert.ok(!('_raw' in ev), `unparsable line: ${ev._raw}`);
    }

    const meta = res.events[0];
    assert.equal(meta.type, 'batch_meta');
    assert.equal(meta.stream, 'ndjson');
    assert.equal(meta.total, 3);

    const types = res.events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'started').length, 3);
    assert.equal(types.filter((t) => t === 'done').length, 3);

    const last = res.events[res.events.length - 1];
    assert.equal(last.type, 'batch_done');
    assert.equal(last.summary.ok, 3);
    assert.equal(last.summary.total, 3);
  });

  test('emits NDJSON via options.stream:true as well', async () => {
    route.INTERNAL.setRunner(async () => ({ ok: true }));

    const res = await postNdjsonAndCollect(server, '/api/agent/batch', {
      tasks: [{ goal: 'a single task' }],
      options: { stream: true },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/x-ndjson/);
    const meta = res.events.find((e) => e.type === 'batch_meta');
    assert.equal(meta.stream, 'ndjson');
  });

  test('emits a `done` event per task as it finishes (incremental)', async () => {
    // First task finishes fast, second task is slow. With concurrency=2
    // we should see the fast task's `done` arrive strictly before the
    // slow task's `done`.
    route.INTERNAL.setRunner(async (task) => {
      const delay = task.goal === 'fast' ? 10 : 150;
      await new Promise((r) => setTimeout(r, delay));
      return { ok: true, label: task.goal };
    });

    const res = await postNdjsonAndCollect(server, '/api/agent/batch', {
      stream: true,
      tasks: [
        { goal: 'slow' },
        { goal: 'fast' },
      ],
      options: { concurrency: 2 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);

    const fastDone = res.arrivalOrder.find(
      (e) => e.event.type === 'done' && e.event.result?.label === 'fast'
    );
    const slowDone = res.arrivalOrder.find(
      (e) => e.event.type === 'done' && e.event.result?.label === 'slow'
    );
    assert.ok(fastDone && slowDone, 'expected both done events');
    assert.ok(
      fastDone.atMs < slowDone.atMs,
      `expected fast.done (${fastDone.atMs}) to arrive before slow.done (${slowDone.atMs})`
    );

    // The fast task's `done` should arrive before the batch finishes —
    // i.e. there is at least one event after it.
    const fastIdx = res.events.findIndex(
      (e) => e.type === 'done' && e.result?.label === 'fast'
    );
    assert.ok(fastIdx > 0 && fastIdx < res.events.length - 1);
  });

  test('error events still serialize as one JSON line each in NDJSON mode', async () => {
    route.INTERNAL.setRunner(async (task) => {
      if (task.goal === 'bad') throw new Error('kaboom');
      return { ok: true };
    });

    const res = await postNdjsonAndCollect(server, '/api/agent/batch', {
      stream: true,
      tasks: [
        { goal: 'good' },
        { goal: 'bad' },
      ],
      options: { concurrency: 1 },
    }, { Authorization: auth.authHeader });

    assert.equal(res.status, 200);
    const errEvt = res.events.find((e) => e.type === 'error');
    assert.ok(errEvt);
    assert.equal(errEvt.error.message, 'kaboom');
    const summary = res.events.find((e) => e.type === 'batch_done').summary;
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 1);
  });

  test('legacy SSE mode is preserved when stream is omitted', async () => {
    route.INTERNAL.setRunner(async () => ({ ok: true }));

    // Re-use http directly so we can read the raw body and confirm the
    // SSE `data:` framing is intact.
    const port = server.address().port;
    const payload = JSON.stringify({ tasks: [{ goal: 'legacy sse task' }] });
    const raw = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST',
        host: '127.0.0.1',
        port,
        path: '/api/agent/batch',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: auth.authHeader,
        },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    assert.equal(raw.status, 200);
    assert.match(raw.headers['content-type'], /text\/event-stream/);
    assert.match(raw.body, /^data: \{/m);
  });
});
