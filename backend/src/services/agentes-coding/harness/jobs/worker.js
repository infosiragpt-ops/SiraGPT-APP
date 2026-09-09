'use strict';

/**
 * Harness job worker (Phase 4c).
 *
 * Continues the in-process tool loop from a persisted snapshot. Flag off
 * or missing Redis ⇒ no-op (Lenovo-safe). Injectable processor / queue
 * for unit tests — no real Redis in the default CI path.
 */

const { isAgentesCodingV2Enabled } = require('../../flags');
const { fail } = require('../../coding-sandbox/errors');
const { getStore } = require('../store');
const { grantTool } = require('../permissions');
const {
  continueHarness,
  resumeHarness,
  cancelActiveRun,
} = require('../runner');
const { serializeRun, hydrateRun } = require('./snapshot');
const { jobIdFor, QUEUE_NAME } = require('./queue');

function attachRun(raw, row) {
  const store = getStore(raw);
  const idx = store.items.findIndex((item) => item.id === row.id);
  if (idx >= 0) store.items[idx] = row;
  else store.items.push(row);
  for (const tool of row.grants || []) grantTool(raw, tool);
}

async function persist(ctx, raw, row, sessionId) {
  const snapshot = serializeRun(row, { sessionId, raw });
  await ctx.store.save(snapshot);
  return snapshot;
}

async function loadRow(ctx, data) {
  const runId = String((data && data.runId) || '').trim();
  if (!runId) fail('E_PARAMS', 'Falta el id de ejecución del harness.');
  const snapshot = (await ctx.store.get(runId)) || (data && data.snapshot) || null;
  if (!snapshot) fail('E_HARNESS_NOT_FOUND');
  const row = hydrateRun(snapshot);
  if (!row) fail('E_HARNESS_NOT_FOUND');
  return { row, snapshot };
}

async function requireRaw(ctx, sessionId) {
  const sandbox = ctx.sandbox;
  if (!sandbox || typeof sandbox.listFiles !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  await sandbox.listFiles(sessionId, '.');
  const raw = typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) fail('E_SESSION_NOT_FOUND');
  return raw;
}

async function processHarnessJob(job, ctx = {}) {
  const data = (job && job.data) || {};
  const action = String(data.action || 'start');
  const { row, snapshot } = await loadRow(ctx, data);
  const sessionId = String(data.sessionId || snapshot.sessionId || row.sessionId || '');
  if (!sessionId) fail('E_PARAMS', 'Falta el id de sesión del harness.');
  const raw = await requireRaw(ctx, sessionId);
  attachRun(raw, row);
  if (ctx.permissionPolicy) row.permissionPolicy = ctx.permissionPolicy;

  if (action === 'cancel' || row.cancelRequested) {
    if (row.status === 'running' || row.status === 'awaiting_permission') {
      cancelActiveRun(row);
    }
    const saved = await persist(ctx, raw, row, sessionId);
    return { ok: true, run: saved, action: 'cancel' };
  }

  try {
    if (action === 'resume') {
      const out = await resumeHarness(
        ctx.sandbox,
        sessionId,
        raw,
        row,
        data.permissionId,
        data.decision,
        { llmTurn: ctx.llmTurn },
      );
      await persist(ctx, raw, row, sessionId);
      return out;
    }

    if (row.status !== 'running') {
      await persist(ctx, raw, row, sessionId);
      return { ok: true, run: serializeRun(row, { sessionId, raw }), action };
    }

    const run = await continueHarness(ctx.sandbox, sessionId, raw, row, {
      llmTurn: ctx.llmTurn,
    });
    await persist(ctx, raw, row, sessionId);
    return { ok: true, run, action };
  } catch (err) {
    try { await persist(ctx, raw, row, sessionId); } catch (_) { /* keep original */ }
    throw err;
  }
}

function startHarnessWorker(opts = {}) {
  const env = opts.env || process.env;
  if (!isAgentesCodingV2Enabled(env)) return null;

  if (opts.queue && typeof opts.processor === 'function') {
    return {
      kind: 'injected',
      queue: opts.queue,
      async close() {
        if (opts.queue && typeof opts.queue.close === 'function') {
          await opts.queue.close();
        }
      },
    };
  }

  const redisUrl = String(env.REDIS_URL || '').trim();
  if (!redisUrl) return null;
  if (/^(0|false|off)$/i.test(String(env.AGENTES_CODING_HARNESS_JOBS || '').trim())) {
    return null;
  }

  const { Worker } = require('bullmq');
  const IORedis = require('ioredis');
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const processor = opts.processor || (async (job) => processHarnessJob(job, {
    sandbox: typeof opts.getSandbox === 'function' ? opts.getSandbox() : opts.sandbox,
    store: opts.store,
    llmTurn: opts.llmTurn,
    permissionPolicy: opts.permissionPolicy,
  }));
  const worker = new Worker(opts.queueName || QUEUE_NAME, processor, {
    connection,
    concurrency: 1,
  });
  return {
    kind: 'bullmq',
    worker,
    connection,
    async close() {
      try { await worker.close(); } catch (_) { /* ignore */ }
      try { await connection.quit(); } catch (_) {
        try { connection.disconnect(); } catch { /* ignore */ }
      }
    },
  };
}

module.exports = {
  attachRun,
  processHarnessJob,
  startHarnessWorker,
  jobIdFor,
};
