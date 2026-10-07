'use strict';

// Production log 2026-10-07 (15:10 → 18:45 UTC): routine housekeeping and
// leftover debug prints were the loudest lines. These tests pin the quiet
// behaviour so Admin → Logs keeps WARN/ERROR for real failures.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const goalCleanup = require('../src/services/goal-cleanup');
const mediaQueue = require('../src/services/media-transcription-queue');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function captureLogger() {
  const entries = [];
  return {
    entries,
    debug(fields, message) { entries.push({ level: 'debug', fields, message }); },
    info(fields, message) { entries.push({ level: 'info', fields, message }); },
    warn(fields, message) { entries.push({ level: 'warn', fields, message }); },
  };
}

function fakePrisma({ count = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    goalRun: {
      async deleteMany(args) {
        calls.push(args);
        if (fail) throw fail;
        return { count };
      },
    },
  };
}

test('goal-cleanup: deleting terminal runs past retention is INFO, both at boot and on the interval', async () => {
  const logger = captureLogger();
  const prisma = fakePrisma({ count: 4 });
  const summary = await goalCleanup.startGoalCleanup({ logger, prisma, runInterval: false, env: { GOAL_CLEANUP_RETENTION_MS: '1000' } });
  assert.equal(summary.deleted, 4);
  assert.equal(prisma.calls.length, 1);
  assert.deepEqual(prisma.calls[0].where.status, { in: ['completed', 'failed', 'cancelled'] });
  const completed = logger.entries.find((e) => e.message === 'goal_cleanup_boot_completed');
  assert.ok(completed, 'boot pass reports the deletion');
  assert.equal(completed.level, 'info');
  assert.equal(completed.fields.deleted, 4);
  assert.equal(logger.entries.filter((e) => e.level === 'warn').length, 0, 'routine retention never warns');

  const source = read('src/services/goal-cleanup.js');
  const interval = source.slice(source.indexOf('cleanupInterval = setInterval('));
  assert.match(interval, /logInfo\(\s*logger,[\s\S]*?'goal_cleanup_interval_completed'/);
  assert.doesNotMatch(interval.slice(0, interval.indexOf('goal_cleanup_interval_completed')), /logWarn\(/);
});

test('goal-cleanup: a database error during the sweep is still a WARN and never throws', async () => {
  const logger = captureLogger();
  const prisma = fakePrisma({ fail: new Error('connection reset') });
  const result = await goalCleanup.runGoalCleanupSweep({ logger, prisma });
  assert.equal(result.deleted, 0);
  assert.equal(result.error, 'connection reset');
  const failed = logger.entries.find((e) => e.message === 'goal_cleanup_sweep_failed');
  assert.equal(failed.level, 'warn');
});

test('google OAuth callbacks no longer print debug lines to stdout', () => {
  const passport = read('src/config/passport.js');
  assert.doesNotMatch(passport, /console\.log\('Google OAuth callback/);
  assert.match(passport, /googleAuth\.handleVerify\(\{ accessToken, refreshToken, profile \}\)/);
  const auth = read('src/routes/auth.js');
  assert.doesNotMatch(auth, /General Google OAuth callback triggered/);
});

test('media recovery sweep: one-minute cadence with an env floor, bounded pages, narrow columns', () => {
  assert.equal(mediaQueue.RECONCILE_INTERVAL_MS, 60_000);
  assert.equal(mediaQueue.RECONCILE_PAGE_SIZE, 100);
  assert.ok(mediaQueue.RECONCILE_MAX_ROWS >= 100);
  assert.equal(mediaQueue.RECONCILE_SELECT.extractedText, undefined);
  assert.deepEqual(Object.keys(mediaQueue.RECONCILE_SELECT).sort(),
    ['id', 'mimeType', 'originalName', 'processingStage', 'processingStageAt', 'userId']);
  const where = mediaQueue.pendingMediaWhere(Date.parse('2026-10-07T18:00:00Z'));
  assert.deepEqual(where.processingStage, { in: ['uploaded', 'validating', 'extracting'] });
  assert.equal(where.deletedAt, null);
  assert.equal(where.AND.length, 2);
  const source = read('src/services/media-transcription-queue.js');
  assert.match(source, /setInterval\(\(\) => \{ void ensureRunning\(\); void reconcile\(\); \}, RECONCILE_INTERVAL_MS\)/);
  assert.match(source, /SIRAGPT_MEDIA_RECONCILE_INTERVAL_MS/);
  assert.match(source, /SIRAGPT_MEDIA_RECONCILE_MAX_ROWS/);
});

test('stripe recovery: the idle heartbeat is debug-level in source', () => {
  const source = read('src/services/stripe-webhook-recovery.js');
  assert.match(source, /log\(idle \? 'debug' : 'info', \{ \.\.\.result, idle \}, 'stripe_webhook_recovery_completed'\)/);
});
