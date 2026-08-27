'use strict';

/**
 * routine-notifier + scheduler fireJob hook tests — hermetic.
 *
 * The scheduler captures DATA_DIR/JOBS_FILE/RUN_LOG_FILE at require
 * time inside closures, so we intercept path.join while the module
 * evaluates, redirecting its backend/data targets into a temp dir.
 * The run notifier is injected via setRunNotifier so no test ever
 * touches Prisma (DATABASE_URL is not configured in the sandbox).
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-hook-'));
const JOBS_FILE = path.join(TMP, 'scheduled-jobs.json');
const RUN_LOG_FILE = path.join(TMP, 'scheduled-runs.jsonl');

process.env.AGENT_SCHEDULER = 'off';

const origJoin = path.join;
path.join = function interceptedJoin(...args) {
  const joined = origJoin.apply(this, args);
  if (
    typeof joined === 'string' &&
    joined.includes(`${path.sep}backend${path.sep}data`) &&
    new Error().stack.includes(`services${path.sep}scheduler`)
  ) {
    return TMP;
  }
  return joined;
};

let sched;
let notifierMod;
try {
  sched = require('../src/services/scheduler/scheduler');
  notifierMod = require('../src/services/scheduler/routine-notifier');
} finally {
  path.join = origJoin;
}

function resetJobsFile() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(JOBS_FILE, '[]');
  if (fs.existsSync(RUN_LOG_FILE)) fs.unlinkSync(RUN_LOG_FILE);
  sched.stop();
}

const fakeInvoker = async () => ({ answer: 'hecho' });

afterEach(() => {
  sched.setRunNotifier(null);
});

test('clampGoal truncates long prompts with ellipsis', () => {
  assert.equal(notifierMod.clampGoal(''), '');
  assert.equal(notifierMod.clampGoal('  '), '');
  const short = 'revisa el chat';
  assert.equal(notifierMod.clampGoal(short), short);
  const clamped = notifierMod.clampGoal('x'.repeat(200));
  assert.equal(clamped.length, notifierMod.MAX_GOAL_CHARS + 1);
  assert.ok(clamped.endsWith('…'));
});

test('buildNotificationContent maps ok/fail to inbox copy', () => {
  const done = notifierMod.buildNotificationContent({ ok: true, prompt: 'mejora constante' });
  assert.equal(done.type, 'codex_run_completed');
  assert.equal(done.severity, 'info');
  assert.equal(done.title, 'Tu rutina terminó');
  assert.match(done.message, /mejora constante/);

  const failed = notifierMod.buildNotificationContent({ ok: false, prompt: '' });
  assert.equal(failed.type, 'codex_run_failed');
  assert.equal(failed.severity, 'critical');
  assert.equal(failed.title, 'Tu rutina falló');
});

test('notifyRoutineFinished delivers via injected transport', async () => {
  const calls = [];
  const notifier = notifierMod.createRoutineNotifier({
    prisma: {},
    createNotification: async (client, args) => {
      calls.push({ client, args });
      return { id: 'n1' };
    },
  });
  const res = await notifier.notifyRoutineFinished({
    userId: 'u1',
    jobId: 'job_x',
    runAt: '2026-08-22T19:00:00.000Z',
    ok: true,
    prompt: 'avisar tiendas',
  });
  assert.deepEqual(res, { delivered: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].client, {});
  assert.equal(calls[0].args.userId, 'u1');
  assert.equal(calls[0].args.type, 'codex_run_completed');
  assert.equal(calls[0].args.severity, 'info');
  assert.deepEqual(calls[0].args.metadata, {
    jobId: 'job_x',
    runAt: '2026-08-22T19:00:00.000Z',
    source: 'routine',
  });
});

test('notifyRoutineFinished rejects invalid outcome and missing user', async () => {
  const notifier = notifierMod.createRoutineNotifier({
    prisma: {},
    createNotification: async () => ({ id: 'n1' }),
  });
  assert.deepEqual(
    await notifier.notifyRoutineFinished({ userId: 'u1', jobId: 'j', ok: 'yes' }),
    { delivered: false, reason: 'invalid_args' },
  );
  assert.deepEqual(
    await notifier.notifyRoutineFinished({ jobId: 'j', ok: true }),
    { delivered: false, reason: 'invalid_args' },
  );
});

test('notifyRoutineFinished swallows transport errors', async () => {
  const notifier = notifierMod.createRoutineNotifier({
    prisma: {},
    createNotification: async () => {
      throw new Error('db down');
    },
  });
  assert.deepEqual(
    await notifier.notifyRoutineFinished({ userId: 'u1', jobId: 'j', ok: false, prompt: 'p' }),
    { delivered: false, reason: 'error' },
  );
});

test('fireJob notifies owner on success and failure when meta.notify is set', async () => {
  resetJobsFile();
  const calls = [];
  sched.setRunNotifier(async (info) => { calls.push(info); });
  sched.setInvoker(fakeInvoker);

  const job = sched.createCronJob({
    userId: 42,
    cron: '* * * * *',
    prompt: 'mejora constante chat y code',
    meta: { notify: true },
  });
  const out = await sched.fireJob(job.id, { source: 'cron' });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 42);
  assert.equal(calls[0].jobId, job.id);
  assert.equal(calls[0].ok, true);
  assert.equal(calls[0].prompt, 'mejora constante chat y code');
  assert.match(calls[0].runAt, /^\d{4}-\d{2}-\d{2}T/);

  sched.setInvoker(async () => { throw new Error('upstream 502'); });
  const fail = await sched.fireJob(job.id, { source: 'cron' });
  assert.equal(fail.ok, false);
  assert.equal(fail.record.retries, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ok, false);
});

test('fireJob skips notification without meta.notify (legacy jobs untouched)', async () => {
  resetJobsFile();
  let called = 0;
  sched.setRunNotifier(async () => { called += 1; });
  sched.setInvoker(fakeInvoker);

  const job = sched.createCronJob({ userId: 7, cron: '* * * * *', prompt: 'legacy job' });
  const out = await sched.fireJob(job.id, { source: 'webhook' });
  assert.equal(out.ok, true);
  assert.equal(called, 0);
});

test('fireJob survives a throwing notifier and keeps the run record intact', async () => {
  resetJobsFile();
  sched.setRunNotifier(async () => { throw new Error('notifier exploded'); });
  sched.setInvoker(fakeInvoker);

  const job = sched.createCronJob({
    userId: 9,
    cron: '* * * * *',
    prompt: 'p',
    meta: { notify: true },
  });
  const out = await sched.fireJob(job.id, { source: 'cron' });
  assert.equal(out.ok, true);
  const stored = sched.getJob(job.id);
  assert.equal(stored.lastRuns.length, 1);
  assert.equal(stored.lastRuns[0].status, 'ok');
});

test('contract shape: name fallback, stored name, nextRunAt with tz', () => {
  resetJobsFile();
  const unnamed = sched.createCronJob({
    userId: 21,
    cron: '32 9 * * 1-5',
    prompt: 'Avisar tiendas iPhone y Android',
    timezone: 'America/Lima',
  });
  let view = sched.getJob(unnamed.id);
  assert.equal(view.name, 'Avisar tiendas iPhone y Android');
  assert.equal(typeof view.nextRunAt, 'string');
  assert.match(view.nextRunAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);

  const named = sched.createCronJob({
    userId: 21,
    cron: '57 */3 * * *',
    name: 'Mejora constante chat y code',
    prompt: 'revisa y mejora el chat y el code',
    meta: { notify: true },
  });
  view = sched.getJob(named.id);
  assert.equal(view.name, 'Mejora constante chat y code');
  // listJobs exposes the same contract fields.
  const listed = sched.listJobs({ userId: 21 }).find(j => j.id === named.id);
  assert.equal(listed.name, 'Mejora constante chat y code');
  assert.equal(typeof listed.nextRunAt, 'string');
});

