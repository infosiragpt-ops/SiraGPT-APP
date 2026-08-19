/**
 * Tests for channels/dedup-cache.js — TTL-bounded inbound message
 * dedup cache used by channel adapters.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { DedupCache } = require('../src/channels/dedup-cache');

// A controllable clock so we don't have to rely on real time.
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    reset: () => { t = start; },
  };
}

describe('DedupCache · constructor + defaults', () => {
  it('starts empty', () => {
    const c = new DedupCache();
    assert.equal(c.size(), 0);
    assert.equal(c.has('anything'), false);
  });

  it('uses the supplied clock', () => {
    const clock = makeClock();
    const c = new DedupCache({ now: clock.now, ttlMs: 1000 });
    c.add('m1');
    clock.advance(500);
    assert.equal(c.has('m1'), true);
    clock.advance(600);  // total 1100ms — past 1000ms TTL
    assert.equal(c.has('m1'), false);
  });
});

describe('DedupCache · add()', () => {
  it('returns true on first add, false on re-add', () => {
    const c = new DedupCache({ ttlMs: 60_000 });
    assert.equal(c.add('m1'), true);
    assert.equal(c.add('m1'), false);
    assert.equal(c.add('m2'), true);
  });

  it('keeps the original timestamp on re-add (dedup, no refresh)', () => {
    const clock = makeClock();
    const c = new DedupCache({ now: clock.now, ttlMs: 1000 });
    c.add('m1');  // t=1_000_000
    clock.advance(500);
    c.add('m1');  // should NOT refresh ts to t=1_000_500
    clock.advance(600);  // total elapsed since FIRST add = 1100ms
    // If timestamp refreshed, m1 would still be alive (only 600ms after refresh).
    // If preserved (the right behavior), m1 is dead.
    assert.equal(c.has('m1'), false, 'dedup must preserve original ts, not refresh');
  });
});

describe('DedupCache · has()', () => {
  it('returns false for never-seen keys', () => {
    const c = new DedupCache();
    assert.equal(c.has('never'), false);
  });

  it('returns true for live keys', () => {
    const c = new DedupCache({ ttlMs: 60_000 });
    c.add('m1');
    assert.equal(c.has('m1'), true);
  });

  it('returns false AND removes expired keys on access (lazy eviction)', () => {
    const clock = makeClock();
    const c = new DedupCache({ now: clock.now, ttlMs: 100 });
    c.add('m1');
    assert.equal(c.size(), 1);
    clock.advance(200);
    assert.equal(c.has('m1'), false);
    assert.equal(c.size(), 0, 'expired key must be removed by has()');
  });
});

describe('DedupCache · expiration sweep on add()', () => {
  it('sweeps expired entries during add()', () => {
    const clock = makeClock();
    const c = new DedupCache({ now: clock.now, ttlMs: 100 });
    c.add('m1');
    c.add('m2');
    clock.advance(150);
    c.add('m3');  // triggers _evictExpired()
    assert.equal(c.has('m1'), false);
    assert.equal(c.has('m2'), false);
    assert.equal(c.has('m3'), true);
    assert.equal(c.size(), 1);
  });

  it('does not evict still-live entries', () => {
    const clock = makeClock();
    const c = new DedupCache({ now: clock.now, ttlMs: 1000 });
    c.add('m1');
    clock.advance(500);
    c.add('m2');
    clock.advance(300);
    c.add('m3');  // m1 has 800ms elapsed, m2 has 300ms — both still live
    assert.equal(c.size(), 3);
  });
});

describe('DedupCache · maxSize cap', () => {
  it('evicts oldest when maxSize exceeded', () => {
    const c = new DedupCache({ ttlMs: 60_000, maxSize: 3 });
    c.add('m1');
    c.add('m2');
    c.add('m3');
    assert.equal(c.size(), 3);
    c.add('m4');  // pushes m1 out
    assert.equal(c.has('m1'), false);
    assert.equal(c.has('m2'), true);
    assert.equal(c.has('m3'), true);
    assert.equal(c.has('m4'), true);
    assert.equal(c.size(), 3);
  });

  it('keeps size at exactly maxSize after many adds', () => {
    const c = new DedupCache({ ttlMs: 60_000, maxSize: 5 });
    for (let i = 0; i < 100; i++) c.add(`m-${i}`);
    assert.equal(c.size(), 5);
    // The most recent 5 keys should be the ones retained.
    for (let i = 95; i < 100; i++) {
      assert.equal(c.has(`m-${i}`), true, `m-${i} should be retained`);
    }
    assert.equal(c.has('m-94'), false);
  });
});

describe('DedupCache · clear()', () => {
  it('empties the cache', () => {
    const c = new DedupCache();
    c.add('m1');
    c.add('m2');
    assert.equal(c.size(), 2);
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.has('m1'), false);
  });
});
