/**
 * stream-resume — covers the SSE resumption token store used by
 * /api/ai/generate. Exercises parse, open/append/complete/fail, replay
 * behaviour, and graceful fallback when no Redis is configured.
 */

'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const streamResume = require('../src/services/ai/stream-resume');

beforeEach(() => {
  streamResume._resetForTests();
});

describe('parseLastEventId', () => {
  test('parses streamId:position', () => {
    const out = streamResume.parseLastEventId('abc-123:7');
    assert.deepEqual(out, { streamId: 'abc-123', position: 7 });
  });
  test('treats bare streamId as position 0', () => {
    assert.deepEqual(streamResume.parseLastEventId('abc-123'), { streamId: 'abc-123', position: 0 });
  });
  test('returns null on garbage', () => {
    assert.equal(streamResume.parseLastEventId(''), null);
    assert.equal(streamResume.parseLastEventId(null), null);
    assert.equal(streamResume.parseLastEventId(':5'), null);
    assert.equal(streamResume.parseLastEventId('abc:-1'), null);
    assert.equal(streamResume.parseLastEventId('abc:notanumber'), null);
  });
});

describe('generateStreamId', () => {
  test('returns a string distinct per call', () => {
    const a = streamResume.generateStreamId();
    const b = streamResume.generateStreamId();
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 8);
    assert.notEqual(a, b);
  });
});

describe('open / append / load (memory fallback)', () => {
  test('open without streamId mints a new session', async () => {
    const session = await streamResume.open({});
    assert.ok(session.streamId);
    assert.equal(session.isResume, false);
    assert.deepEqual(session.record.chunks, []);
  });

  test('append grows the chunk list and load returns it', async () => {
    const { streamId } = await streamResume.open({});
    await streamResume.append(streamId, 'hello ');
    await streamResume.append(streamId, 'world');
    const record = await streamResume.load(streamId);
    assert.deepEqual(record.chunks, ['hello ', 'world']);
  });

  test('open with known streamId resumes the existing record', async () => {
    const first = await streamResume.open({});
    await streamResume.append(first.streamId, 'partial');
    const second = await streamResume.open({ streamId: first.streamId });
    assert.equal(second.isResume, true);
    assert.deepEqual(second.record.chunks, ['partial']);
  });

  test('complete marks the record terminal', async () => {
    const { streamId } = await streamResume.open({});
    await streamResume.append(streamId, 'x');
    await streamResume.complete(streamId);
    const record = await streamResume.load(streamId);
    assert.equal(record.complete, true);
  });

  test('fail stores an error string', async () => {
    const { streamId } = await streamResume.open({});
    await streamResume.fail(streamId, 'upstream_timeout');
    const record = await streamResume.load(streamId);
    assert.equal(record.error, 'upstream_timeout');
  });

  test('destroy removes the record', async () => {
    const { streamId } = await streamResume.open({});
    await streamResume.destroy(streamId);
    assert.equal(await streamResume.load(streamId), null);
  });

  test('append after complete does not grow chunks', async () => {
    const { streamId } = await streamResume.open({});
    await streamResume.append(streamId, 'a');
    await streamResume.complete(streamId);
    await streamResume.append(streamId, 'b');
    const record = await streamResume.load(streamId);
    assert.deepEqual(record.chunks, ['a']);
  });

  test('append ignores empty / non-string payloads', async () => {
    const { streamId } = await streamResume.open({});
    await streamResume.append(streamId, '');
    await streamResume.append(streamId, null);
    await streamResume.append(streamId, undefined);
    const record = await streamResume.load(streamId);
    assert.deepEqual(record.chunks, []);
  });
});

describe('injected redis backend', () => {
  test('uses injected client for get/set/del', async () => {
    const calls = [];
    const fake = {
      store: new Map(),
      async get(k) { calls.push(['get', k]); return this.store.get(k) || null; },
      async set(k, v, _ex, _ttl) { calls.push(['set', k, v]); this.store.set(k, v); return 'OK'; },
      async del(k) { calls.push(['del', k]); this.store.delete(k); return 1; },
    };
    streamResume._setInjectedRedis(fake);

    const session = await streamResume.open({});
    await streamResume.append(session.streamId, 'chunk-1');
    await streamResume.complete(session.streamId);

    // Should have set keys with the sira:sse-resume: prefix
    assert.ok(calls.some(c => c[0] === 'set' && c[1].startsWith('sira:sse-resume:')));
    const stored = await streamResume.load(session.streamId);
    assert.equal(stored.complete, true);
    assert.deepEqual(stored.chunks, ['chunk-1']);
  });

  test('redis errors do not break the request path', async () => {
    const flaky = {
      async get() { throw new Error('boom'); },
      async set() { throw new Error('boom'); },
      async del() { throw new Error('boom'); },
    };
    streamResume._setInjectedRedis(flaky);
    // Should still operate via memory store
    const session = await streamResume.open({});
    const pos = await streamResume.append(session.streamId, 'hi');
    assert.equal(pos, 1);
    const record = await streamResume.load(session.streamId);
    assert.deepEqual(record.chunks, ['hi']);
  });
});