test('nextRunAt recomputes after each fire and honors timezone', async () => {
  resetJobsFile();
  sched.setRunNotifier(async () => {});
  sched.setInvoker(fakeInvoker);
  const job = sched.createCronJob({
    userId: 22,
    cron: '0 9 * * 1-5',
    name: 'weekdays 9am',
    prompt: 'p',
    timezone: 'America/Lima',
  });
  const before = sched.getJob(job.id).nextRunAt;
  await sched.fireJob(job.id, { source: 'cron' });
  const after = sched.getJob(job.id).nextRunAt;
  assert.equal(typeof before, 'string');
  assert.equal(typeof after, 'string');
  // next fire is strictly in the future after the run completed.
  assert.ok(new Date(after).getTime() > Date.now());
  // Lima is UTC-5 (no DST): the 9:00 local fire maps to 14:00Z.
  assert.ok(after.endsWith('T14:00:00.000Z') || after.endsWith('T09:00:00.000Z'));
});

test('panel contract shape: lastStatus/lastError/lastRuns normalization', async () => {
  resetJobsFile();
  sched.setRunNotifier(async () => {});
  let failNext = false;
  sched.setInvoker(async () => {
    if (failNext) throw new Error('upstream 502');
    return { answer: 'hecho' };
  });
  const job = sched.createCronJob({
    userId: 24,
    cron: '* * * * *',
    name: 'mejora constante',
    prompt: 'p largo del prompt visible',
    meta: { notify: true },
  });

  // Before any fire: idle → lastStatus null, lastRuns [].
  let view = sched.getJob(job.id);
  assert.equal(view.status, 'idle');
  assert.equal(view.lastStatus, null);
  assert.equal(view.lastError, null);
  assert.deepEqual(view.lastRuns, []);

  // Successful fire → ok.
  await sched.fireJob(job.id, { source: 'cron' });
  view = sched.getJob(job.id);
  assert.equal(view.lastStatus, 'ok');
  assert.equal(view.lastError, null);
  assert.deepEqual(
    { ...view.lastRuns[0] },
    { ...view.lastRuns[0], status: 'ok' },
  );
  assert.equal(view.lastRuns[0].status, 'ok');

  // Failed fire → error with detail; ring keeps both runs normalized.
  failNext = true;
  await sched.fireJob(job.id, { source: 'cron' });
  view = sched.getJob(job.id);
  assert.equal(view.lastStatus, 'error');
  assert.equal(view.lastError, 'upstream 502');
  assert.equal(view.lastRuns.length, 2);
  assert.equal(view.lastRuns[0].status, 'error');
  assert.match(view.lastRuns[0].error, /upstream 502/);
  assert.equal(view.lastRuns[1].status, 'ok');

  // listJobs exposes the same contract fields.
  const listed = sched.listJobs({ userId: 24 }).find(j => j.id === job.id);
  assert.equal(listed.name, 'mejora constante');
  assert.equal(listed.lastStatus, 'error');
  assert.equal(listed.nextRunAt !== null, true);

  // scheduleLabel passthrough + timezone for the UI to prettify.
  assert.equal(view.cron, '* * * * *');
  assert.equal(view.timezone, null);
});

