'use strict';

/**
 * Tests for GET /api/admin/system-cron/jobs — surfaces the registered
 * cron jobs from `jobs/system-cron.js` for super-admin ops dashboards.
 *
 * We exercise the handler by mounting the admin router on a tiny Express
 * app and overriding `req.user` so `requireSuperAdmin` passes. The
 * `system-cron` module is stubbed via the require cache so the test
 * doesn't actually schedule any cron tasks.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// Stub the auth middleware module BEFORE admin routes load it. We need
// per-request overrides so each test can flip `isSuperAdmin` — wire that
// through a mutable `__nextUser` slot on the stubbed module.
const authPath = require.resolve('../src/middleware/auth');
const authStub = {
  __nextUser: null,
  authenticateToken(req, _res, next) {
    req.user = authStub.__nextUser || { id: 'anon', isAdmin: false, isSuperAdmin: false };
    next();
  },
  requireAdmin(req, res, next) {
    if (!req.user || (!req.user.isAdmin && !req.user.isSuperAdmin)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  requireSuperAdmin(req, res, next) {
    if (!req.user || !req.user.isSuperAdmin) {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  },
};
const restoreAuth = mockResolvedModule(authPath, authStub);

function buildApp(userOverrides = {}) {
  authStub.__nextUser = {
    id: 'super-1',
    isAdmin: true,
    isSuperAdmin: true,
    ...userOverrides,
  };
  const app = express();
  app.use(express.json());
  // Re-require admin AFTER cron stub is installed so it picks up the mock.
  const adminRoutes = require('../src/routes/admin');
  app.use('/api/admin', adminRoutes);
  return app;
}

describe('GET /api/admin/system-cron/jobs', () => {
  let restoreCron;

  before(() => {
    // Stub system-cron via require.cache before admin routes load it
    // lazily inside the handler.
    const cronPath = require.resolve('../src/jobs/system-cron');
    restoreCron = mockResolvedModule(cronPath, {
      status: () => ({
        enabled: true,
        tasks: [
          {
            name: 'scrub-deleted-user-content',
            schedule: '30 2 * * *',
            lastRun: '2026-05-19T02:30:00.000Z',
            lastDuration: 1234,
            lastStatus: 'ok',
            lastError: null,
            nextRun: '2026-05-20T02:30:00.000Z',
            intervalMs: 24 * 60 * 60 * 1000,
            stale: false,
            staleBy: null,
          },
          {
            name: 'sweep-old-audit-archives',
            schedule: '15 7 * * *',
            lastRun: null,
            lastDuration: null,
            lastStatus: null,
            lastError: null,
            nextRun: '2026-05-19T07:15:00.000Z',
            intervalMs: 24 * 60 * 60 * 1000,
            stale: false,
            staleBy: null,
          },
        ],
      }),
    });
  });

  after(() => {
    if (typeof restoreCron === 'function') restoreCron();
    if (typeof restoreAuth === 'function') restoreAuth();
  });

  test('returns 200 with the job list for super admins', async () => {
    const app = buildApp({ isSuperAdmin: true });
    const res = await request(app).get('/api/admin/system-cron/jobs');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.count, 2);
    assert.ok(Array.isArray(res.body.jobs));
    assert.equal(res.body.jobs.length, 2);
    const job = res.body.jobs.find((j) => j.name === 'scrub-deleted-user-content');
    assert.ok(job);
    assert.equal(job.schedule, '30 2 * * *');
    assert.equal(job.lastStatus, 'ok');
    assert.equal(job.lastDuration, 1234);
    assert.equal(job.nextRun, '2026-05-20T02:30:00.000Z');
    assert.equal(job.stale, false);
    assert.ok(typeof res.body.timestamp === 'string');
  });

  test('exposes the new sweep-old-audit-archives job in the listing', async () => {
    const app = buildApp({ isSuperAdmin: true });
    const res = await request(app).get('/api/admin/system-cron/jobs');
    assert.equal(res.status, 200);
    const sweep = res.body.jobs.find((j) => j.name === 'sweep-old-audit-archives');
    assert.ok(sweep, 'sweep-old-audit-archives should be registered');
    assert.equal(sweep.schedule, '15 7 * * *');
  });

  test('rejects non-super-admin callers with 403', async () => {
    const app = buildApp({ isSuperAdmin: false, isAdmin: true });
    const res = await request(app).get('/api/admin/system-cron/jobs');
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Super admin/);
  });

  test('falls back to empty list when status() throws', async () => {
    // Re-stub mid-flight with a throwing module.
    const cronPath = require.resolve('../src/jobs/system-cron');
    const undo = mockResolvedModule(cronPath, {
      status() { throw new Error('cron borked'); },
    });
    try {
      const app = buildApp({ isSuperAdmin: true });
      const res = await request(app).get('/api/admin/system-cron/jobs');
      assert.equal(res.status, 500);
      assert.match(res.body.error, /Failed to capture system-cron/);
    } finally {
      undo();
    }
  });

  test('handles cron disabled — returns enabled:false', async () => {
    const cronPath = require.resolve('../src/jobs/system-cron');
    const undo = mockResolvedModule(cronPath, {
      status: () => ({ enabled: false, tasks: [] }),
    });
    try {
      const app = buildApp({ isSuperAdmin: true });
      const res = await request(app).get('/api/admin/system-cron/jobs');
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, false);
      assert.equal(res.body.count, 0);
      assert.deepEqual(res.body.jobs, []);
    } finally {
      undo();
    }
  });
});
