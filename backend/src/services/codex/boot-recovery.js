'use strict';

/**
 * codex/boot-recovery — crash recovery sweep for runs interrupted by a process
 * restart (feature 05, mirrors goal-boot-recovery). Runs once at boot when the
 * flag is on. Two failure modes:
 *
 *   a) Zombie `running`: a worker claimed the job and flipped the row to
 *      `running`, then the process died. Active swarms resume from their
 *      durable session; paused swarms become a queued, non-executable deferral
 *      until an explicit resume; terminal/cancelled swarms fail closed.
 *   b) Stuck `queued`: the row was persisted but its job is no longer in the
 *      queue (enqueue blip / lost on restart). We re-enqueue with a unique,
 *      queue-valid generation guarded by a database lease.
 *
 * Never throws out of either entry point — a DB/Redis blip logs and returns
 * zero counts. prisma/queue/eventStore are injectable for offline tests.
 */

const { isCodexV2Enabled } = require('./flags');
const { createSessionService, snapshotIsResumable } = require('./session-service');
const { inspectSwarmRunState } = require('./swarm-run-state');

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();
const runQueueDefault = (() => {
  try { return require('./run-queue'); } catch { return null; }
})();
const eventStoreDefault = (() => {
  try { return require('./event-store'); } catch { return null; }
})();

const INTERRUPTED_MSG = 'Corrida interrumpida por reinicio del backend';
const RESUME_MARKER = 'Reanudando tras reinicio del servidor';
const PAUSED_SWARM_MARKER = 'Corrida deferida mientras el enjambre está pausado';
const TERMINAL_SWARM_MSG = 'Corrida cerrada porque su enjambre ya terminó';
const MAX_BOOT_RESUMES = 2;
const DEFAULT_QUEUED_RECONCILE_AFTER_MS = 30_000;
const DEFAULT_QUEUED_RECONCILE_INTERVAL_MS = 15_000;
const DEFAULT_QUEUED_RECONCILE_BATCH = 200;
const queuedRecoveryTails = new Map();
let queuedReconcilerRuntime = null;

function nonNegativeInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function queuedReconcilerConfig(env = process.env) {
  return {
    staleAfterMs: nonNegativeInteger(
      env.CODEX_QUEUED_RECONCILE_AFTER_MS,
      DEFAULT_QUEUED_RECONCILE_AFTER_MS,
    ),
    intervalMs: nonNegativeInteger(
      env.CODEX_QUEUED_RECONCILE_INTERVAL_MS,
      DEFAULT_QUEUED_RECONCILE_INTERVAL_MS,
    ),
    batchSize: Math.max(1, Math.min(1_000, nonNegativeInteger(
      env.CODEX_QUEUED_RECONCILE_BATCH,
      DEFAULT_QUEUED_RECONCILE_BATCH,
    ))),
  };
}

function logRecoveryWarning(logger, fields, message, env = process.env) {
  if (logger && typeof logger.warn === 'function') logger.warn(fields, message);
  else if (env.NODE_ENV !== 'test') console.warn(`[codex queued-reconciler] ${message}:`, fields);
}

async function cancelRunFromCancelledSwarm({ prisma, queue, eventStore, run, clock }) {
  const cancelled = await conditionalRunUpdate(prisma, {
    id: run.id,
    status: run.status,
  }, {
    status: 'cancelled',
    finishedAt: clock(),
  });
  if (!cancelled?.count) return false;
  if (queue?.cancelQueuedCodexRun) {
    await queue.cancelQueuedCodexRun(run.jobId || run.id).catch(() => {});
  }
  if (eventStore?.appendEvent) {
    await eventStore.appendEvent(run.id, 'run_status', {
      status: 'cancelled',
      reason: 'swarm_cancelled',
    }, { prisma }).catch(() => {});
  }
  return true;
}

