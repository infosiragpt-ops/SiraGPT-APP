'use strict';

/**
 * Tests for jobs/sweep-artifact-lifecycle.js and its registration in
 * jobs/system-cron.js.
 *
 * The lifecycle sweep must:
 *   - prune snapshots, purge DB-orphaned GeneratedArtifact rows, and
 *     clean unreferenced artifact files in one pass;
 *   - purge the R2 mirror of an orphan BEFORE dropping its metadata;
 *   - be registered in the system-cron registry so it actually runs
 *     in production (the original audit finding was that the whole
 *     lifecycle layer was dead code).
 *
 * Prisma/DB is stubbed at module load; R2 is stubbed via the
 * object-storage test seam.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Prisma stub BEFORE any module that touches the database loads. The
// persistence layer checks `hasModel('generatedArtifact')` via the
// prisma client's model map.
const prismaPath = require.resolve('../src/config/database');
const { mockResolvedModule } = require('./http-test-utils');
const restorePrisma = mockResolvedModule(prismaPath, {
  generatedArtifact: {
    findMany: async ({ select }) => [],
    deleteMany: async () => ({ count: 0 }),
  },
  agentTask: { findMany: async () => [] },
});

const taskStore = require('../src/services/agents/task-store');
const objectStorage = require('../src/services/object-storage');

describe('sweep-artifact-lifecycle job', () => {
  test('runs prune + purge + cleanup in one pass and purges the R2 mirror', async () => {
    process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-sweep-store-'));
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-sweep-art-'));
    process.env.AGENT_ARTIFACT_DIR = artifactDir;

    // Old completed snapshot referencing an artifact → pruned, artifact
    // becomes orphan, then swept (payload + metadata + R2 object).
    const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    taskStore.writeTaskSnapshot({
      taskId: 'sweep-1',
      userId: 'u',
      status: 'completed',
      createdAt: oldIso,
      updatedAt: oldIso,
      artifacts: [{ id: 'aaaaaaaaaaaaaaaa', filename: 'old.pdf' }],
    });
    fs.writeFileSync(path.join(artifactDir, 'aaaaaaaaaaaaaaaa-old.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(artifactDir, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({
      id: 'aaaaaaaaaaaaaaaa',
      createdAt: oldIso,
      storageRef: 'r2:agent-artifacts/reports/old.pdf',
    }));

    const deletedKeys = [];
    const fakeStorage = {
      enabled: true,
      delete: async (key) => { deletedKeys.push(key); },
      head: async (key) => {
        if (deletedKeys.includes(key)) {
          const err = new Error('NotFound');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { ContentLength: 10 };
      },
    };
    objectStorage.__setStorageForTests(fakeStorage);
    try {
      const job = require('../src/jobs/sweep-artifact-lifecycle');
      const res = await job.run({ retentionMs: 30 * 24 * 60 * 60 * 1000 });

      assert.equal(res.dryRun, false);
      assert.ok(res.prune.deleted >= 1, 'snapshot should be pruned');
      assert.ok(res.purge, 'db orphan purge should run');
      assert.equal(res.cleanup.remotePurged, 1);
      assert.equal(res.cleanup.removed, 2);
      assert.deepEqual(deletedKeys, ['agent-artifacts/reports/old.pdf']);
      assert.ok(!fs.existsSync(path.join(artifactDir, 'aaaaaaaaaaaaaaaa.json')));
    } finally {
      delete process.env.AGENT_ARTIFACT_DIR;
      objectStorage.__setStorageForTests(undefined);
    }
  });

  test('dry-run scans without deleting anything', async () => {
    process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-sweep-dry-'));
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-sweep-dry-art-'));
    process.env.AGENT_ARTIFACT_DIR = artifactDir;

    const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(artifactDir, 'bbbbbbbbbbbbbbbb-old.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(artifactDir, 'bbbbbbbbbbbbbbbb.json'), JSON.stringify({
      id: 'bbbbbbbbbbbbbbbb',
      createdAt: oldIso,
      storageRef: 'r2:agent-artifacts/x.pdf',
    }));

    let deleteCalls = 0;
    objectStorage.__setStorageForTests({
      enabled: true,
      delete: async () => { deleteCalls++; },
      head: async () => ({ ContentLength: 10 }),
    });
    try {
      const job = require('../src/jobs/sweep-artifact-lifecycle');
      const res = await job.run({ dryRun: true });

      assert.equal(res.dryRun, true);
      assert.equal(res.cleanup.scanned, 1);
      assert.equal(res.cleanup.removed, 0);
      assert.equal(deleteCalls, 0);
      assert.ok(fs.existsSync(path.join(artifactDir, 'bbbbbbbbbbbbbbbb.json')));
    } finally {
      delete process.env.AGENT_ARTIFACT_DIR;
      objectStorage.__setStorageForTests(undefined);
    }
  });
});

describe('system-cron registration', () => {
  test('sweep-artifact-lifecycle is registered with a daily schedule', () => {
    // system-cron is disabled under NODE_ENV=test; start() with the flag
    // forced on registers every job. We inspect the returned registry.
    process.env.SYSTEM_CRON_ENABLED = 'true';
    delete process.env.NODE_ENV;
    const cronModule = require('../src/jobs/system-cron');
    const state = cronModule.start();
    try {
      assert.equal(state.enabled, true);
      const task = state.tasks.find((t) => t.name === 'sweep-artifact-lifecycle');
      assert.ok(task, 'sweep-artifact-lifecycle must be registered');
      assert.equal(task.schedule, process.env.SYSTEM_CRON_ARTIFACT_LIFECYCLE_SWEEP_SCHEDULE || '20 5 * * *');
      const status = cronModule.status();
      const entry = status.tasks.find((t) => t.name === 'sweep-artifact-lifecycle');
      assert.ok(entry, 'status() should surface the new job');
      assert.ok(entry.nextRun, 'status() should compute nextRun for the new job');
    } finally {
      cronModule.stop();
      delete process.env.SYSTEM_CRON_ENABLED;
      process.env.NODE_ENV = 'test';
    }
  });
});
