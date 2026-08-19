'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createTokenBucketLimiter } = require('../src/services/rate-limit/token-bucket');

function mk(overrides = {}) {
  let t = 0;
  return {
    rl: createTokenBucketLimiter({ capacity: 5, refillRatePerSec: 1, now: () => t, ...overrides }),
    advance: (ms) => { t += ms; },
    setT: (v) => { t = v; },
  };
}

describe('createTokenBucketLimiter — happy path', () => {
  test('first request allowed, capacity-1 remaining', () => {
    const { rl } = mk();
    const r = rl.tryConsume('user:1');
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 4);
    assert.equal(r.retryAfterMs, 0);
  });

  test('burst up to capacity allowed', () => {
    const { rl } = mk();
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.tryConsume('u').allowed, true);
    }
    assert.equal(rl.tryConsume('u').allowed, false);
  });

  test('different keys have independent buckets', () => {
    const { rl } = mk();
    for (let i = 0; i < 5; i++) rl.tryConsume('a');
    assert.equal(rl.tryConsume('b').allowed, true);
  });
});

describe('createTokenBucketLimiter — refill', () => {
  test('refill restores tokens over time', () => {
    const { rl, advance } = mk({ refillRatePerSec: 2 }); // 2 per sec
    for (let i = 0; i < 5; i++) rl.tryConsume('u');
    assert.equal(rl.tryConsume('u').allowed, false);
    advance(1000); // +1s → +2 tokens
    assert.equal(rl.tryConsume('u').allowed, true);
    assert.equal(rl.tryConsume('u').allowed, true);
    assert.equal(rl.tryConsume('u').allowed, false);
  });

  test('refill caps at capacity', () => {
    const { rl, advance } = mk();
    rl.tryConsume('u');
    advance(60_000); // long idle
    const p = rl.peek('u');
    assert.equal(p.tokens, 5); // capped at capacity, not 60
  });

  test('retryAfterMs reports time until next allowed', () => {
    const { rl } = mk({ capacity: 1, refillRatePerSec: 1 });
    rl.tryConsume('u'); // empties bucket
    const r = rl.tryConsume('u');
    assert.equal(r.allowed, false);
    assert.equal(r.retryAfterMs, 1000);
  });
});

describe('createTokenBucketLimiter — cost > 1', () => {
  test('multi-token consume', () => {
    const { rl } = mk({ capacity: 10 });
    const r = rl.tryConsume('u', 7);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 3);
    assert.equal(rl.tryConsume('u', 5).allowed, false);
  });

  test('cost > capacity denies up front with retryAfter=Infinity', () => {
    const { rl } = mk({ capacity: 5 });
    const r = rl.tryConsume('u', 100);
    assert.equal(r.allowed, false);
    assert.equal(r.retryAfterMs, Infinity);
  });
});

describe('createTokenBucketLimiter — guards + lifecycle', () => {
  test('rejects empty key', () => {
    const { rl } = mk();
    assert.throws(() => rl.tryConsume(''), TypeError);
    assert.throws(() => rl.tryConsume(null), TypeError);
  });

  test('reset wipes a key', () => {
    const { rl } = mk();
    rl.tryConsume('u');
    assert.equal(rl.reset('u'), true);
    assert.equal(rl.peek('u'), null);
  });

  test('peek returns null for unknown key', () => {
    const { rl } = mk();
    assert.equal(rl.peek('never'), null);
  });
});

describe('createTokenBucketLimiter — LRU eviction', () => {
  test('exceeding maxKeys evicts oldest', () => {
    const { rl } = mk({ maxKeys: 2 });
    rl.tryConsume('a'); rl.tryConsume('b'); rl.tryConsume('c');
    assert.equal(rl.snapshot().keys, 2);
    assert.equal(rl.peek('a'), null); // evicted
  });

  test('hits move keys to MRU position', () => {
    const { rl } = mk({ maxKeys: 2 });
    rl.tryConsume('a'); rl.tryConsume('b'); rl.tryConsume('a'); // touch a
    rl.tryConsume('c'); // should evict b, keep a
    assert.ok(rl.peek('a'));
    assert.equal(rl.peek('b'), null);
  });
});

describe('createTokenBucketLimiter — snapshot accounting', () => {
  test('totalAllowed and totalDenied increment correctly', () => {
    const { rl } = mk({ capacity: 1 });
    rl.tryConsume('u'); rl.tryConsume('u'); rl.tryConsume('u');
    const s = rl.snapshot();
    assert.equal(s.totalAllowed, 1);
    assert.equal(s.totalDenied, 2);
  });
});
