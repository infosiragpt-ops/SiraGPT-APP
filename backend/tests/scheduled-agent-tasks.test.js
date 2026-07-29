'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createScheduler,
  createMemoryStore,
  computeNextRunAt,
  isValidCronExpr,
  jitterMs,
  CLAIM_STALE_MS,
  JITTER_MAX_MS,
  MISSED_SCAN_CAP,
  CATCH_UP_POLICY,
} = require('../src/services/scheduled-agent-tasks');

function fakeClock(startIso) {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance(ms) { t += ms; },
  };
}

test('claimDue claims with an optimistic lock — a double claim never duplicates', async () => {
  const clock = fakeClock('2026-07-01T10:00:30Z');
  const store = createMemoryStore();
  const workerA = createScheduler({ store, now: clock.now });
  const workerB = createScheduler({ store, now: clock.now });
  const task = await workerA.createTask({ userId: 'u1', cronExpr: '* * * * *' });

  // Not yet due — nextRunAt is the next minute boundary.
  assert.deepEqual(await workerA.claimDue(), []);

  clock.advance(60_000);
  // Two workers polling the same store race for the claim; exactly one wins.
  const [fromA, fromB] = await Promise.all([workerA.claimDue(), workerB.claimDue()]);
  assert.equal(fromA.length + fromB.length, 1, 'exactly one worker may claim the task');
  const delivered = fromA[0] || fromB[0];
  assert.equal(delivered.id, task.id);
  assert.ok(delivered.claimedAt instanceof Date);

  // A fresh claim (<2 min old) is never re-delivered.
  assert.deepEqual(await workerA.claimDue(), []);
  assert.deepEqual(await workerB.claimDue(), []);

  // A stale claim (worker crashed mid-run) IS re-delivered after the TTL,
  // with the original anchor intact.
  clock.advance(CLAIM_STALE_MS + 1_000);
  const redelivered = await workerB.claimDue();
  assert.equal(redelivered.length, 1);
  assert.equal(redelivered[0].id, task.id);
});

test('catch-up after a long outage: delivered ONCE, then re-anchored to the future', async () => {
  const clock = fakeClock('2026-07-01T08:00:30Z');
  const store = createMemoryStore();
  const scheduler = createScheduler({ store, now: clock.now });
  const task = await scheduler.createTask({ userId: 'u1', cronExpr: '*/5 * * * *' });

  // Simulate the process being down for 3 hours (~36 missed 5-minute fires).
  clock.advance(3 * 60 * 60 * 1000);

  const due = await scheduler.claimDue();
  assert.equal(due.length, 1, 'a backlog of missed fires yields a single delivery');
  const { catchUp } = due[0];
  assert.equal(catchUp.policy, CATCH_UP_POLICY);
  assert.ok(catchUp.dueRuns >= 30 && catchUp.dueRuns <= 40, `dueRuns=${catchUp.dueRuns}`);
  assert.equal(catchUp.missed, catchUp.dueRuns - 1);
  assert.equal(catchUp.coalesced, true);
  assert.equal(catchUp.capped, false);

  // While claimed, the backlog does NOT produce a second delivery.
  assert.deepEqual(await scheduler.claimDue(), []);

  // Completing the single catch-up run re-anchors strictly into the future —
  // the ~35 missed executions are never replayed.
  const updated = await scheduler.completeRun({ taskId: task.id, status: 'ok', detail: 'caught up' });
  assert.ok(updated.nextRunAt.getTime() > clock.now().getTime(), 'nextRunAt must be in the future');
  assert.ok(
    updated.nextRunAt.getTime() - clock.now().getTime() <= 5 * 60_000,
    'nextRunAt anchors to the next slot, not to the backlog',
  );
  assert.deepEqual(await scheduler.claimDue(), [], 'nothing due until the future anchor');

  // An on-time claim reports zero missed fires.
  clock.advance(updated.nextRunAt.getTime() - clock.now().getTime() + 1_000);
  const onTime = await scheduler.claimDue();
  assert.equal(onTime.length, 1);
  assert.equal(onTime[0].catchUp.dueRuns, 1);
  assert.equal(onTime[0].catchUp.missed, 0);
  assert.equal(onTime[0].catchUp.coalesced, false);

  // Extreme backlog counting is capped so claimDue stays bounded.
  const swamped = await scheduler.catchUpPolicy(
    { ...task, nextRunAt: new Date('2020-01-01T00:00:00Z') },
    clock.now(),
  );
  assert.equal(swamped.dueRuns, MISSED_SCAN_CAP);
  assert.equal(swamped.capped, true);
});

