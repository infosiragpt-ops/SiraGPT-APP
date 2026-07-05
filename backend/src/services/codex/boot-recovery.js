'use strict';

/**
 * codex/boot-recovery — crash recovery sweep for runs interrupted by a process
 * restart (feature 05, mirrors goal-boot-recovery). Runs once at boot when the
 * flag is on. Two failure modes:
 *
 *   a) Zombie `running`: a worker claimed the job and flipped the row to
 *      `running`, then the process died. Its in-memory loop state is gone and
 *      cannot resume, so we mark the row `error` ("interrumpida por reinicio")
 *      and emit a terminal `run_status error` so the SSE replay surfaces it.
 *   b) Stuck `queued`: the row was persisted but its job is no longer in the
 *      queue (enqueue blip / lost on restart). We re-enqueue (jobId === runId,
 *      so a redundant re-enqueue is a safe no-op).
 *
 * Never throws out of either entry point — a DB/Redis blip logs and returns
 * zero counts. prisma/queue/eventStore are injectable for offline tests.
 */

const { isCodexV2Enabled } = require('./flags');

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
const MAX_BOOT_RESUMES = 2;

async function recoverCodexRunsAfterBoot({
  prisma = defaultPrisma,
  queue = runQueueDefault,
  eventStore = eventStoreDefault,
  env = process.env,
  clock = () => new Date(),
} = {}) {
  const result = { erroredRunning: 0, resumedRunning: 0, reenqueuedQueued: 0, scanned: 0 };
  if (!isCodexV2Enabled(env)) return result;
  if (!prisma || !prisma.codexRun) return result;

  try {
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
        let resumes = 0;
        if (eventStore && eventStore.listEvents) {
          const events = await eventStore.listEvents(run.id, { afterSeq: 0, prisma }).catch(() => []);
          resumes = (events || []).filter(
            (e) => e && e.type === 'narrative_delta' && String(e.data?.text || '').includes(RESUME_MARKER),
          ).length;
        }
        if (resumes >= MAX_BOOT_RESUMES || !queue || !queue.enqueueCodexRun) {
          await prisma.codexRun.update({
            where: { id: run.id },
            data: { status: 'error', error: INTERRUPTED_MSG, finishedAt: clock() },
          });
          if (eventStore) {
            await eventStore.appendEvent(run.id, 'run_status', { status: 'error' }, { prisma }).catch(() => {});
          }
          result.erroredRunning += 1;
        } else {
          await prisma.codexRun.update({
            where: { id: run.id },
            data: { status: 'queued', error: null },
          });
          if (eventStore) {
            await eventStore.appendEvent(run.id, 'narrative_delta', { text: `${RESUME_MARKER} — continúo el build donde quedó.` }, { prisma }).catch(() => {});
            await eventStore.appendEvent(run.id, 'run_status', { status: 'queued' }, { prisma }).catch(() => {});
          }
          await queue.enqueueCodexRun({ runId: run.id });
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
        const job = queue && queue.peekCodexJob ? await queue.peekCodexJob(run.id) : null;
        if (!job) {
          if (queue && queue.enqueueCodexRun) await queue.enqueueCodexRun({ runId: run.id });
          result.reenqueuedQueued += 1;
        }
      } catch (err) {
        if (env.NODE_ENV !== 'test') console.warn('[codex boot-recovery] re-enqueue failed:', err?.message || err);
      }
    }
  } catch (err) {
    if (env.NODE_ENV !== 'test') console.warn('[codex boot-recovery] sweep failed:', err?.message || err);
  }
  return result;
}

module.exports = { recoverCodexRunsAfterBoot, INTERRUPTED_MSG, RESUME_MARKER, MAX_BOOT_RESUMES };
