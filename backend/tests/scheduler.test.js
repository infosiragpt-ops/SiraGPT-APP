/**
 * scheduler tests — jobs CRUD, fireJob flow, webhook secret check,
 * template interpolation.
 *
 * Compile the actual scheduler in an isolated module whose __dirname
 * is inside a temporary directory. Persistence and node-cron remain
 * real; no global fs/path patches or repository data writes are needed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Module, createRequire } = require('node:module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
const sourcePath = require.resolve('../src/services/scheduler/scheduler');
const isolatedPath = path.join(TMP, 'src', 'services', 'scheduler', 'scheduler.js');
const isolatedModule = new Module(isolatedPath, module);
isolatedModule.filename = isolatedPath;
isolatedModule.require = createRequire(sourcePath);
isolatedModule._compile(fs.readFileSync(sourcePath, 'utf8'), isolatedPath);
const sched = isolatedModule.exports;

function resetJobsFile() {
  sched.stop();
  sched.setInvoker(null);
  // Failure fixtures are terminal. Retry/backoff has its own dedicated tests.
  sched.setJobClassifier(() => ({ retryable: false, reason: 'test-terminal' }));
  const p = sched._paths.JOBS_FILE;
  assert.equal(p, path.join(TMP, 'data', 'scheduled-jobs.json'));
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[]');
}

test.after(() => {
  sched.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('persistence uses only the isolated temporary directory', () => {
  resetJobsFile();
  assert.equal(sched._paths.DATA_DIR, path.join(TMP, 'data'));
  assert.equal(sched._paths.RUN_LOG_FILE, path.join(TMP, 'data', 'scheduled-runs.jsonl'));
  assert.equal(fs.readFileSync(sched._paths.JOBS_FILE, 'utf8'), '[]');
});

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
  assert.equal(list[0].status, 'idle');
  assert.equal(list[0].statusDetails.active, true);
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
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.statusDetails.lastRunOk, true);
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
  assert.equal(fresh.status, 'error');
  assert.match(fresh.statusDetails.reason, /boom/);
});

test('computed status reports disabled, skipped, idle, running, ok, and error states', async () => {
  resetJobsFile();
  assert.equal(sched.computeJobStatus({ id: 'disabled', enabled: false, type: 'webhook' }), 'disabled');
  assert.equal(sched.computeJobStatus({ id: 'bad-cron', enabled: true, type: 'cron', cron: 'bad', lastRuns: [] }), 'skipped');

  const idleJob = sched.createWebhookJob({ userId: 1, prompt: 'idle' });
  assert.equal(sched.getJob(idleJob.id).status, 'idle');

  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  sched.setInvoker(async () => {
    assert.equal(sched.getJob(idleJob.id).status, 'running');
    release();
    await blocker;
    return { answer: 'done' };
  });
  const run = sched.fireJob(idleJob.id, { source: 'webhook', payload: {} });
  await blocker;
  await run;
  assert.equal(sched.getJob(idleJob.id).status, 'ok');

  sched.setInvoker(async () => { throw new Error('failed'); });
  await sched.fireJob(idleJob.id, { source: 'webhook', payload: {} });
  assert.equal(sched.getJob(idleJob.id).status, 'error');
});

test('fireJob returns "not found" for an unknown id', async () => {
  resetJobsFile();
  const out = await sched.fireJob('nope_000', {});
  assert.equal(out.ok, false);
  assert.match(out.reason, /not found/);
});

test('fireJob skips an overlapping invocation of the same job in this process', async () => {
  resetJobsFile();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  sched.setInvoker(async () => {
    calls += 1;
    await gate;
    return { answer: 'done' };
  });
  const job = sched.createWebhookJob({ userId: 1, prompt: 'once' });
  const first = sched.fireJob(job.id);
  const overlapping = sched.fireJob(job.id);
  try {
    assert.equal(calls, 1);
    assert.equal(sched.getJob(job.id).status, 'running');
  } finally {
    release();
    await Promise.all([first, overlapping]);
  }
  assert.deepEqual(await overlapping, { ok: false, reason: 'already running', code: 'overlap_skipped' });
  assert.equal((await first).ok, true);
  assert.equal(sched.getJob(job.id).lastRuns.length, 1);
});

test('fireJob allows different jobs concurrently and releases failed jobs', async () => {
  resetJobsFile();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  sched.setInvoker(async ({ userId }) => {
    calls.push(userId);
    await gate;
    if (userId === 1) throw new Error('terminal fixture');
    return { answer: 'done' };
  });
  const firstJob = sched.createWebhookJob({ userId: 1, prompt: 'one' });
  const secondJob = sched.createWebhookJob({ userId: 2, prompt: 'two' });
  const runs = [sched.fireJob(firstJob.id), sched.fireJob(secondJob.id)];
  try {
    assert.deepEqual(calls, [1, 2]);
    assert.equal(sched._running.size, 2);
  } finally {
    release();
    await Promise.all(runs);
  }
  assert.equal((await runs[0]).ok, false);
  assert.equal((await runs[1]).ok, true);
  assert.equal(sched._running.size, 0);
  sched.setInvoker(async () => ({ answer: 'recovered' }));
  assert.equal((await sched.fireJob(firstJob.id)).ok, true);
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
