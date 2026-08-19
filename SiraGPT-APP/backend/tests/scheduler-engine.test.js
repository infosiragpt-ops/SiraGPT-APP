/**
 * Tests for scheduler/scheduler.js — engine behavior.
 *
 * Uses an injectable `now()` clock so we can simulate the passage of time
 * deterministically without real timers.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { Scheduler } = require('../src/scheduler/scheduler');
const { InMemoryStore } = require('../src/scheduler/store');
const { STATE } = require('../src/scheduler/job');

function makeClock(startMs) {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

describe('Scheduler — basic execution', () => {
  it('runs a job once its nextRunAt is due', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    let runs = 0;
    const sched = new Scheduler({ now: clock.now });
    await sched.register({
      id: 'j1',
      schedule: 'every 5s',
      handler: () => { runs += 1; },
    });
    // First tick: not yet due.
    await sched.tick();
    assert.strictEqual(runs, 0);
    // Advance 6s → due.
    clock.advance(6_000);
    await sched.tick();
    assert.strictEqual(runs, 1);
    const job = sched.jobs.get('j1');
    assert.strictEqual(job.state, STATE.OK);
    assert.strictEqual(job.successCount, 1);
    assert.ok(job.nextRunAt.getTime() > clock.now().getTime());
  });

  it('marks state error after retries are exhausted', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const sched = new Scheduler({ now: clock.now });
    let attempts = 0;
    await sched.register({
      id: 'flaky',
      schedule: 'every 1s',
      maxRetries: 2,
      backoffMs: 1,
      backoffFactor: 1,
      handler: () => { attempts += 1; throw new Error('boom'); },
    });
    clock.advance(2_000);
    await sched.tick();
    assert.strictEqual(attempts, 3); // 1 initial + 2 retries
    const job = sched.jobs.get('flaky');
    assert.strictEqual(job.state, STATE.ERROR);
    assert.strictEqual(job.failureCount, 1);
    assert.match(job.lastError.message, /boom/);
  });

  it('recovers to ok after retry succeeds', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const sched = new Scheduler({ now: clock.now });
    let attempts = 0;
    await sched.register({
      id: 'recovers',
      schedule: 'every 1s',
      maxRetries: 3,
      backoffMs: 1,
      backoffFactor: 1,
      handler: () => {
        attempts += 1;
        if (attempts < 2) throw new Error('not yet');
      },
    });
    clock.advance(2_000);
    await sched.tick();
    const job = sched.jobs.get('recovers');
    assert.strictEqual(job.state, STATE.OK);
    assert.strictEqual(job.successCount, 1);
  });

  it('skips disabled jobs', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const sched = new Scheduler({ now: clock.now });
    let runs = 0;
    await sched.register({ id: 'off', schedule: 'every 1s', enabled: false, handler: () => { runs += 1; } });
    clock.advance(60_000);
    await sched.tick();
    assert.strictEqual(runs, 0);
    assert.strictEqual(sched.jobs.get('off').state, STATE.DISABLED);
  });

  it('toggles enabled state on the fly', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const sched = new Scheduler({ now: clock.now });
    let runs = 0;
    await sched.register({ id: 'tog', schedule: 'every 1s', handler: () => { runs += 1; } });
    sched.setEnabled('tog', false);
    clock.advance(5_000);
    await sched.tick();
    assert.strictEqual(runs, 0);
    sched.setEnabled('tog', true);
    clock.advance(5_000);
    await sched.tick();
    assert.strictEqual(runs, 1);
  });

  it('records run rows in the store', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const store = new InMemoryStore();
    const sched = new Scheduler({ now: clock.now, store });
    await sched.register({ id: 'logged', schedule: 'every 1s', handler: () => 'ok' });
    clock.advance(2_000);
    await sched.tick();
    const runs = await store.listRuns('logged', 10);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].status, 'ok');
    assert.strictEqual(runs[0].jobId, 'logged');
    assert.ok(runs[0].finishedAt);
  });
});

describe('Scheduler — overlap protection', () => {
  it('emits skip when lock is held by a concurrent run', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const store = new InMemoryStore();
    const sched = new Scheduler({ now: clock.now, store });

    // Pre-acquire the lock to simulate another worker holding it.
    await store.tryAcquireLock('busy', 'external-run', 'other-owner', 60_000);

    const skips = [];
    sched.on('skip', e => skips.push(e));

    await sched.register({ id: 'busy', schedule: 'every 1s', handler: () => 'should not run' });
    clock.advance(2_000);
    await sched.tick();

    assert.strictEqual(skips.length, 1);
    assert.strictEqual(skips[0].reason, 'lock_held');
    assert.strictEqual(sched.jobs.get('busy').state, STATE.SKIPPED);
    assert.strictEqual(sched.jobs.get('busy').successCount, 0);
  });
});

describe('Scheduler — idempotent run recording', () => {
  it('does not duplicate a run row on repeated recordRun(runId)', async () => {
    const store = new InMemoryStore();
    const row = { runId: 'r-1', jobId: 'j', startedAt: new Date(), status: 'running', attempt: 0 };
    const first = await store.recordRun(row);
    const second = await store.recordRun(row);
    assert.ok(first);
    assert.strictEqual(second, null);
    const runs = await store.listRuns('j', 10);
    assert.strictEqual(runs.length, 1);
  });
});

describe('Scheduler — status snapshot', () => {
  it('returns a JSON-serializable status', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const sched = new Scheduler({ now: clock.now });
    await sched.register({ id: 's1', schedule: 'every 10s', handler: () => {} });
    const snap = sched.status();
    const round = JSON.parse(JSON.stringify(snap));
    assert.strictEqual(round.jobCount, 1);
    assert.strictEqual(round.jobs[0].id, 's1');
    assert.strictEqual(round.jobs[0].state, STATE.IDLE);
    assert.ok(round.jobs[0].nextRunAt);
  });
});

describe('Scheduler — timeout enforcement', () => {
  it('treats a slow handler as a failure', async () => {
    const clock = makeClock(Date.UTC(2026, 0, 1));
    const sched = new Scheduler({ now: clock.now });
    await sched.register({
      id: 'slow',
      schedule: 'every 1s',
      timeoutMs: 20,
      maxRetries: 0,
      handler: () => new Promise(resolve => setTimeout(resolve, 200)),
    });
    clock.advance(2_000);
    await sched.tick();
    const job = sched.jobs.get('slow');
    assert.strictEqual(job.state, STATE.ERROR);
    assert.match(job.lastError.message, /timed out/);
    // Drain the still-pending handler promise so node:test sees a clean loop.
    await new Promise(resolve => setTimeout(resolve, 250));
  });
});
