/**
 * Tests for cache/TwoTier.js — L1 (LRU) + optional L2 cache.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const { TwoTier } = require('../src/cache/TwoTier');

// Minimal L1 stub — Map with optional .policy.
function makeL1(policy = 'lru') {
  const m = new Map();
  return {
    policy,
    get(k) { return m.get(k); },
    set(k, v) { m.set(k, v); return true; },
    delete(k) { return m.delete(k); },
  };
}

// Minimal L2 stub.
function makeL2() {
  const m = new Map();
  return {
    async get(k) { return m.get(k); },
    async set(k, v) { m.set(k, v); return true; },
    async delete(k) {
      const had = m.has(k);
      m.delete(k);
      return had;
    },
  };
}

// ── construction ────────────────────────────────────────────────

describe('TwoTier constructor', () => {
  it('creates a default MemoryLRU L1 when no l1 supplied', () => {
    const t = new TwoTier();
    assert.ok(t.l1);
  });

  it('exposes l1 + l2 + metrics getters', () => {
    const l1 = makeL1();
    const l2 = makeL2();
    const t = new TwoTier({ l1, l2 });
    assert.strictEqual(t.l1, l1);
    assert.strictEqual(t.l2, l2);
    assert.ok(t.metrics);
  });

  it('honours custom defaultTtlMs', () => {
    const t = new TwoTier({ defaultTtlMs: 1000 });
    assert.equal(t._defaultTtlMs, 1000);
  });

  it('falls back to l1TtlMs when defaultTtlMs not finite', () => {
    const t = new TwoTier({ l1TtlMs: 2000 });
    assert.equal(t._defaultTtlMs, 2000);
  });

  it('5-minute default when neither defaultTtlMs nor l1TtlMs set', () => {
    const t = new TwoTier();
    assert.equal(t._defaultTtlMs, 5 * 60 * 1000);
  });

  it('non-positive defaultTtlMs ignored (uses fallback)', () => {
    const t = new TwoTier({ defaultTtlMs: 0, l1TtlMs: 1000 });
    assert.equal(t._defaultTtlMs, 1000);
  });
});

// ── get · L1 hit ────────────────────────────────────────────────

describe('TwoTier.get · L1 path', () => {
  it('returns undefined for falsy key + bumps miss metric', async () => {
    const t = new TwoTier({ l1: makeL1() });
    assert.equal(await t.get(''), undefined);
    const snap = t.snapshot();
    assert.ok(snap.misses >= 1);
  });

  it('returns L1 value when present and bumps L1 hit metric', async () => {
    const l1 = makeL1();
    l1.set('k', 'v');
    const t = new TwoTier({ l1 });
    assert.equal(await t.get('k'), 'v');
    const snap = t.snapshot();
    assert.ok(snap.l1_hits >= 1);
  });

  it('records hit-by-policy for the L1 policy name', async () => {
    const l1 = makeL1('lfu');
    l1.set('k', 'v');
    const t = new TwoTier({ l1 });
    await t.get('k');
    const snap = t.snapshot();
    // cache_counts_by_policy is a per-policy {hits, misses} map.
    assert.ok(snap.cache_counts_by_policy?.lfu?.hits >= 1);
  });
});

// ── get · L2 path ──────────────────────────────────────────────

describe('TwoTier.get · L2 fallback', () => {
  it('L1 miss + L2 hit → returns L2 value', async () => {
    const l1 = makeL1();
    const l2 = makeL2();
    await l2.set('k', 'l2-val');
    const t = new TwoTier({ l1, l2 });
    assert.equal(await t.get('k'), 'l2-val');
  });

  it('hoists L2-hit value into L1', async () => {
    const l1 = makeL1();
    const l2 = makeL2();
    await l2.set('k', 'l2-val');
    const t = new TwoTier({ l1, l2 });
    await t.get('k');
    // L1 should now have it.
    assert.equal(l1.get('k'), 'l2-val');
  });

  it('records L2 hit metric', async () => {
    const l2 = makeL2();
    await l2.set('k', 'v');
    const t = new TwoTier({ l1: makeL1(), l2 });
    await t.get('k');
    const snap = t.snapshot();
    assert.ok(snap.l2_hits >= 1);
  });

  it('L1 miss + L2 miss + records overall miss', async () => {
    const t = new TwoTier({ l1: makeL1(), l2: makeL2() });
    assert.equal(await t.get('k'), undefined);
    const snap = t.snapshot();
    assert.ok(snap.misses >= 1);
  });

  it('L2 throw → records l2Error + returns miss', async () => {
    const l2 = {
      async get() { throw new Error('redis down'); },
      async set() {},
      async delete() {},
    };
    const t = new TwoTier({ l1: makeL1(), l2 });
    assert.equal(await t.get('k'), undefined);
    const snap = t.snapshot();
    assert.ok(snap.l2_errors >= 1);
  });

  it('no L2 + L1 miss → records miss without exception', async () => {
    const t = new TwoTier({ l1: makeL1() });
    assert.equal(await t.get('k'), undefined);
  });

  it('L1.set throw during hoist is swallowed (still returns L2 value)', async () => {
    const l1 = {
      policy: 'lru',
      get() {},
      set() { throw new Error('l1 set broken'); },
      delete() { return false; },
    };
    const l2 = makeL2();
    await l2.set('k', 'l2-val');
    const t = new TwoTier({ l1, l2 });
    assert.equal(await t.get('k'), 'l2-val');
  });
});

// ── set ────────────────────────────────────────────────────────

describe('TwoTier.set', () => {
  it('no-op for falsy key', async () => {
    const t = new TwoTier({ l1: makeL1() });
    await t.set('', 'v');
    assert.equal(t.l1.get(''), undefined);
  });

  it('writes to L1 synchronously', async () => {
    const l1 = makeL1();
    const t = new TwoTier({ l1 });
    await t.set('k', 'v');
    assert.equal(l1.get('k'), 'v');
  });

  it('uses default TTL when ttlMs omitted', async () => {
    let captured;
    const l1 = {
      policy: 'lru', get() {}, delete() {},
      set(k, v, ttl) { captured = ttl; return true; },
    };
    const t = new TwoTier({ l1, defaultTtlMs: 2500 });
    await t.set('k', 'v');
    assert.equal(captured, 2500);
  });

  it('non-positive ttlMs falls back to default', async () => {
    let captured;
    const l1 = {
      policy: 'lru', get() {}, delete() {},
      set(k, v, ttl) { captured = ttl; return true; },
    };
    const t = new TwoTier({ l1, defaultTtlMs: 2500 });
    await t.set('k', 'v', 0);
    assert.equal(captured, 2500);
    await t.set('k', 'v', -5);
    assert.equal(captured, 2500);
    await t.set('k', 'v', NaN);
    assert.equal(captured, 2500);
  });

  it('fires L2 write asynchronously (does not gate set())', async () => {
    let l2WriteResolved = false;
    const l2 = {
      async get() {}, async delete() {},
      set: async () => {
        await new Promise(r => setTimeout(r, 10));
        l2WriteResolved = true;
        return true;
      },
    };
    const t = new TwoTier({ l1: makeL1(), l2 });
    await t.set('k', 'v');
    // set() returned before the L2 write resolved.
    assert.equal(l2WriteResolved, false);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(l2WriteResolved, true);
  });

  it('records set metric', async () => {
    const t = new TwoTier({ l1: makeL1() });
    await t.set('k', 'v');
    const snap = t.snapshot();
    assert.ok(snap.sets >= 1);
  });

  it('L1 set throw is swallowed', async () => {
    const l1 = {
      policy: 'lru', get() {}, delete() {},
      set() { throw new Error('l1 down'); },
    };
    const t = new TwoTier({ l1 });
    await assert.doesNotReject(() => t.set('k', 'v'));
  });
});

// ── setAndWait ────────────────────────────────────────────────

describe('TwoTier.setAndWait', () => {
  it('awaits the L2 write before returning', async () => {
    let l2WriteResolved = false;
    const l2 = {
      async get() {}, async delete() {},
      set: async () => {
        await new Promise(r => setTimeout(r, 10));
        l2WriteResolved = true;
        return true;
      },
    };
    const t = new TwoTier({ l1: makeL1(), l2 });
    await t.setAndWait('k', 'v');
    assert.equal(l2WriteResolved, true);
  });

  it('no-op for falsy key', async () => {
    const t = new TwoTier({ l1: makeL1() });
    await t.setAndWait('', 'v');
    assert.equal(t.l1.get(''), undefined);
  });

  it('L2 throw recorded as l2Error', async () => {
    const l2 = {
      async get() {}, async delete() {},
      async set() { throw new Error('l2 down'); },
    };
    const t = new TwoTier({ l1: makeL1(), l2 });
    await t.setAndWait('k', 'v');
    const snap = t.snapshot();
    assert.ok(snap.l2_errors >= 1);
  });
});

// ── delete ────────────────────────────────────────────────────

describe('TwoTier.delete', () => {
  it('returns false for falsy key', async () => {
    const t = new TwoTier({ l1: makeL1() });
    assert.equal(await t.delete(''), false);
  });

  it('deletes from L1 + L2 and returns true if either had it', async () => {
    const l1 = makeL1();
    l1.set('k', 'v');
    const l2 = makeL2();
    await l2.set('k', 'v');
    const t = new TwoTier({ l1, l2 });
    assert.equal(await t.delete('k'), true);
    assert.equal(l1.get('k'), undefined);
  });

  it('returns false when neither had the key', async () => {
    const t = new TwoTier({ l1: makeL1(), l2: makeL2() });
    assert.equal(await t.delete('missing'), false);
  });

  it('L2 throw recorded as l2Error', async () => {
    const l2 = {
      async get() {}, async set() {},
      async delete() { throw new Error('l2 down'); },
    };
    const t = new TwoTier({ l1: makeL1(), l2 });
    await t.delete('k');
    const snap = t.snapshot();
    assert.ok(snap.l2_errors >= 1);
  });

  it('L1 throw is swallowed (still attempts L2)', async () => {
    const l1 = {
      policy: 'lru', get() {}, set() {},
      delete() { throw new Error('l1 down'); },
    };
    const l2 = makeL2();
    await l2.set('k', 'v');
    const t = new TwoTier({ l1, l2 });
    assert.equal(await t.delete('k'), true);
  });
});

// ── recordBypass + snapshot ───────────────────────────────────

describe('recordBypass + snapshot', () => {
  it('recordBypass increments bypass counter', () => {
    const t = new TwoTier();
    t.recordBypass();
    t.recordBypass();
    const snap = t.snapshot();
    assert.ok(snap.bypasses >= 2);
  });

  it('snapshot returns metric counters', async () => {
    const t = new TwoTier({ l1: makeL1() });
    await t.set('k', 'v');
    await t.get('k');
    const snap = t.snapshot();
    assert.equal(typeof snap.sets, 'number');
    assert.equal(typeof snap.l1_hits, 'number');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports TwoTier class', () => {
    const mod = require('../src/cache/TwoTier');
    assert.deepEqual(Object.keys(mod), ['TwoTier']);
  });
});
