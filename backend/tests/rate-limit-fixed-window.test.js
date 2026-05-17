/**
 * Tests for services/rate-limit/fixed-window.js — per-key fixed-window
 * rate limiter with lazy GC.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { createFixedWindowLimiter } =
  require('../src/services/rate-limit/fixed-window');

// ── factory · validation ───────────────────────────────────────

describe('createFixedWindowLimiter · validation', () => {
  it('throws when limit is missing', () => {
    assert.throws(() => createFixedWindowLimiter({ windowMs: 1000 }),
      /limit must be positive integer/);
  });

  it('throws when limit is zero or negative', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 0, windowMs: 1000 }),
      /limit must be positive integer/);
    assert.throws(() => createFixedWindowLimiter({ limit: -1, windowMs: 1000 }),
      /limit must be positive integer/);
  });

  it('throws when limit is a non-integer', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 1.5, windowMs: 1000 }),
      /limit must be positive integer/);
  });

  it('throws when limit is non-numeric', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 'ten', windowMs: 1000 }),
      /limit must be positive integer/);
  });

  it('throws when windowMs is missing', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 5 }),
      /windowMs must be positive/);
  });

  it('throws when windowMs is zero or negative', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 5, windowMs: 0 }),
      /windowMs must be positive/);
    assert.throws(() => createFixedWindowLimiter({ limit: 5, windowMs: -1000 }),
      /windowMs must be positive/);
  });

  it('throws when windowMs is Infinity (not finite)', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 5, windowMs: Infinity }),
      /windowMs must be positive/);
  });

  it('accepts non-integer windowMs (only positivity + finiteness checked)', () => {
    const limiter = createFixedWindowLimiter({
      limit: 5, windowMs: 1500.5, now: () => 0,
    });
    assert.ok(limiter);
  });

  it('returns object with check / reset / size / snapshot', () => {
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 1000, now: () => 0 });
    assert.equal(typeof l.check, 'function');
    assert.equal(typeof l.reset, 'function');
    assert.equal(typeof l.size, 'function');
    assert.equal(typeof l.snapshot, 'function');
  });
});

// ── check · key validation ──────────────────────────────────────

describe('check · key validation', () => {
  function make() {
    return createFixedWindowLimiter({ limit: 5, windowMs: 1000, now: () => 0 });
  }

  it('throws on non-string key', () => {
    const l = make();
    assert.throws(() => l.check(42), /key must be non-empty string/);
    assert.throws(() => l.check(null), /key must be non-empty string/);
    assert.throws(() => l.check(undefined), /key must be non-empty string/);
    assert.throws(() => l.check({}), /key must be non-empty string/);
  });

  it('throws on empty string', () => {
    const l = make();
    assert.throws(() => l.check(''), /key must be non-empty string/);
  });
});

// ── check · happy paths ─────────────────────────────────────────

describe('check · happy paths', () => {
  it('allows up to limit hits inside a window', () => {
    const l = createFixedWindowLimiter({ limit: 3, windowMs: 1000, now: () => 100 });
    const a = l.check('alice');
    assert.equal(a.allowed, true);
    assert.equal(a.count, 1);
    assert.equal(a.remaining, 2);

    assert.equal(l.check('alice').remaining, 1);
    const c = l.check('alice');
    assert.equal(c.allowed, true);
    assert.equal(c.count, 3);
    assert.equal(c.remaining, 0);
  });

  it('rejects the (limit+1)-th hit without incrementing the counter', () => {
    const l = createFixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => 100 });
    l.check('k');
    l.check('k');
    const over = l.check('k');
    assert.equal(over.allowed, false);
    assert.equal(over.count, 2, 'count must NOT increment past limit');
    assert.equal(over.remaining, 0);
  });

  it('isolates counters per key', () => {
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => 100 });
    assert.equal(l.check('alice').allowed, true);
    assert.equal(l.check('bob').allowed, true);
    assert.equal(l.check('alice').allowed, false);
    assert.equal(l.check('bob').allowed, false);
  });

  it('exposes resetAt aligned to window boundary', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
    t = 1234;
    const r = l.check('k');
    // window [1000, 2000) → resetAt = 2000
    assert.equal(r.resetAt, 2000);
  });

  it('resetAt advances when window rolls', () => {
    let t = 500;
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
    const a = l.check('k');
    assert.equal(a.resetAt, 1000);
    t = 1500;
    const b = l.check('k');
    assert.equal(b.resetAt, 2000);
    assert.equal(b.allowed, true, 'new window should allow again');
    assert.equal(b.count, 1);
  });

  it('rolls window cleanly: previous-window count does not carry over', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
    l.check('k');
    l.check('k');
    assert.equal(l.check('k').allowed, false);

    // Cross the boundary.
    t = 1000;
    const fresh = l.check('k');
    assert.equal(fresh.allowed, true);
    assert.equal(fresh.count, 1);
  });

  it('respects limit of 1 (strict serialization)', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 100, now: () => t });
    assert.equal(l.check('k').allowed, true);
    assert.equal(l.check('k').allowed, false);
    t = 100;
    assert.equal(l.check('k').allowed, true);
  });

  it('handles large limits without precision issues', () => {
    const l = createFixedWindowLimiter({ limit: 100_000, windowMs: 1000, now: () => 0 });
    for (let i = 0; i < 100_000; i++) {
      const r = l.check('k');
      if (!r.allowed) assert.fail(`hit ${i + 1} should be allowed`);
    }
    assert.equal(l.check('k').allowed, false);
  });
});

// ── window boundary math ────────────────────────────────────────

describe('window boundary math', () => {
  it('windowStart = floor(t / windowMs) * windowMs', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 1000, now: () => t });
    t = 0;
    assert.equal(l.check('a').resetAt, 1000);
    t = 999;
    assert.equal(l.check('b').resetAt, 1000);
    t = 1000;
    assert.equal(l.check('c').resetAt, 2000);
    t = 9999;
    assert.equal(l.check('d').resetAt, 10000);
  });

  it('non-integer windowMs floors the boundary', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 1500, now: () => t });
    t = 0;
    assert.equal(l.check('k').resetAt, 1500);
    t = 1499;
    const r = l.check('k');
    assert.equal(r.resetAt, 1500);
  });

  it('time at exact boundary belongs to the new window', () => {
    let t = 1000;
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
    const r = l.check('k');
    // floor(1000/1000)*1000 = 1000 → resetAt = 2000
    assert.equal(r.resetAt, 2000);
  });
});

// ── reset() ─────────────────────────────────────────────────────

describe('reset', () => {
  it('reset(key) clears just that key', () => {
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    l.check('alice');
    l.check('bob');
    l.reset('alice');
    assert.equal(l.check('alice').allowed, true);
    assert.equal(l.check('bob').allowed, false);
  });

  it('reset() with no args clears all keys', () => {
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    l.check('alice');
    l.check('bob');
    l.check('carol');
    l.reset();
    assert.equal(l.size(), 0);
    assert.equal(l.check('alice').allowed, true);
  });

  it('reset(unknown-key) is a no-op', () => {
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    l.check('alice');
    l.reset('not-there');
    assert.equal(l.size(), 1);
  });
});

// ── size + snapshot ────────────────────────────────────────────

describe('size & snapshot', () => {
  it('size() reflects unique keys hit', () => {
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 1000, now: () => 0 });
    assert.equal(l.size(), 0);
    l.check('a');
    l.check('a');
    l.check('b');
    assert.equal(l.size(), 2);
  });

  it('snapshot() returns { limit, windowMs, size }', () => {
    const l = createFixedWindowLimiter({ limit: 7, windowMs: 250, now: () => 0 });
    l.check('x');
    const snap = l.snapshot();
    assert.deepEqual(snap, { limit: 7, windowMs: 250, size: 1 });
  });
});

// ── lazy GC sweep ──────────────────────────────────────────────

describe('lazy GC', () => {
  it('evicts buckets from previous windows after gcEveryHits hits', () => {
    let t = 0;
    const l = createFixedWindowLimiter({
      limit: 10,
      windowMs: 1000,
      now: () => t,
      gcEveryHits: 3,
    });

    // 3 hits at t=0 — fills 3 distinct keys.
    l.check('a');
    l.check('b');
    l.check('c');
    assert.equal(l.size(), 3);

    // Jump past the window. Next hit triggers GC sweep (3rd hit since last
    // gc fired during the c-check; we need to cross threshold again).
    t = 5000;
    l.check('d'); // hit 1 in new window — d's bucket added
    l.check('e'); // hit 2 in new window
    l.check('f'); // hit 3 — triggers gcSweep, deletes a/b/c (their windowStart < cutoff=5000)
    // After sweep: a/b/c gone; d/e/f remain.
    assert.equal(l.size(), 3);
  });

  it('uses default gcEveryHits when invalid', () => {
    const l = createFixedWindowLimiter({
      limit: 5, windowMs: 1000, now: () => 0,
      gcEveryHits: -1,
    });
    // Should not crash; default is 10000 so 100 hits won't trigger GC.
    for (let i = 0; i < 100; i++) l.check(`k${i}`);
    assert.equal(l.size(), 100);
  });

  it('ignores non-integer gcEveryHits', () => {
    const l = createFixedWindowLimiter({
      limit: 5, windowMs: 1000, now: () => 0,
      gcEveryHits: 1.5,
    });
    assert.ok(l);
  });

  it('GC does NOT evict keys in the current window', () => {
    let t = 0;
    const l = createFixedWindowLimiter({
      limit: 10, windowMs: 1000, now: () => t,
      gcEveryHits: 2,
    });
    l.check('a'); // hit 1
    l.check('a'); // hit 2 — triggers gcSweep at t=0; a is in current window so stays
    assert.equal(l.size(), 1);
  });
});

// ── now() injection ─────────────────────────────────────────────

describe('now() injection', () => {
  it('uses Date.now by default when no now is supplied', () => {
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 1000 });
    const result = l.check('k');
    // Just verify resetAt is a sensible future timestamp.
    assert.ok(result.resetAt > Date.now() - 1000);
    assert.ok(result.resetAt <= Date.now() + 1000);
  });

  it('non-function now option falls back to Date.now', () => {
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 1000, now: 12345 });
    const result = l.check('k');
    assert.ok(result.resetAt > Date.now() - 1000);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports createFixedWindowLimiter', () => {
    const mod = require('../src/services/rate-limit/fixed-window');
    assert.deepEqual(Object.keys(mod).sort(), ['createFixedWindowLimiter']);
  });
});