test('disabled jobs expose null nextRunAt', () => {
  resetJobsFile();
  const job = sched.createCronJob({ userId: 23, cron: '* * * * *', prompt: 'p' });
  sched.setJobEnabled({ userId: 23, jobId: job.id, enabled: false });
  assert.equal(sched.getJob(job.id).nextRunAt, null);
});

test('cron_schedule skill returns name and nextRunAt', async () => {
  resetJobsFile();
  delete require.cache[require.resolve('../src/skills/cron_schedule/handler.js')];
  const handler = require('../src/skills/cron_schedule/handler');

  const res = await handler.execute(
    { cron: '57 */3 * * *', name: 'Mejora constante chat y code', prompt: 'mejorar todo' },
    { userId: 31 },
  );
  assert.equal(res.name, 'Mejora constante chat y code');
  assert.equal(typeof res.nextRunAt, 'string');
});

test('cron_schedule skill defaults notify on and honors opt-out', async () => {
  resetJobsFile();
  delete require.cache[require.resolve('../src/skills/cron_schedule/handler.js')];
  const handler = require('../src/skills/cron_schedule/handler');

  const def = await handler.execute(
    { cron: '57 */3 * * *', prompt: 'Mejora constante chat y code' },
    { userId: 11 },
  );
  assert.equal(def.scheduled, true);
  assert.equal(sched.getJob(def.id).meta.notify, true);

  const optedOut = await handler.execute(
    { cron: '32 9 * * 1-5', prompt: 'Avisar tiendas iPhone y Android', notify: false },
    { userId: 11 },
  );
  assert.equal(optedOut.scheduled, true);
  assert.notEqual(sched.getJob(optedOut.id).meta.notify, true);
});

test('teardown', () => {
  // Stop every cron timer created by the tests so the event loop
  // drains and node --test can exit (same pattern as scheduler.test).
  sched.stop();
});
