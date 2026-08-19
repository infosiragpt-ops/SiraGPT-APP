'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createSSEWriter, formatEvent } = require('../src/utils/sse-writer');

/**
 * Mock res that mimics enough of http.ServerResponse for the writer:
 * setHeader, flushHeaders, write (with optional backpressure), end,
 * EventEmitter for drain/close/finish, socket with setNoDelay.
 */
function makeMockRes({ pauseAfter = Infinity } = {}) {
  const res = new EventEmitter();
  res.headers = {};
  res.headersSent = false;
  res.headersFlushed = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writes = [];
  res.bytesWritten = 0;
  res.socket = { setNoDelay: () => { res.socket.noDelay = true; }, noDelay: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.flushHeaders = () => { res.headersFlushed = true; res.headersSent = true; };
  res.write = (chunk) => {
    res.writes.push(chunk);
    res.bytesWritten += Buffer.byteLength(chunk);
    return res.bytesWritten < pauseAfter;
  };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  return res;
}

test('formatEvent serializes object payloads as JSON SSE frames', () => {
  assert.equal(formatEvent({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(formatEvent('raw'), 'data: raw\n\n');
});

test('createSSEWriter sets SSE headers, flushes them, and writes preamble', async () => {
  const res = makeMockRes();
  const sse = createSSEWriter(res, { heartbeatMs: 60_000 });
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.equal(res.headersFlushed, true);
  assert.equal(res.socket.noDelay, true, 'TCP_NODELAY should be set on socket');
  assert.equal(res.writes[0], ': connected\n\n', 'connection preamble forces header flush');
  await sse.event({ token: 'hi' });
  assert.equal(res.writes.at(-1), 'data: {"token":"hi"}\n\n');
  sse.close();
});

test('createSSEWriter awaits drain on backpressure', async () => {
  // Pause after first 8 bytes — the preamble alone (~13 bytes) trips it.
  const res = makeMockRes({ pauseAfter: 8 });
  const sse = createSSEWriter(res, { heartbeatMs: 60_000 });

  let resolved = false;
  const p = sse.event({ x: 'y' }).then(() => { resolved = true; });

  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, 'write should be pending until drain fires');

  res.emit('drain');
  await p;
  assert.equal(resolved, true, 'drain should resolve the pending write');
  sse.close();
});

test('createSSEWriter resolves false once the response closes', async () => {
  const res = makeMockRes({ pauseAfter: 8 });
  const sse = createSSEWriter(res, { heartbeatMs: 60_000 });

  const pending = sse.event({ a: 1 });
  res.destroyed = true;
  res.emit('close');
  const ok = await pending;
  assert.equal(ok, false);
  assert.equal(sse.closed, true);
});

test('done writes [DONE] and ends the response', async () => {
  const res = makeMockRes();
  const sse = createSSEWriter(res, { heartbeatMs: 60_000 });
  await sse.done();
  assert.equal(res.writes.at(-1), 'data: [DONE]\n\n');
  assert.equal(res.writableEnded, true);
});

test('comment frames are sanitized and prefixed', async () => {
  const res = makeMockRes();
  const sse = createSSEWriter(res, { heartbeatMs: 60_000 });
  await sse.comment('hello\nworld');
  assert.equal(res.writes.at(-1), ': hello world\n\n');
  sse.close();
});