async function errorRunFromTerminalSwarm({ prisma, queue, eventStore, run, clock, swarmState }) {
  const status = String(swarmState?.status || 'terminal').trim() || 'terminal';
  const message = `${TERMINAL_SWARM_MSG} (${status})`;
  const errored = await conditionalRunUpdate(prisma, {
    id: run.id,
    status: run.status,
  }, {
    status: 'error',
    error: message,
    finishedAt: clock(),
  });
  if (!errored?.count) return false;
  if (queue?.cancelQueuedCodexRun) {
    await queue.cancelQueuedCodexRun(run.jobId || run.id).catch(() => {});
  }
  if (eventStore?.appendEvent) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `${message}.`,
    }, { prisma }).catch(() => {});
    await eventStore.appendEvent(run.id, 'run_status', {
      status: 'error',
      reason: 'swarm_terminal',
      swarmStatus: status,
    }, { prisma }).catch(() => {});
  }
  return true;
}

async function deferRunFromPausedSwarm({ prisma, eventStore, run, clock }) {
  const deferred = await conditionalRunUpdate(prisma, {
    id: run.id,
    status: 'running',
  }, {
    status: 'queued',
    error: null,
    finishedAt: null,
    updatedAt: clock(),
  });
  if (!deferred?.count) return false;
  if (eventStore?.appendEvent) {
    await eventStore.appendEvent(run.id, 'narrative_delta', {
      text: `${PAUSED_SWARM_MARKER}; continuará al reanudarlo.`,
    }, { prisma }).catch(() => {});
    await eventStore.appendEvent(run.id, 'run_status', {
      status: 'queued',
      reason: 'swarm_paused',
    }, { prisma }).catch(() => {});
  }
  return true;
}

async function conditionalRunUpdate(prisma, where, data) {
  if (typeof prisma.codexRun.updateMany === 'function') {
    return prisma.codexRun.updateMany({ where, data });
  }
  // Small test doubles and older embedders may only expose update. Production
  // Prisma always takes the atomic updateMany path above.
  await prisma.codexRun.update({ where: { id: where.id }, data });
  return { count: 1 };
}

async function withQueuedRecoveryLock(runId, work) {
  const key = String(runId);
  const previous = queuedRecoveryTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  queuedRecoveryTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (queuedRecoveryTails.get(key) === current) queuedRecoveryTails.delete(key);
  }
}

async function peekLiveJobForRun(queue, run) {
  const peek = queue && (queue.peekLiveCodexJob || queue.peekCodexJob);
  if (!peek) return null;
  const persistedJobId = String(run?.jobId || '').trim();
  if (persistedJobId) {
    const persisted = await peek.call(queue, persistedJobId);
    if (persisted) return persisted;
  }
  if (!persistedJobId || persistedJobId !== String(run.id)) {
    return peek.call(queue, run.id);
  }
  return null;
}

async function resumeSnapshotPointer({ sessionService, run }) {
  if (!sessionService || typeof sessionService.readSnapshot !== 'function') return null;
  const snapshot = await sessionService.readSnapshot({
    projectId: run.projectId,
    sessionId: run.id,
  });
  if (!snapshotIsResumable(snapshot) || snapshot.sessionId !== String(run.id)) return null;
  return {
    sessionId: snapshot.sessionId,
    cursorSeq: snapshot.cursorSeq,
    checkpointSha: snapshot.checkpointSha || null,
  };
}

/**
 * Re-enqueue Codex runs that were durably deferred by a paused swarm. This is
 * called immediately after the swarm transitions back to `running`. A live
 * BullMQ job always wins; otherwise jobId is first leased in Postgres so two
 * backend replicas cannot publish duplicate live jobs for the same run.
 */
