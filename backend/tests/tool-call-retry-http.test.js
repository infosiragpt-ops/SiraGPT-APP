'use strict';

// Transport integration lane: real loopback HTTP, the production retry
// wrapper/classifier/backoff, and synthetic server-owned state. No provider,
// database, persistence, or production deployment claims are made here.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getEventListeners } = require('node:events');
const { runToolWithRetry } = require('../src/services/agents/tool-call-retry');
const { classifyTaskError } = require('../src/utils/task-error-classifier');

async function listenLoopback(t, handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    assert.equal(server.listening, false);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return `http://127.0.0.1:${address.port}`;
}

function requestJson(url, { signal, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      signal, method, agent: false,
      headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {},
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > 1024) { res.destroy(new Error('synthetic response too large')); return; }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => {
        if (res.statusCode !== 200) {
          const error = new Error(`HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.setTimeout(2000, () => req.destroy(Object.assign(new Error('synthetic HTTP deadline'), { code: 'ETIMEDOUT' })));
    req.end(bytes);
  });
}

test('explicitly retry-safe read recovers from a real classified HTTP 503', { timeout: 20000 }, async (t) => {
  let received = 0;
  const address = await listenLoopback(t, (_req, res) => {
    received += 1;
    res.writeHead(received === 1 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received === 1 ? { error: 'synthetic unavailability' } : { value: 'recovered' }));
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const retries = [];
  const out = await runToolWithRetry((_args, ctx) => {
    assert.equal(ctx.signal, controller.signal);
    return requestJson(address, { signal: ctx.signal });
  }, {}, { signal: controller.signal }, {
    retrySafe: true, maxRetries: 1, onRetry: (info) => retries.push(info),
  });
  assert.deepEqual(out, { value: 'recovered' });
  assert.equal(received, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].reason, 'server-error');
});

test('a mutation committed before a real connection reset is attempted only once by default', { timeout: 5000 }, async (t) => {
  const committed = [];
  let received = 0;
  const address = await listenLoopback(t, async (req) => {
    received += 1;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      assert.ok(bytes <= 1024);
      chunks.push(chunk);
    }
    committed.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    // The side effect has happened, but its acknowledgment never reaches
    // the client. Retrying this request would duplicate the mutation.
    req.socket.destroy();
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  let retryEvents = 0;
  await assert.rejects(runToolWithRetry((_args, ctx) => {
    assert.equal(ctx.signal, controller.signal);
    return requestJson(address, { signal: ctx.signal, method: 'POST', body: { operation: 'synthetic-commit' } });
  }, {}, { signal: controller.signal }, {
    maxRetries: 3, onRetry: () => { retryEvents += 1; },
  }), (error) => {
    assert.equal(error.code, 'ECONNRESET');
    assert.equal(classifyTaskError(error).retryable, true, 'transport failure alone is not retry authorization');
    return true;
  });
  assert.equal(received, 1);
  assert.deepEqual(committed, [{ operation: 'synthetic-commit' }]);
  assert.equal(retryEvents, 0);
});

test('Stop interrupts real HTTP read backoff without dispatching another request', { timeout: 5000 }, async (t) => {
  let received = 0;
  const address = await listenLoopback(t, (_req, res) => {
    received += 1;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'synthetic unavailability' }));
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const reason = Object.assign(new Error('synthetic user Stop'), { code: 'E_CANCELLED' });
  let signalBackoff;
  const backoff = new Promise((resolve) => { signalBackoff = resolve; });
  const operation = runToolWithRetry((_args, ctx) => {
    assert.equal(ctx.signal, controller.signal);
    return requestJson(address, { signal: ctx.signal });
  }, {}, { signal: controller.signal }, { retrySafe: true, maxRetries: 1, onRetry: signalBackoff });
  const rejected = assert.rejects(operation, (error) => error === reason);
  const info = await backoff;
  assert.equal(info.reason, 'server-error');
  assert.ok(getEventListeners(controller.signal, 'abort').length >= 1, 'real backoff observes the original Stop signal');
  controller.abort(reason);
  await rejected;
  await new Promise(setImmediate);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(received, 1);
});
