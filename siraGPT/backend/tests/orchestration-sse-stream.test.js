'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  attachSSEStream,
  createSSEReplayBuffer,
  writeSSE,
} = require('../src/orchestration/sse-stream');

test('writeSSE formats id, event, and data fields', () => {
  const chunks = [];
  const mockRes = {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
  };
  writeSSE(mockRes, { id: '42', event: 'message', data: { text: 'hello' } });
  assert.ok(chunks.length > 0);
  const combined = chunks.join('');
  assert.ok(combined.includes('id: 42'));
  assert.ok(combined.includes('event: message'));
  assert.ok(combined.includes('"text":"hello"'));
});

test('writeSSE omits optional fields', () => {
  const chunks = [];
  const mockRes = { write(chunk) { chunks.push(chunk); return true; } };
  writeSSE(mockRes, { event: 'ping', data: {} });
  const combined = chunks.join('');
  assert.ok(!combined.includes('id:'));
  assert.ok(combined.includes('event: ping'));
});

test('createSSEReplayBuffer respects max size', () => {
  const buffer = createSSEReplayBuffer({ maxEvents: 3 });
  buffer.push('message', { seq: 1 });
  buffer.push('message', { seq: 2 });
  buffer.push('message', { seq: 3 });
  buffer.push('message', { seq: 4 });
  assert.equal(buffer.size(), 3);
});

test('replay buffer since returns only newer events', () => {
  const buffer = createSSEReplayBuffer({ maxEvents: 10 });
  const evt1 = buffer.push('message', { a: 1 });
  const evt2 = buffer.push('message', { a: 2 });
  buffer.push('message', { a: 3 });

  const replay = buffer.since(evt1.id);
  assert.equal(replay.length, 2);
  assert.deepEqual(replay[0].data, { a: 2 });
  assert.deepEqual(replay[1].data, { a: 3 });
});

test('replay buffer since returns empty for missing id', () => {
  const buffer = createSSEReplayBuffer();
  buffer.push('message', { a: 1 });
  const replay = buffer.since('99999');
  assert.equal(replay.length, 0);
});

test('replay buffer since returns all for no lastEventId', () => {
  const buffer = createSSEReplayBuffer({ maxEvents: 10 });
  buffer.push('message', { a: 1 });
  buffer.push('message', { a: 2 });
  const replay = buffer.since(null);
  assert.equal(replay.length, 0);
});

test('attachSSEStream sets SSE headers', () => {
  const headers = {};
  const mockReq = {
    headers: {},
    on() {},
  };
  const mockRes = {
    setHeader(name, value) { headers[name] = value; },
    flushHeaders() {},
    write() { return true; },
    end() {},
  };
  const stream = attachSSEStream(mockReq, mockRes);
  assert.equal(headers['Content-Type'], 'text/event-stream');
  assert.equal(headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(headers['Connection'], 'keep-alive');
  assert.ok(typeof stream.send === 'function');
  assert.ok(typeof stream.end === 'function');
});

test('attachSSEStream sends events from replay buffer', () => {
  const headers = {};
  const writes = [];
  const mockReq = {
    headers: { 'last-event-id': '0' },
    on() {},
  };
  const mockRes = {
    setHeader(name, value) { headers[name] = value; },
    flushHeaders() {},
    write(chunk) { writes.push(chunk); return true; },
    end() {},
  };
  const buffer = createSSEReplayBuffer({ maxEvents: 10 });
  buffer.push('message', { hello: 'world' });
  const stream = attachSSEStream(mockReq, mockRes, buffer);
  assert.ok(writes.length >= 1);
  stream.end();
});

test('Replay buffer IDs are monotonic integers', () => {
  const buffer = createSSEReplayBuffer({ maxEvents: 10 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(Number(buffer.push('msg', {}).id));
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} should be > ${ids[i - 1]}`);
  }
});