async function resumeDeferredSwarmRuns({
  prisma = defaultPrisma,
  queue = runQueueDefault,
  eventStore = eventStoreDefault,
  sessionService = null,
  swarmId,
  env = process.env,
  clock = () => new Date(),
  logger = null,
} = {}) {
  const result = {
    scanned: 0,
    reenqueued: 0,
    live: 0,
    leaseLost: 0,
    skipped: 0,
    failed: 0,
  };
  const id = String(swarmId || '').trim();
  if (
    !id
    || !isCodexV2Enabled(env)
    || !prisma?.codexSwarmTask?.findMany
    || !prisma?.codexRun?.findMany
    || !queue?.enqueueCodexRun
  ) return result;

  let runs;
  try {
    const tasks = await prisma.codexSwarmTask.findMany({
      where: { swarmId: id },
      select: { id: true },
    });
    const taskIds = tasks.map((task) => String(task?.id || '').trim()).filter(Boolean);
    if (!taskIds.length) return result;
    runs = await prisma.codexRun.findMany({
      where: {
        status: 'queued',
        swarmTaskId: { in: taskIds },
      },
      orderBy: { updatedAt: 'asc' },
      take: 1_000,
    });
  } catch (error) {
    result.failed += 1;
    logRecoveryWarning(logger, { swarmId: id, error: error?.message || String(error) }, 'codex_swarm_resume_scan_failed', env);
    return result;
  }

  const sessionsEnabled = !/^(0|false|off|no)$/i.test(String(
    env.CODEX_SESSION_ARTIFACTS ?? (env.NODE_ENV === 'production' ? '1' : '0'),
  ));
  const durableSessionService = sessionService
    || (sessionsEnabled && prisma.codexSessionState ? createSessionService({ db: prisma, clock }) : null);
  const resumedAt = clock();
  result.scanned = runs.length;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    try {
      await withQueuedRecoveryLock(run.id, async () => {
        const swarmState = await inspectSwarmRunState({ prisma, run });
        if (!swarmState.recoverable) {
          result.skipped += 1;
          return;
        }
        const liveJob = await peekLiveJobForRun(queue, run);
        if (liveJob) {
          result.live += 1;
          return;
        }

        let snapshot = null;
        try {
          snapshot = await resumeSnapshotPointer({ sessionService: durableSessionService, run });
        } catch (error) {
          logRecoveryWarning(
            logger,
            { runId: run.id, error: error?.message || String(error) },
            'codex_swarm_resume_snapshot_failed',
            env,
          );
        }

        const jobId = `${run.id}-sr${resumedAt.getTime()}-${index + 1}`;
        let lease = { count: 1 };
        if (typeof prisma.codexRun.updateMany === 'function') {
          const where = { id: run.id, status: 'queued' };
          if (run.updatedAt) where.updatedAt = run.updatedAt;
          if (Object.prototype.hasOwnProperty.call(run, 'jobId')) where.jobId = run.jobId;
          lease = await prisma.codexRun.updateMany({
            where,
            data: { jobId, updatedAt: resumedAt },
          });
        }
        if (!lease?.count) {
          result.leaseLost += 1;
          return;
        }
        if (typeof prisma.codexRun.updateMany !== 'function' && typeof prisma.codexRun.update === 'function') {
          await prisma.codexRun.update({ where: { id: run.id }, data: { jobId, updatedAt: resumedAt } });
        }

        await queue.enqueueCodexRun({
          runId: run.id,
          jobId,
          ...(snapshot ? { resumeSnapshot: snapshot } : {}),
        });
        if (eventStore?.appendEvent) {
          await eventStore.appendEvent(run.id, 'narrative_delta', {
            text: `${RESUME_MARKER} — el enjambre volvió a estar activo.`,
          }, { prisma }).catch(() => {});
        }
        result.reenqueued += 1;
      });
    } catch (error) {
      result.failed += 1;
      logRecoveryWarning(
        logger,
        { runId: run.id, swarmId: id, error: error?.message || String(error) },
        'codex_swarm_resume_reenqueue_failed',
        env,
      );
    }
  }
  return result;
}

function deferredRecoveryIncomplete(summary) {
  return ['failed', 'leaseLost', 'skipped']
    .some((key) => Number(summary?.[key]) > 0);
}

/**
 * Retry the idempotent resume sweep once. The first attempt may have already
 * published some jobs; a second sweep observes those as live and only retries
 * rows that still lack a live job. Returning the final attempt separately
 * keeps the HTTP contract honest without double-counting successful runs.
 */
