'use strict';

// Unit tests for the scheduled-pruning wiring added to long-term-memory.js.
// pruneFactMeta() deletion semantics are covered by long-term-memory-lifecycle
// / memory-bounds; this file pins the NEW surface: auto-start, start/stop
// idempotency, the runPruneNow metrics path, and that the interval actually
// fires. Deterministic + offline (small injected interval, generous window).

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ltm = require('../src/services/long-term-memory');

describe('[UNIT] long-term-memory prune scheduler', () => {
  // Capture the auto-start state from module load BEFORE we touch the timer.
  const initiallyRunning = ltm.pruneSchedulerStats().running;

  before(() => { ltm.stopPruneScheduler(); });
  after(() => { ltm.stopPruneScheduler(); });

  test('auto-starts on module load (unless memory disabled)', () => {
    if (ltm.MEMORY_DISABLED) {
      assert.equal(initiallyRunning, false, 'must not start when memory is globally disabled');
    } else {
      assert.equal(initiallyRunning, true, 'scheduler should auto-start at module load');
    }
  });

  test('stop is idempotent and reports whether it stopped a timer', () => {
    ltm.startPruneScheduler({ intervalMs: 50 });
    assert.equal(ltm.pruneSchedulerStats().running, true);
    assert.equal(ltm.stopPruneScheduler(), true, 'first stop clears the running timer');
    assert.equal(ltm.pruneSchedulerStats().running, false);
    assert.equal(ltm.stopPruneScheduler(), false, 'second stop is a no-op');
  });

  test('start is idempotent (never double-schedules)', () => {
    assert.equal(ltm.startPruneScheduler({ intervalMs: 50 }), true);
    assert.equal(ltm.startPruneScheduler({ intervalMs: 50 }), false, 'second start is a no-op while running');
    assert.equal(ltm.pruneSchedulerStats().running, true);
    ltm.stopPruneScheduler();
  });

  test('runPruneNow returns a count and records metrics', () => {
    ltm.stopPruneScheduler();
    const before = ltm.pruneSchedulerStats();
    const pruned = ltm.runPruneNow();
    assert.equal(typeof pruned, 'number');
    assert.ok(pruned >= 0);
    const after = ltm.pruneSchedulerStats();
    assert.equal(after.runs, before.runs + 1, 'runs counter increments');
    assert.equal(typeof after.lastRunAt, 'number', 'lastRunAt is stamped');
    assert.ok(after.totalPruned >= before.totalPruned, 'totalPruned never decreases');
    assert.equal(after.lastPrunedCount, pruned);
  });

  test('pruneSchedulerStats exposes the configured policy', () => {
    const s = ltm.pruneSchedulerStats();
    assert.ok(Number.isInteger(s.intervalMs) && s.intervalMs >= 60_000, 'interval clamped to >= 1 min');
    assert.ok(s.maxAgeDays >= 1, 'maxAgeDays clamped to >= 1');
    assert.ok(s.minMentions >= 0, 'minMentions clamped to >= 0');
    assert.ok('lastPrunedCount' in s && 'totalPruned' in s && 'runs' in s);
  });

  test('the scheduled interval actually fires runPruneNow', async () => {
    ltm.stopPruneScheduler();
    const before = ltm.pruneSchedulerStats().runs;
    ltm.startPruneScheduler({ intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 120)); // ~6 ticks of headroom
    const after = ltm.pruneSchedulerStats().runs;
    ltm.stopPruneScheduler();
    assert.ok(after > before, `expected the interval to fire (before=${before} after=${after})`);
  });
});
