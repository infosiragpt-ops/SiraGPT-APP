'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createSseReplayBuffer,
  createReplayRegistry,
  StreamClosedError,
} = require('../src/services/ai-product-os/sse-replay-buffer');

describe('createSseReplayBuffer — append', () => {
  test('append assigns monotonic ids starting at 1', () => {
    const b = createSseReplayBuffer({});
    assert.equal(b.append({ data: 'a' }), 1);
    assert.equal(b.append({ data: 'b' }), 2);
    assert.equal(b.append({ data: 'c' }), 3);
  });

  test('explicit id >= nextId is honored', () => {
    const b = createSseReplayBuffer({});
    assert.equal(b.append({ data: 'a', id: 100 }), 100);
    assert.equal(b.append({ data: 'b' }), 101);
  });

  test('explicit id below nextId is ignored (re-numbered)', () => {
    const b = createSseReplayBuffer({});
    b.append({ data: 'a' }); // id 1
    b.append({ data: 'b' }); // id 2
    const id = b.append({ data: 'c', id: 1 });
    assert.equal(id, 3);
  });

  test('append on closed buffer throws StreamClosedError', () => {
    const b = createSseReplayBuffer({});
    b.close();
    assert.throws(() => b.append({ data: 'x' }), StreamClosedError);
  });
});

describe('createSseReplayBuffer — replayFrom', () => {
  test('returns events with id strictly greater than lastEventId', () => {
    const b = createSseReplayBuffer({});
    b.append({ data: 'a' }); b.append({ data: 'b' }); b.append({ data: 'c' });
    const got = b.replayFrom(1);
    assert.deepEqual(got.map((e) => e.data), ['b', 'c']);
  });

  test('returns full buffer when lastEventId is unparseable', () => {
    const b = createSseReplayBuffer({});
    b.append({ data: 'a' }); b.append({ data: 'b' });
    const got = b.replayFrom('garbage');
    assert.equal(got.length, 2);
  });

  test('returns empty array when client is already current', () => {
    const b = createSseReplayBuffer({});
    b.append({ data: 'a' });
    assert.deepEqual(b.replayFrom(99), []);
  });

  test('counts replayed events in snapshot', () => {
    const b = createSseReplayBuffer({});
    b.append({ data: 'a' }); b.append({ data: 'b' });
    b.replayFrom(0);
    assert.equal(b.snapshot().totalReplayed, 2);
  });
});

describe('createSseReplayBuffer — capacity + ttl', () => {
  test('exceeding capacity drops oldest', () => {
    const b = createSseReplayBuffer({ capacity: 3 });
    b.append({ data: 'a' });
    b.append({ data: 'b' });
    b.append({ data: 'c' });
    b.append({ data: 'd' });
    assert.equal(b.size(), 3);
    const got = b.replayFrom(0);
    assert.deepEqual(got.map((e) => e.data), ['b', 'c', 'd']);
  });

  test('events older than ttlMs are pruned on append', () => {
    let t = 0;
    const b = createSseReplayBuffer({ ttlMs: 1000, now: () => t });
    b.append({ data: 'old' });
    t = 5000;
    b.append({ data: 'new' });
    assert.equal(b.size(), 1);
    assert.equal(b.replayFrom(0)[0].data, 'new');
  });
});

describe('createSseReplayBuffer — snapshot', () => {
  test('reports oldest/newest ids and counters', () => {
    const b = createSseReplayBuffer({});
    b.append({ data: 'a' }); b.append({ data: 'b' });
    const s = b.snapshot();
    assert.equal(s.oldest, 1);
    assert.equal(s.newest, 2);
    assert.equal(s.totalAppended, 2);
    assert.equal(s.closed, false);
  });

  test('null oldest/newest on empty buffer', () => {
    const b = createSseReplayBuffer({});
    const s = b.snapshot();
    assert.equal(s.oldest, null);
    assert.equal(s.newest, null);
  });
});

describe('createReplayRegistry', () => {
  test('openStream creates fresh buffer; same id returns same buffer', () => {
    const reg = createReplayRegistry({});
    const a = reg.openStream('s1');
    const b = reg.openStream('s1');
    assert.equal(a, b);
  });

  test('closing a stream and re-opening starts a new buffer', () => {
    const reg = createReplayRegistry({});
    const a = reg.openStream('s1');
    a.append({ data: 'first' });
    reg.closeStream('s1');
    const b = reg.openStream('s1');
    assert.notEqual(a, b);
  });

  test('replayFrom on unknown stream returns empty array', () => {
    const reg = createReplayRegistry({});
    assert.deepEqual(reg.replayFrom('nope', 0), []);
  });

  test('gc removes closed empty streams', () => {
    const reg = createReplayRegistry({});
    reg.openStream('s1').close();
    reg.openStream('s2').append({ data: 'x' });
    const removed = reg.gc();
    assert.ok(removed >= 1);
    assert.ok(reg.snapshot().streams >= 1); // s2 still kept
  });

  test('openStream rejects empty id', () => {
    const reg = createReplayRegistry({});
    assert.throws(() => reg.openStream(''), TypeError);
  });
});
