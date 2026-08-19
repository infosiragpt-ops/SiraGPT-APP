'use strict';

// Lifecycle coverage for Scheduler.start()/stop() — the timer loop wrapper
// around tick(). The existing scheduler-engine tests drive tick() directly with
// a fake clock; none exercised start()/stop() (start() had zero references).
// With an empty job map, tick() is a clean no-op, so a small real-timer window
// deterministically exercises the loop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler } = require('../src/scheduler/scheduler');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('start() drives ticks on the interval, is idempotent, and stop() halts them', async () => {
  const sched = new Scheduler({ tickMs: 10 });
  let ticks = 0;
  const realTick = sched.tick.bind(sched);
  sched.tick = async () => { ticks += 1; return realTick(); };

  sched.start();
  sched.start(); // idempotent — already running, must be a no-op (no second loop)
  await delay(70);
  assert.ok(ticks >= 1, `start() should fire at least one tick (got ${ticks})`);

  await sched.stop();
  const settled = ticks;
  await delay(40);
  assert.equal(ticks, settled, 'stop() halts further ticks — no new timer is scheduled');
});

test('stop() before start() is a safe no-op', async () => {
  const sched = new Scheduler({ tickMs: 10 });
  await sched.stop(); // must not throw
  assert.ok(true);
});

test('start() after stop() resumes ticking', async () => {
  const sched = new Scheduler({ tickMs: 10 });
  let ticks = 0;
  const realTick = sched.tick.bind(sched);
  sched.tick = async () => { ticks += 1; return realTick(); };

  sched.start();
  await delay(40);
  await sched.stop();
  const afterStop = ticks;

  sched.start();
  await delay(50);
  await sched.stop();
  assert.ok(ticks > afterStop, 'a fresh start() resumes ticking after stop()');
});
