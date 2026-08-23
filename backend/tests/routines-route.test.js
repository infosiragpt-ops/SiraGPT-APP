/**
 * routines route tests — CRUD + nextRunAt projection over the real
 * scheduler service.
 *
 * Hermeticity: the scheduler module captures its path constants at
 * require time (loadAll/saveAll close over them), so like
 * tests/scheduler.test.js we snapshot the real jobs file before the
 * suite and restore it after; every test resets the file to [].
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.AGENT_SCHEDULER = 'off';

const sched = require('../src/services/scheduler/scheduler');
const { serializeJob, computeNextRunAt } = require('../src/routes/routines');

const JOBS_FILE = sched._paths.JOBS_FILE;
let originalJobsRaw = null;

test.before(() => {
  try { originalJobsRaw = fs.readFileSync(JOBS_FILE, 'utf8'); } catch (_) { originalJobsRaw = null; }
});

test.after(() => {
  try {
    if (originalJobsRaw == null) fs.rmSync(JOBS_FILE, { force: true });
    else fs.writeFileSync(JOBS_FILE, originalJobsRaw);
  } catch (_) { /* best effort */ }
  sched.stop();
});

function resetJobsFile() {
  fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
  fs.writeFileSync(JOBS_FILE, '[]');
  sched.stop();
}

test('computeNextRunAt returns a future ISO instant for a valid cron', () => {
  const before = Date.now();
  const next = computeNextRunAt('*/30 * * * *', 'America/Lima');
  assert.ok(next, 'nextRunAt should not be null');
  const t = new Date(next).getTime();
  assert.ok(Number.isFinite(t), 'next is a parseable date');
  assert.ok(t > before - 60_000 && t < before + 31 * 60_000,
    'next fire of */30 must land within the next half hour');
});

test('computeNextRunAt respects timezone for fixed daily time', () => {
  // 09:32 Lima = 14:32 UTC (no DST in Peru). Next occurrence ≤ 24h out.
  const nowUtc = new Date();
  const next = computeNextRunAt('32 9 * * *', 'America/Lima');
  assert.ok(next);
  const hoursOut = (new Date(next) - nowUtc) / 3_600_000;
  assert.ok(hoursOut > 0 && hoursOut <= 24, `daily 09:32 Lima within 24h, got ${hoursOut.toFixed(2)}h`);
});

test('computeNextRunAt returns null for invalid cron instead of throwing', () => {
  assert.equal(computeNextRunAt('not-a-cron', null), null);
});

test('serializeJob exposes name from meta and honest status fields', () => {
  resetJobsFile();
  const job = sched.createCronJob({
    userId: 'user-1',
    cron: '0 */3 * * *',
    prompt: 'mejora constante del chat y code',
    timezone: 'America/Lima',
    meta: { name: 'Mejora constante chat y code' },
  });
  const view = serializeJob(sched.getJob(job.id));
  assert.equal(view.name, 'Mejora constante chat y code');
  assert.equal(view.cron, '0 */3 * * *');
  assert.equal(view.timezone, 'America/Lima');
  assert.equal(view.enabled, true);
  assert.ok(view.nextRunAt, 'enabled job has nextRunAt');
  assert.equal(view.lastStatus, null);
  assert.deepEqual(view.lastRuns, []);
  assert.ok(view.promptPreview.length <= 200);
  sched.cancelJob({ userId: 'user-1', jobId: job.id });
  assert.equal(sched.listJobs({ userId: 'user-1' }).length, 0, 'cancel removes the job');
});

test('serializeJob reflects lastRuns ring as lastStatus ok/error', () => {
  resetJobsFile();
  // Avoid a live fire during the test window: use a far-future minute.
  const job = sched.createCronJob({
    userId: 'user-2',
    cron: '59 23 31 12 *',
    prompt: 'p',
    meta: { name: 'n' },
  });
  // Simulate one failed run recorded by the engine (persisted via saveAll).
  sched.setJobEnabled({ userId: 'user-2', jobId: job.id, enabled: true });
  const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  raw[0].lastRuns = [{ at: new Date().toISOString(), ok: false, error: 'invoker boom' }];
  fs.writeFileSync(JOBS_FILE, JSON.stringify(raw));
  const view = serializeJob(sched.getJob(job.id));
  assert.equal(view.lastStatus, 'error');
  assert.equal(view.lastError, 'invoker boom');
  sched.cancelJob({ userId: 'user-2', jobId: job.id });
});

test('disabled job projects nextRunAt null', () => {
  resetJobsFile();
  const job = sched.createCronJob({
    userId: 'user-3',
    cron: '0 12 * * *',
    prompt: 'p',
    meta: { name: 'Avisar tiendas iPhone y Android' },
  });
  sched.setJobEnabled({ userId: 'user-3', jobId: job.id, enabled: false });
  const view = serializeJob(sched.getJob(job.id));
  assert.equal(view.enabled, false);
  assert.equal(view.nextRunAt, null);
  sched.cancelJob({ userId: 'user-3', jobId: job.id });
});
