/**
 * Tests for scheduler/job.js — Job descriptor.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { Job, STATE } = require('../src/scheduler/job');

// ── STATE enum ───────────────────────────────────────────────────

describe('STATE enum', () => {
  it('pins the 6 documented states', () => {
    assert.deepEqual({ ...STATE }, {
      IDLE: 'idle', RUNNING: 'running', OK: 'ok',
      ERROR: 'error', SKIPPED: 'skipped', DISABLED: 'disabled',
    });
  });

  it('is frozen', () => {
    assert.throws(() => { STATE.NEW = 'x'; }, TypeError);
  });
});

// ── constructor validation ──────────────────────────────────────

describe('Job constructor · validation', () => {
  it('throws when cfg missing', () => {
    assert.throws(() => new Job(), /requires id/);
    assert.throws(() => new Job(null), /requires id/);
  });

  it('throws when id missing', () => {
    assert.throws(() => new Job({ schedule: '* * * * *', handler: () => {} }), /requires id/);
  });

  it('throws when schedule missing', () => {
    assert.throws(() => new Job({ id: 'j1', handler: () => {} }), /requires schedule/);
  });

  it('throws when handler is not a function', () => {
    assert.throws(
      () => new Job({ id: 'j1', schedule: '* * * * *', handler: 'not-fn' }),
      /handler function/,
    );
  });
});

// ── constructor defaults ────────────────────────────────────────

describe('Job constructor · defaults', () => {
  function makeJob(cfg = {}) {
    return new Job({
      id: 'j1',
      schedule: '* * * * *',
      handler: async () => {},
      ...cfg,
    });
  }

  it('name defaults to id', () => {
    assert.equal(makeJob().name, 'j1');
  });

  it('honours explicit name', () => {
    assert.equal(makeJob({ name: 'My Job' }).name, 'My Job');
  });

  it('enabled defaults to true', () => {
    assert.equal(makeJob().enabled, true);
  });

  it('enabled=false coerces state to DISABLED', () => {
    assert.equal(makeJob({ enabled: false }).state, STATE.DISABLED);
  });

  it('enabled=true coerces state to IDLE', () => {
    assert.equal(makeJob().state, STATE.IDLE);
  });

  it('numeric defaults: timeoutMs=60000, maxRetries=0, backoff=1000, factor=2, maxBackoff=60000', () => {
    const j = makeJob();
    assert.equal(j.timeoutMs, 60_000);
    assert.equal(j.maxRetries, 0);
    assert.equal(j.backoffMs, 1000);
    assert.equal(j.backoffFactor, 2);
    assert.equal(j.maxBackoffMs, 60_000);
  });

  it('honours custom timeout/retry/backoff config', () => {
    const j = makeJob({
      timeoutMs: 5000, maxRetries: 3, backoffMs: 500,
      backoffFactor: 3, maxBackoffMs: 30_000,
    });
    assert.equal(j.timeoutMs, 5000);
    assert.equal(j.maxRetries, 3);
    assert.equal(j.backoffMs, 500);
    assert.equal(j.backoffFactor, 3);
    assert.equal(j.maxBackoffMs, 30_000);
  });

  it('non-finite numeric configs fall back to defaults', () => {
    const j = makeJob({
      timeoutMs: NaN, maxRetries: 'abc', backoffMs: undefined,
    });
    assert.equal(j.timeoutMs, 60_000);
    assert.equal(j.maxRetries, 0);
    assert.equal(j.backoffMs, 1000);
  });

  it('initial runtime counters are zero', () => {
    const j = makeJob();
    assert.equal(j.runCount, 0);
    assert.equal(j.successCount, 0);
    assert.equal(j.failureCount, 0);
    assert.equal(j.skippedCount, 0);
    assert.equal(j.lastRunAt, null);
    assert.equal(j.lastError, null);
    assert.equal(j.currentRunId, null);
  });

  it('coerces id to string', () => {
    const j = new Job({ id: 42, schedule: '* * * * *', handler: async () => {} });
    assert.equal(j.id, '42');
    assert.equal(typeof j.id, 'string');
  });

  it('coerces schedule to string and stores expr', () => {
    const j = makeJob({ schedule: '*/5 * * * *' });
    assert.equal(j.scheduleExpr, '*/5 * * * *');
  });
});

// ── computeNextRun ────────────────────────────────────────────

describe('computeNextRun', () => {
  function mkEvery1Min() {
    return new Job({
      id: 'j1', schedule: '* * * * *', handler: async () => {},
    });
  }

  it('returns a future Date when enabled', () => {
    const j = mkEvery1Min();
    const from = new Date('2026-01-15T12:00:00Z');
    const next = j.computeNextRun(from);
    assert.ok(next instanceof Date);
    assert.ok(next.getTime() > from.getTime());
  });

  it('returns null when disabled', () => {
    const j = mkEvery1Min();
    j.setEnabled(false);
    assert.equal(j.computeNextRun(new Date()), null);
  });

  it('persists result on the instance as nextRunAt', () => {
    const j = mkEvery1Min();
    const next = j.computeNextRun(new Date());
    assert.strictEqual(j.nextRunAt, next);
  });

  it('default `from` is "now" when omitted', () => {
    const j = mkEvery1Min();
    const next = j.computeNextRun();
    assert.ok(next instanceof Date);
  });
});