async function resumeDeferredSwarmRunsReliably({ maxAttempts = 2, ...options } = {}) {
  const limit = Math.max(1, Math.min(3, Number.parseInt(maxAttempts, 10) || 2));
  const attempts = [];
  let final = null;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    final = await resumeDeferredSwarmRuns(options);
    attempts.push(final);
    if (!deferredRecoveryIncomplete(final)) break;
  }
  return {
    ...(final || {
      scanned: 0,
      reenqueued: 0,
      live: 0,
      leaseLost: 0,
      skipped: 0,
      failed: 0,
    }),
    complete: !deferredRecoveryIncomplete(final),
    attemptCount: attempts.length,
    attempts,
  };
}

/**
 * Periodic queued-only reconciliation. Unlike boot recovery it never touches a
 * legitimate `running` row. A stale `queued` row is leased atomically by
 * bumping updatedAt before enqueue, so concurrent backend replicas cannot both
 * recover it. A failed retry simply becomes eligible again after staleAfterMs.
 */
async function reconcileQueuedCodexRuns({
  prisma = defaultPrisma,
  queue = runQueueDefault,
  eventStore = eventStoreDefault,
  env = process.env,
  clock = () => new Date(),
  logger = null,
  staleAfterMs = queuedReconcilerConfig(env).staleAfterMs,
  batchSize = queuedReconcilerConfig(env).batchSize,
} = {}) {
  const result = {
    scanned: 0,
    reenqueuedQueued: 0,
    liveQueued: 0,
    leaseLost: 0,
    cancelled: 0,
    terminalized: 0,
    deferredPaused: 0,
    failed: 0,
  };
  if (!isCodexV2Enabled(env) || !prisma?.codexRun || !queue?.enqueueCodexRun) return result;

  const now = clock();
  const cutoff = new Date(now.getTime() - Math.max(0, Number(staleAfterMs) || 0));
  let queued;
  try {
    queued = await prisma.codexRun.findMany({
      where: { status: 'queued', updatedAt: { lte: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: Math.max(1, Math.min(1_000, Number(batchSize) || DEFAULT_QUEUED_RECONCILE_BATCH)),
    });
  } catch (error) {
    logRecoveryWarning(logger, { error: error?.message || String(error) }, 'codex_queued_scan_failed', env);
    return result;
  }

  result.scanned = queued.length;
  for (const run of queued) {
    try {
      await withQueuedRecoveryLock(run.id, async () => {
        const swarmState = await inspectSwarmRunState({ prisma, run });
        if (swarmState.deferred) {
          // Paused rows stay queued and are intentionally not published. Move
          // them out of the oldest bounded window so active orphans behind a
          // large paused fleet are still reached by the next tick.
          const rotated = await conditionalRunUpdate(prisma, {
            id: run.id,
            status: 'queued',
            updatedAt: { lte: cutoff },
          }, { updatedAt: now });
          if (rotated?.count) result.deferredPaused += 1;
          else result.leaseLost += 1;
          return;
        }
        if (!swarmState.recoverable) {
          if (swarmState.cancelled) {
            const changed = await cancelRunFromCancelledSwarm({
              prisma,
              queue,
              eventStore,
              run,
              clock,
            });
            if (changed) result.cancelled += 1;
          } else if (swarmState.reason === 'swarm_terminal') {
            const changed = await errorRunFromTerminalSwarm({
              prisma,
              queue,
              eventStore,
              run,
              clock,
              swarmState,
            });
            if (changed) result.terminalized += 1;
          }
          return;
        }

        const liveJob = await peekLiveJobForRun(queue, run);
        if (liveJob) {
          // Rotate confirmed-live rows out of the oldest stale window. Without
          // this heartbeat, a full batch of healthy queued jobs stays at the
          // head of every ordered scan forever and starves older orphaned rows
          // that sit just beyond `take`. The conditional update is deliberately
          // limited to the same stale queued snapshot; a worker/status change
          // racing this check wins, and neither status nor jobId is modified.
          if (typeof prisma.codexRun.updateMany === 'function') {
            await prisma.codexRun.updateMany({
              where: { id: run.id, status: 'queued', updatedAt: { lte: cutoff } },
              data: { updatedAt: now },
            });
          }
          result.liveQueued += 1;
          return;
        }

        // Production Prisma always exposes updateMany. Keeping the fallback
        // makes offline embedders/tests usable, while the real path is an
        // atomic cross-replica lease guarded by status + staleness.
        let lease = { count: 1 };
        if (typeof prisma.codexRun.updateMany === 'function') {
          lease = await prisma.codexRun.updateMany({
            where: { id: run.id, status: 'queued', updatedAt: { lte: cutoff } },
            data: { updatedAt: now },
          });
        }
        if (!lease?.count) {
          result.leaseLost += 1;
          return;
        }

        const recoveryWindow = Math.max(1, Number(staleAfterMs) || DEFAULT_QUEUED_RECONCILE_AFTER_MS);
        // BullMQ rejects custom job IDs containing `:`. Use a dash-delimited
        // recovery generation so the job is both unique and queue-valid.
        const jobId = `${run.id}-qr${Math.floor(now.getTime() / recoveryWindow)}`;
        const job = await queue.enqueueCodexRun({ runId: run.id, jobId });
        const persistedJobId = String(job?.id || jobId);
        if (typeof prisma.codexRun.updateMany === 'function') {
          await prisma.codexRun.updateMany({
            where: { id: run.id, status: 'queued' },
            data: { jobId: persistedJobId },
          });
        } else if (typeof prisma.codexRun.update === 'function') {
          await prisma.codexRun.update({
            where: { id: run.id },
            data: { jobId: persistedJobId },
          });
        }
        result.reenqueuedQueued += 1;
      });
    } catch (error) {
      result.failed += 1;
      logRecoveryWarning(
        logger,
        { runId: run.id, error: error?.message || String(error) },
        'codex_queued_reenqueue_failed',
        env,
      );
    }
  }
  return result;
}

function startQueuedRunReconciler({
  prisma = defaultPrisma,
  queue = runQueueDefault,
  eventStore = eventStoreDefault,
  env = process.env,
  clock = () => new Date(),
  logger = null,
  scheduler = { setInterval, clearInterval },
  reconcile = reconcileQueuedCodexRuns,
} = {}) {
  if (queuedReconcilerRuntime || !isCodexV2Enabled(env)) return false;
  const config = queuedReconcilerConfig(env);
  if (config.intervalMs <= 0) return false;

  const runtime = {
    stopped: false,
    inFlight: null,
    scheduler,
    timer: null,
  };
  const tick = () => {
    if (runtime.stopped || runtime.inFlight) return runtime.inFlight;
    runtime.inFlight = Promise.resolve().then(() => reconcile({
      prisma,
      queue,
      eventStore,
      env,
      clock,
      logger,
      staleAfterMs: config.staleAfterMs,
      batchSize: config.batchSize,
    })).then((summary) => {
      if (summary?.reenqueuedQueued || summary?.cancelled || summary?.terminalized || summary?.failed) {
        logRecoveryWarning(logger, { ...summary, scope: 'interval' }, 'codex_queued_reconcile_completed', env);
      }
      return summary;
    }).catch((error) => {
      logRecoveryWarning(logger, { error: error?.message || String(error) }, 'codex_queued_reconcile_failed', env);
      return null;
    }).finally(() => {
      runtime.inFlight = null;
    });
    return runtime.inFlight;
  };
  runtime.timer = scheduler.setInterval(() => { void tick(); }, config.intervalMs);
  if (typeof runtime.timer?.unref === 'function') runtime.timer.unref();
  runtime.tick = tick;
  queuedReconcilerRuntime = runtime;
  return true;
}

async function stopQueuedRunReconciler() {
  const runtime = queuedReconcilerRuntime;
  if (!runtime) return;
  runtime.stopped = true;
  if (runtime.timer != null) runtime.scheduler.clearInterval(runtime.timer);
  if (runtime.inFlight) await runtime.inFlight.catch(() => {});
  if (queuedReconcilerRuntime === runtime) queuedReconcilerRuntime = null;
}

async function recoverCodexRunsAfterBoot({
  prisma = defaultPrisma,
  queue = runQueueDefault,
  eventStore = eventStoreDefault,
  sessionService = null,
  env = process.env,
  clock = () => new Date(),
} = {}) {
  const result = {
    erroredRunning: 0,
    resumedRunning: 0,
    reenqueuedQueued: 0,
    terminalized: 0,
    deferredPaused: 0,
    scanned: 0,
  };
  if (!isCodexV2Enabled(env)) return result;
  if (!prisma || !prisma.codexRun) return result;

  try {
    const sessionsEnabled = !/^(0|false|off|no)$/i.test(String(
      env.CODEX_SESSION_ARTIFACTS ?? (env.NODE_ENV === 'production' ? '1' : '0'),
    ));
    const durableSessionService = sessionService
      || (sessionsEnabled && prisma.codexSessionState ? createSessionService({ db: prisma, clock }) : null);
    // a) zombie running → RESUME (re-enqueue the SAME run). The workspace and
    //    the event log persist across restarts, and the agent-loop rebuilds
    //    its file tree from the real workspace — so the run continues where
    //    it left off instead of dying and dropping the user to the template
    //    builder (root cause of the "skeletal product" reports: every backend
    //    deploy killed the in-flight build). The panel's SSE stream reconnects
    //    on its own because the run never turns terminal. Bounded: after
    //    MAX_BOOT_RESUMES interruptions the run is marked error as before.
    // Snapshot BOTH lists up front: the resume path below flips running rows
    // to 'queued' (already enqueued) — re-scanning them in phase (b) would
    // double-enqueue within the same sweep.
    const running = await prisma.codexRun.findMany({ where: { status: 'running' } });
    const queuedSnapshot = await prisma.codexRun.findMany({ where: { status: 'queued' } });
    for (const run of running) {
      result.scanned += 1;
      try {
        const swarmState = await inspectSwarmRunState({ prisma, run });
        if (swarmState.deferred) {
          const changed = await deferRunFromPausedSwarm({ prisma, eventStore, run, clock });
          if (changed) result.deferredPaused += 1;
          continue;
        }
        if (!swarmState.recoverable) {
          if (swarmState.cancelled) {
            await cancelRunFromCancelledSwarm({ prisma, queue, eventStore, run, clock });
          } else if (swarmState.reason === 'swarm_terminal') {
            const changed = await errorRunFromTerminalSwarm({
              prisma,
              queue,
              eventStore,
              run,
              clock,
              swarmState,
            });
            if (changed) result.terminalized += 1;
          }
          continue;
        }
        let resumeSnapshot = null;
        let snapshotReady = true;
        if (durableSessionService) {
          try {
            resumeSnapshot = typeof durableSessionService.readSnapshot === 'function'
              ? await durableSessionService.readSnapshot({ projectId: run.projectId, sessionId: run.id })
              : null;
            snapshotReady = typeof durableSessionService.hasResumableSnapshot === 'function'
              ? await durableSessionService.hasResumableSnapshot({ projectId: run.projectId, sessionId: run.id })
              : snapshotIsResumable(resumeSnapshot);
          } catch {
            resumeSnapshot = null;
            snapshotReady = false;
          }
        }
        let resumes = 0;
        if (eventStore && eventStore.listEvents) {
          const events = await eventStore.listEvents(run.id, { afterSeq: 0, prisma }).catch(() => []);
          resumes = (events || []).filter(
            (e) => e && e.type === 'narrative_delta' && String(e.data?.text || '').includes(RESUME_MARKER),
          ).length;
        }
        if (!snapshotReady || resumes >= MAX_BOOT_RESUMES || !queue || !queue.enqueueCodexRun) {
          const finalized = await conditionalRunUpdate(prisma, {
            id: run.id,
            status: 'running',
          }, {
            status: 'error',
            error: INTERRUPTED_MSG,
            finishedAt: clock(),
          });
          if (!finalized?.count) continue;
          if (eventStore) {
            await eventStore.appendEvent(run.id, 'run_status', { status: 'error' }, { prisma }).catch(() => {});
          }
          result.erroredRunning += 1;
        } else {
          const claimed = await conditionalRunUpdate(prisma, {
            id: run.id,
            status: 'running',
          }, {
            status: 'queued',
            error: null,
          });
          if (!claimed?.count) continue;
          if (eventStore) {
            await eventStore.appendEvent(run.id, 'narrative_delta', { text: `${RESUME_MARKER} — continúo el build donde quedó.` }, { prisma }).catch(() => {});
            await eventStore.appendEvent(run.id, 'run_status', { status: 'queued' }, { prisma }).catch(() => {});
          }
          // Unique jobId per resume: BullMQ silently ignores q.add when a
          // job with the same id already exists (the dead original lingers
          // in Redis), so re-using runId left resumed runs queued forever.
          const job = await queue.enqueueCodexRun({
            runId: run.id,
            jobId: `${run.id}-r${resumes + 1}`,
            ...(resumeSnapshot ? {
              resumeSnapshot: {
                sessionId: resumeSnapshot.sessionId,
                cursorSeq: resumeSnapshot.cursorSeq,
                checkpointSha: resumeSnapshot.checkpointSha || null,
              },
            } : {}),
          });
          if (job?.id && typeof prisma.codexRun.updateMany === 'function') {
            await prisma.codexRun.updateMany({
              where: { id: run.id, status: 'queued' },
              data: { jobId: String(job.id) },
            });
          }
          result.resumedRunning += 1;
        }
      } catch (err) {
        if (env.NODE_ENV !== 'test') console.warn('[codex boot-recovery] running recovery failed:', err?.message || err);
      }
    }

    // b) stuck queued with no live job → re-enqueue (pre-resume snapshot).
    for (const run of queuedSnapshot) {
      result.scanned += 1;
      try {
        await withQueuedRecoveryLock(run.id, async () => {
          const swarmState = await inspectSwarmRunState({ prisma, run });
          if (swarmState.deferred) {
            result.deferredPaused += 1;
            return;
          }
          if (!swarmState.recoverable) {
            if (swarmState.cancelled) {
              await cancelRunFromCancelledSwarm({ prisma, queue, eventStore, run, clock });
            } else if (swarmState.reason === 'swarm_terminal') {
              const changed = await errorRunFromTerminalSwarm({
                prisma,
                queue,
                eventStore,
                run,
                clock,
                swarmState,
              });
              if (changed) result.terminalized += 1;
            }
            return;
          }
          const job = await peekLiveJobForRun(queue, run);
          if (!job && queue && queue.enqueueCodexRun) {
            // Unique jobId here too — a dead job record with the runId lingering
            // in Redis makes q.add(runId) a silent no-op (same trap as above).
            const queuedJob = await queue.enqueueCodexRun({
              runId: run.id,
              jobId: `${run.id}-rq${clock().getTime()}`,
            });
            if (queuedJob?.id && typeof prisma.codexRun.updateMany === 'function') {
              await prisma.codexRun.updateMany({
                where: { id: run.id, status: 'queued' },
                data: { jobId: String(queuedJob.id) },
              });
            }
            result.reenqueuedQueued += 1;
          }
        });
      } catch (err) {
        if (env.NODE_ENV !== 'test') console.warn('[codex boot-recovery] re-enqueue failed:', err?.message || err);
      }
    }
  } catch (err) {
    if (env.NODE_ENV !== 'test') console.warn('[codex boot-recovery] sweep failed:', err?.message || err);
  }
  return result;
}

module.exports = {
  DEFAULT_QUEUED_RECONCILE_AFTER_MS,
  DEFAULT_QUEUED_RECONCILE_BATCH,
  DEFAULT_QUEUED_RECONCILE_INTERVAL_MS,
  INTERRUPTED_MSG,
  MAX_BOOT_RESUMES,
  PAUSED_SWARM_MARKER,
  RESUME_MARKER,
  TERMINAL_SWARM_MSG,
  queuedReconcilerConfig,
  reconcileQueuedCodexRuns,
  recoverCodexRunsAfterBoot,
  resumeDeferredSwarmRuns,
  resumeDeferredSwarmRunsReliably,
  startQueuedRunReconciler,
  stopQueuedRunReconciler,
};