test('completeRun records the outcome, releases the claim, and reschedules', async () => {
  const clock = fakeClock('2026-07-01T09:00:10Z');
  const store = createMemoryStore();
  const scheduler = createScheduler({ store, now: clock.now });
  const task = await scheduler.createTask({ userId: 'u2', cronExpr: '0 * * * *' });

  clock.advance(task.nextRunAt.getTime() - clock.now().getTime() + 1_000);
  const [claimed] = await scheduler.claimDue();
  assert.equal(claimed.id, task.id);

  const runAt = clock.now();
  const updated = await scheduler.completeRun({ taskId: task.id, status: 'error', detail: 'boom' });
  assert.equal(updated.lastStatus, 'error');
  assert.equal(updated.lastDetail, 'boom');
  assert.equal(updated.lastRunAt.getTime(), runAt.getTime());
  assert.equal(updated.claimedAt, null);
  assert.equal(updated.runCount, 1);
  assert.ok(updated.nextRunAt.getTime() > clock.now().getTime());
  assert.ok(updated.nextRunAt.getTime() - clock.now().getTime() <= 60 * 60_000);
  assert.deepEqual(await scheduler.claimDue(), [], 'rescheduled task is no longer due');

  // Unknown task ids resolve to null instead of throwing.
  assert.equal(await scheduler.completeRun({ taskId: 'sat_missing', status: 'ok' }), null);
});

test('jitterMs is deterministic and bounded to 0..30s', () => {
  const scheduler = createScheduler();
  const ids = ['a', 'b', 'sat_1', 'sat_2', 'task-123', 'task-124'];
  const values = ids.map((id) => scheduler.jitterMs(id));
  for (const value of values) {
    assert.ok(Number.isInteger(value), `jitter ${value} must be an integer`);
    assert.ok(value >= 0 && value <= JITTER_MAX_MS, `jitter ${value} out of range`);
  }
  // Deterministic: same id → same delay, across scheduler instances too.
  ids.forEach((id, i) => {
    assert.equal(scheduler.jitterMs(id), values[i]);
    assert.equal(createScheduler().jitterMs(id), values[i]);
    assert.equal(jitterMs(id), values[i]);
  });
  // Anti-stampede: different ids actually spread.
  assert.ok(new Set(values).size > 1, 'jitter must vary across task ids');
});

test('invalid or unsatisfiable cron expressions are rejected at creation', async () => {
  const scheduler = createScheduler({ now: () => new Date('2026-07-01T00:00:00Z') });
  const bad = ['61 * * * *', 'every day', '* * * *', '', '* * 31 2 *'];
  for (const cronExpr of bad) {
    assert.equal(isValidCronExpr(cronExpr), false, `"${cronExpr}" must be invalid`);
    await assert.rejects(
      () => scheduler.createTask({ userId: 'u3', cronExpr }),
      /cron/i,
      `"${cronExpr}" must be rejected`,
    );
  }

  // Unknown timezones are rejected; a valid tz is accepted and scheduled.
  await assert.rejects(
    () => scheduler.createTask({ userId: 'u3', cronExpr: '* * * * *', tz: 'Not/AZone' }),
    /timezone/i,
  );
  const task = await scheduler.createTask({
    userId: 'u3',
    cronExpr: '*/10 * * * *',
    tz: 'America/Mexico_City',
  });
  assert.ok(task.nextRunAt instanceof Date);
  assert.ok(task.nextRunAt.getTime() > new Date('2026-07-01T00:00:00Z').getTime());

  // computeNextRunAt mirrors the validation: no fire → null.
  assert.equal(computeNextRunAt('* * 31 2 *'), null);
  assert.ok(computeNextRunAt('* * * * *') instanceof Date);
});
