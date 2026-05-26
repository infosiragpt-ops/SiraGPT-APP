'use strict';

const test = require('node:test');
const assert = require('node:assert');

const emitter = require('../src/services/attribution-stream-emitter');

function mockRes() {
  const writes = [];
  const listeners = {};
  let headersSent = false;
  let ended = false;
  const headers = {};
  return {
    headers, writes, listeners,
    setHeader: (k, v) => { headers[k] = v; },
    flushHeaders: () => { headersSent = true; },
    write: (chunk) => { writes.push(chunk); return true; },
    end: () => { ended = true; },
    on: (event, fn) => { listeners[event] = fn; },
    get headersSent() { return headersSent; },
    get writableEnded() { return ended; },
  };
}

test('formatEvent: correct SSE shape', () => {
  const evt = emitter.formatEvent('stage.start', { foo: 'bar' });
  assert.ok(evt.includes('event: stage.start'));
  assert.ok(evt.includes('data: {"foo":"bar"}'));
  assert.ok(evt.endsWith('\n\n'));
});

test('formatEvent: undefined payload → null', () => {
  assert.ok(emitter.formatEvent('x').includes('data: null'));
});

test('isWritable: false for null / ended / destroyed', () => {
  assert.strictEqual(emitter.isWritable(null), false);
  assert.strictEqual(emitter.isWritable({ writableEnded: true, write: () => {} }), false);
  assert.strictEqual(emitter.isWritable({ destroyed: true, write: () => {} }), false);
});

test('isWritable: true for healthy res', () => {
  assert.strictEqual(emitter.isWritable({ write: () => {} }), true);
});

test('createStream: sets SSE headers', () => {
  const res = mockRes();
  emitter.createStream(res);
  assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
});

test('createStream: skipHeaders=true does not set them', () => {
  const res = mockRes();
  emitter.createStream(res, { skipHeaders: true });
  assert.strictEqual(res.headers['Content-Type'], undefined);
});

test('emit: writes SSE line + records history', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  assert.strictEqual(stream.emit('greeting', { hello: 'world' }), true);
  assert.ok(res.writes.some((w) => w.includes('event: greeting')));
  const h = stream.history();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].eventName, 'greeting');
});

test('stageStart + stageEnd emit .start / .done', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  stream.stageStart('concepts');
  stream.stageEnd('concepts', { count: 4 });
  const events = stream.history().map((e) => e.eventName);
  assert.ok(events.includes('concepts.start'));
  assert.ok(events.includes('concepts.done'));
});

test('error: emits error event', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  stream.error(new Error('boom'));
  const last = stream.history().pop();
  assert.strictEqual(last.eventName, 'error');
  assert.strictEqual(last.data.message, 'boom');
});

test('history capped at historyCap (min floor 8)', () => {
  const res = mockRes();
  const stream = emitter.createStream(res, { historyCap: 10 });
  for (let i = 0; i < 30; i += 1) stream.emit('tick', { i });
  assert.ok(stream.history().length <= 10);
});

test('close: writes close event and marks closed', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  stream.close();
  assert.ok(res.writes.some((w) => w.includes('event: close')));
  assert.strictEqual(stream.isClosed(), true);
  assert.strictEqual(stream.emit('after', {}), false);
});

test('emit: false when res.write throws', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  res.write = () => { throw new Error('socket gone'); };
  assert.strictEqual(stream.emit('x', {}), false);
});

test('response close listener triggers stream.close', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  res.listeners.close?.();
  assert.strictEqual(stream.isClosed(), true);
});

test('heartbeat writes a colon line', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  res.writes.length = 0;
  stream.heartbeat();
  assert.ok(res.writes.some((w) => w.startsWith(':')));
});

test('hot path: 500 emits under 200ms', () => {
  const res = mockRes();
  const stream = emitter.createStream(res);
  const t0 = Date.now();
  for (let i = 0; i < 500; i += 1) stream.emit('tick', { i });
  assert.ok(Date.now() - t0 < 200);
});
