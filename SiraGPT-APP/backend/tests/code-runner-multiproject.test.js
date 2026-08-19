'use strict';

// Multi-project dev-server pool for the code-runner sidecar (audit B1).
// The pool/evict logic lives in scripts/code-runner-utils.js (pure, no Bun
// APIs) precisely so it can be tested here with node --test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDevPortPool,
  createDevPool,
  EVICTABLE_STATES,
  DEFAULT_DEV_POOL_SIZE,
} = require('../../scripts/code-runner-utils');

// ── parseDevPortPool ─────────────────────────────────────────────────────────

test('parseDevPortPool defaults to basePort..basePort+9 when unset/invalid', () => {
  assert.deepEqual(parseDevPortPool(null, 5173), [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182]);
  assert.equal(parseDevPortPool('', 5173).length, DEFAULT_DEV_POOL_SIZE);
  assert.deepEqual(parseDevPortPool('garbage', 6000)[0], 6000);
  assert.deepEqual(parseDevPortPool('0-99999', 5173)[0], 5173); // out-of-range → fallback
});

test('parseDevPortPool parses ranges (both directions) and comma lists', () => {
  assert.deepEqual(parseDevPortPool('5173-5175', 5173), [5173, 5174, 5175]);
  assert.deepEqual(parseDevPortPool('5175-5173', 5173), [5173, 5174, 5175]); // reversed
  assert.deepEqual(parseDevPortPool('6001, 6003,6002', 5173), [6001, 6002, 6003]);
  assert.deepEqual(parseDevPortPool('6001,6001', 5173), [6001]); // dedupe
});

test('parseDevPortPool caps absurd ranges at 100 ports', () => {
  assert.equal(parseDevPortPool('5000-9000', 5173).length, 100);
});

// ── createDevPool: allocation + per-project reuse ───────────────────────────

test('allocate hands out the first free port of the pool per project', () => {
  const pool = createDevPool({ ports: [5173, 5174, 5175] });
  const a = pool.allocate('p1');
  const b = pool.allocate('p2');
  assert.equal(a.entry.port, 5173);
  assert.equal(b.entry.port, 5174);
  assert.equal(a.evicted, null);
  assert.equal(pool.size(), 2);
});

test('allocate for a known project reuses ITS entry (stable port, no evict)', () => {
  const pool = createDevPool({ ports: [5173, 5174] });
  const first = pool.allocate('p1');
  first.entry.state = 'ready';
  const again = pool.allocate('p1');
  assert.equal(again.entry, first.entry);
  assert.equal(again.entry.port, 5173);
  assert.equal(again.evicted, null);
  assert.equal(pool.size(), 1);
});

// ── evict-oldest when the pool is exhausted ─────────────────────────────────

test('exhausted pool evicts the OLDEST ready/error server and reuses its port', () => {
  let clock = 1000;
  const pool = createDevPool({ ports: [5173, 5174], now: () => clock });
  const a = pool.allocate('old'); // startedAt 1000
  clock = 2000;
  const b = pool.allocate('newer'); // startedAt 2000
  a.entry.state = 'ready';
  b.entry.state = 'ready';

  clock = 3000;
  const c = pool.allocate('p3');
  assert.ok(c, 'allocation should succeed via eviction');
  assert.equal(c.evicted.key, 'old');
  assert.equal(c.entry.port, 5173); // inherits the evicted port
  assert.equal(pool.get('old'), null);
  assert.equal(pool.size(), 2);
});

test('error-state servers are evictable; installing/starting ones are not', () => {
  assert.ok(EVICTABLE_STATES.has('ready'));
  assert.ok(EVICTABLE_STATES.has('error'));
  assert.ok(!EVICTABLE_STATES.has('installing'));
  assert.ok(!EVICTABLE_STATES.has('starting'));

  let clock = 1000;
  const pool = createDevPool({ ports: [5173, 5174], now: () => clock });
  const a = pool.allocate('crashed');
  clock = 2000;
  const b = pool.allocate('healthy');
  a.entry.state = 'error';
  b.entry.state = 'ready';
  clock = 500; // even with an older ready one by clock trickery, error@1000 is oldest
  b.entry.startedAt = 1500;
  a.entry.startedAt = 1000;

  const c = pool.allocate('p3');
  assert.equal(c.evicted.key, 'crashed');
});

test('exhausted pool with NOTHING evictable (all starting) returns null → 429', () => {
  const pool = createDevPool({ ports: [5173] });
  const a = pool.allocate('p1');
  a.entry.state = 'installing';
  assert.equal(pool.allocate('p2'), null);
  // ...and once it finishes, allocation succeeds again via eviction.
  a.entry.state = 'ready';
  const b = pool.allocate('p2');
  assert.equal(b.entry.port, 5173);
  assert.equal(b.evicted.key, 'p1');
});

// ── release frees the port ──────────────────────────────────────────────────

test('release frees the port for the next allocate', () => {
  const pool = createDevPool({ ports: [5173] });
  pool.allocate('p1');
  assert.equal(pool.allocate('p2'), null); // full, p1 not evictable (starting)
  const released = pool.release('p1');
  assert.equal(released.port, 5173);
  assert.equal(pool.size(), 0);
  const b = pool.allocate('p2');
  assert.equal(b.entry.port, 5173);
  assert.equal(b.evicted, null);
  assert.equal(pool.release('ghost'), null); // unknown key is a no-op
});

// ── pinned port (legacy workspace-root run on DEV_PORT) ─────────────────────

test('pinnedPort evicts the current holder of that exact port', () => {
  const pool = createDevPool({ ports: [5173, 5174] });
  const p1 = pool.allocate('p1'); // takes 5173
  p1.entry.state = 'ready';
  const root = pool.allocate('', { pinnedPort: 5173 });
  assert.equal(root.entry.port, 5173);
  assert.equal(root.evicted.key, 'p1');
  assert.equal(pool.get('p1'), null);
});

// ── idle reaper bookkeeping ─────────────────────────────────────────────────

test('idleEntries returns only finished servers idle beyond maxIdleMs; touch resets', () => {
  let clock = 0;
  const pool = createDevPool({ ports: [5173, 5174, 5175], now: () => clock });
  const a = pool.allocate('stale');
  const b = pool.allocate('fresh');
  const c = pool.allocate('still-starting');
  a.entry.state = 'ready';
  b.entry.state = 'ready';
  c.entry.state = 'starting';

  clock = 31 * 60_000;
  pool.touch('fresh'); // control-API activity keeps it alive
  const idle = pool.idleEntries(30 * 60_000);
  assert.deepEqual(idle.map((e) => e.key), ['stale']); // starting one never reaped
});
