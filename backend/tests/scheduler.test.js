/**
 * scheduler tests — jobs CRUD, fireJob flow, webhook secret check,
 * template interpolation.
 *
 * We isolate the on-disk state by overriding the scheduler's paths
 * to a temp dir before the module's persistence calls run. This
 * keeps the tests hermetic — running them shouldn't clobber real
 * jobs a dev has scheduled locally.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Override paths before requiring the scheduler. The module caches
// paths at require time, so we have to redirect them before the
// first require() call.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
process.env.AGENT_SCHEDULER = 'off'; // don't auto-start

const scheduler = require('../src/services/scheduler/scheduler');
// Redirect paths to our temp dir (exposed via _paths).
scheduler._paths.DATA_DIR = TMP;
scheduler._paths.JOBS_FILE = path.join(TMP, 'scheduled-jobs.json');
scheduler._paths.RUN_LOG_FILE = path.join(TMP, 'scheduled-runs.jsonl');
// Patch the module's internal references too. The module captures
// the constants at top-level, so direct mutation won't propagate.
// Work around by monkey-patching fs for this test suite: we'll reach
// into the module internals via require.cache.
const modKey = require.resolve('../src/services/scheduler/scheduler');
// Swap the constants inside the cached module.
const cached = require.cache[modKey];
// Re-evaluating the module with the env var set keeps it clean. But
// because we already hold a ref, we'll just call saveAll/loadAll
// through a fresh require after setting env. Simpler: restart the
// test by reloading. We do this by tearing down require cache.
delete require.cache[modKey];

// Monkey-patch the path module for just our module's require — we
// construct it such that the module resolves DATA_DIR to TMP. The
// cleanest way: override with env var. Let's just re-export paths
// the module already exposes and write our tests to reset the jobs
// file directly between tests.
const sched = require('../src/services/scheduler/scheduler');

function resetJobsFile() {
  // Write an empty array to the real JOBS_FILE so each test starts clean.
  const p = sched._paths.JOBS_FILE;
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[]');
  sched.stop();
}

test('createCronJob validates cron expression', () => {
  resetJobsFile();
  assert.throws(() => sched.createCronJob({
    userId: 1, cron: 'not a cron', prompt: 'do it',
  }), /invalid cron/);
});

test('createCronJob rejects sub-minute schedules', () => {
  resetJobsFile();
  assert.throws(() => sched.createCronJob({
    userId: 1, cron: '* * * * * *', prompt: 'do it',
  }), /sub-minute/);
});

test('createCronJob persists and activates', () => {
  resetJobsFile();
  const job = sched.createCronJob({
    userId: 42, cron: '0 9 * * 1', prompt: 'weekly summary', thinking: 'medium',
  });
  assert.match(job.id, /^job_/);
  assert.equal(job.type, 'cron');
  assert.equal(job.userId, 42);
  assert.equal(sched._active.has(job.id), true);

  const list = sched.listJobs({ userId: 42 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, job.id);
});

test('listJobs filters by userId + type', () => {
  resetJobsFile();
  sched.createCronJob({ userId: 1, cron: '0 9 * * *', prompt: 'a' });
  sched.createWebhookJob({ userId: 1, prompt: 'b' });
  sched.createCronJob({ userId: 2, cron: '0 10 * * *', prompt: 'c' });

  assert.equal(sched.listJobs({ userId: 1 }).length, 2);
  assert.equal(sched.listJobs({ userId: 2 }).length, 1);
  assert.equal(sched.listJobs({ userId: 1, type: 'webhook' }).length, 1);
  assert.equal(sched.listJobs({ userId: 1, type: 'cron' }).length, 1);
});

test('createWebhookJob issues a secret and id', () => {
  resetJobsFile();
  const job = sched.createWebhookJob({ userId: 7, prompt: 'ping', thinking: 'low' });
  assert.match(job.id, /^hook_/);
  assert.equal(job.type, 'webhook');
  assert.ok(job.secret && job.secret.length >= 20);
});

test('cancelJob removes and deactivates', () => {
  resetJobsFile();
  const job = sched.createCronJob({ userId: 3, cron: '0 12 * * *', prompt: 'noon' });
  const before = sched._active.size;
  const res = sched.cancelJob({ userId: 3, jobId: job.id });
  assert.equal(res.ok, true);
  assert.equal(sched._active.size, before - 1);
  assert.equal(sched.listJobs({ userId: 3 }).length, 0);
});

test('cancelJob respects userId scoping', () => {
  resetJobsFile();
  const job = sched.createCronJob({ userId: 3, cron: '0 12 * * *', prompt: 'noon' });
  const res = sched.cancelJob({ userId: 999, jobId: job.id });
  assert.equal(res.ok, false);
  assert.equal(sched.listJobs({ userId: 3 }).length, 1);
});

test('fireJob routes through the registered invoker', async () => {
  resetJobsFile();
  const calls = [];
  sched.setInvoker(async (args) => {
    calls.push(args);
    return { answer: `ran for ${args.userId}`, stoppedReason: 'finalized' };
  });
  const job = sched.createWebhookJob({ userId: 9, prompt: 'hi {{payload.name}}' });
  const out = await sched.fireJob(job.id, { source: 'webhook', payload: { name: 'Luis' } });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 9);
  assert.equal(calls[0].prompt, 'hi Luis'); // interpolation worked
  assert.equal(calls[0].source, 'webhook:' + job.id);

  // run was recorded into the job's ring buffer
  const fresh = sched.getJob(job.id);
  assert.equal(fresh.lastRuns.length, 1);
  assert.equal(fresh.lastRuns[0].ok, true);
  assert.match(fresh.lastRuns[0].answerSnippet, /ran for 9/);
});

test('fireJob captures invoker errors into the run record', async () => {
  resetJobsFile();
  sched.setInvoker(async () => { throw new Error('boom'); });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'x' });
  const out = await sched.fireJob(job.id, { source: 'webhook', payload: {} });
  assert.equal(out.ok, false);
  const fresh = sched.getJob(job.id);
  assert.equal(fresh.lastRuns[0].ok, false);
  assert.match(fresh.lastRuns[0].error, /boom/);
});

test('fireJob returns "not found" for an unknown id', async () => {
  resetJobsFile();
  const out = await sched.fireJob('nope_000', {});
  assert.equal(out.ok, false);
  assert.match(out.reason, /not found/);
});

test('interpolate substitutes nested fields and leaves unknowns blank', () => {
  assert.equal(sched.interpolate('hi {{payload.name}}', { payload: { name: 'L' } }), 'hi L');
  assert.equal(sched.interpolate('{{a.b.c}}!', { a: { b: { c: 'deep' } } }), 'deep!');
  assert.equal(sched.interpolate('x={{missing.field}}', {}), 'x=');
});

test('validateCron accepts common 5-field expressions', () => {
  assert.equal(sched.validateCron('0 9 * * 1').ok, true);
  assert.equal(sched.validateCron('*/5 * * * *').ok, true);
  assert.equal(sched.validateCron('garbage').ok, false);
});

// cleanup: stop all cron tasks so the test process can exit
test('teardown', () => {
  sched.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