// ── setEnabled ────────────────────────────────────────────────

describe('setEnabled', () => {
  function mk(enabled = true) {
    return new Job({
      id: 'j1', schedule: '* * * * *', handler: async () => {}, enabled,
    });
  }

  it('disabling clears state + nextRunAt', () => {
    const j = mk();
    j.computeNextRun();
    j.setEnabled(false);
    assert.equal(j.enabled, false);
    assert.equal(j.state, STATE.DISABLED);
    assert.equal(j.nextRunAt, null);
  });

  it('re-enabling from disabled moves state to IDLE', () => {
    const j = mk(false);
    j.setEnabled(true);
    assert.equal(j.enabled, true);
    assert.equal(j.state, STATE.IDLE);
  });

  it('re-enabling when NOT previously disabled preserves current state', () => {
    const j = mk();
    j.state = STATE.OK;
    j.setEnabled(true);
    assert.equal(j.state, STATE.OK);
  });

  it('truthy/falsy enabled coerces to boolean', () => {
    const j = mk();
    j.setEnabled(1);
    assert.equal(j.enabled, true);
    j.setEnabled(0);
    assert.equal(j.enabled, false);
    j.setEnabled('yes');
    assert.equal(j.enabled, true);
  });
});

// ── computeBackoff ────────────────────────────────────────────

describe('computeBackoff', () => {
  function mk(cfg = {}) {
    return new Job({
      id: 'j', schedule: '* * * * *', handler: async () => {},
      backoffMs: 100, backoffFactor: 2, maxBackoffMs: 10_000,
      ...cfg,
    });
  }

  it('exponential growth from base', () => {
    const j = mk();
    // attempt 0: base * 2^0 = 100 (+ up to 25% jitter)
    const a0 = j.computeBackoff(0);
    assert.ok(a0 >= 100 && a0 <= 125);
    // attempt 1: 100 * 2 = 200 (+ jitter)
    const a1 = j.computeBackoff(1);
    assert.ok(a1 >= 200 && a1 <= 250);
    // attempt 3: 100 * 8 = 800 (+ jitter)
    const a3 = j.computeBackoff(3);
    assert.ok(a3 >= 800 && a3 <= 1000);
  });

  it('caps at maxBackoffMs', () => {
    const j = mk({ maxBackoffMs: 500 });
    // attempt 20: 100 * 2^20 → capped to 500 (+ 25% = 625)
    const v = j.computeBackoff(20);
    assert.ok(v >= 500 && v <= 625);
  });

  it('always returns an integer', () => {
    const j = mk();
    for (let a = 0; a < 5; a++) {
      const v = j.computeBackoff(a);
      assert.equal(v, Math.floor(v));
    }
  });
});

// ── toJSON ────────────────────────────────────────────────────

describe('toJSON', () => {
  it('returns the documented serializable shape', () => {
    const j = new Job({
      id: 'j1', name: 'Hourly Cleanup',
      schedule: '0 * * * *', handler: async () => {},
      timeoutMs: 5000, maxRetries: 2,
    });
    const json = j.toJSON();
    assert.equal(json.id, 'j1');
    assert.equal(json.name, 'Hourly Cleanup');
    assert.equal(json.schedule, '0 * * * *');
    assert.equal(json.enabled, true);
    assert.equal(json.state, STATE.IDLE);
    assert.equal(json.nextRunAt, null);
    assert.equal(json.lastRunAt, null);
    assert.equal(json.lastFinishedAt, null);
    assert.equal(json.lastDurationMs, null);
    assert.equal(json.lastError, null);
    assert.equal(json.runCount, 0);
    assert.equal(json.successCount, 0);
    assert.equal(json.failureCount, 0);
    assert.equal(json.skippedCount, 0);
    assert.equal(json.timeoutMs, 5000);
    assert.equal(json.maxRetries, 2);
  });

  it('serialises Date fields as ISO strings', () => {
    const j = new Job({
      id: 'j1', schedule: '* * * * *', handler: async () => {},
    });
    const now = new Date('2026-01-15T12:00:00Z');
    j.lastRunAt = now;
    j.lastFinishedAt = now;
    j.computeNextRun(now);
    const json = j.toJSON();
    assert.equal(json.lastRunAt, '2026-01-15T12:00:00.000Z');
    assert.equal(json.lastFinishedAt, '2026-01-15T12:00:00.000Z');
    assert.match(json.nextRunAt, /^2026-01-15T/);
  });

  it('serialises lastError as { message, name } only', () => {
    const j = new Job({ id: 'j1', schedule: '* * * * *', handler: async () => {} });
    j.lastError = new TypeError('something broke');
    const json = j.toJSON();
    assert.deepEqual(json.lastError, { message: 'something broke', name: 'TypeError' });
  });

  it('disabled jobs serialise with state=disabled and nextRunAt=null', () => {
    const j = new Job({
      id: 'j1', schedule: '* * * * *', handler: async () => {}, enabled: false,
    });
    const json = j.toJSON();
    assert.equal(json.enabled, false);
    assert.equal(json.state, STATE.DISABLED);
    assert.equal(json.nextRunAt, null);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports Job class + STATE enum', () => {
    const mod = require('../src/scheduler/job');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['Job', 'STATE']);
  });
});
