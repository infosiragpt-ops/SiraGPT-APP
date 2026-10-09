'use strict';

const { getMediaJobStore } = require('./job-store');
const runners = new Map();
function registerMediaRunner(kind, runner) {
  if (typeof runner !== 'function') throw new TypeError('media runner required');
  runners.set(kind, runner);
}

function createMediaWorker({ store = getMediaJobStore(), registry = runners, logger = console, concurrency = 2, pollMs = 750, leaseMs = 30000 } = {}) {
  const running = new Set();
  const controllers = new Set();
  let timer, stopped = true, polling = false;
  async function execute(job) {
    const controller = new AbortController();
    controllers.add(controller);
    let heartbeating = false;
    const renew = async () => {
      if (heartbeating || controller.signal.aborted) return;
      heartbeating = true;
      try {
        const state = await store.heartbeat(job, leaseMs);
        if (state.cancelRequested) controller.abort(Object.assign(new Error('Cancelado por el usuario.'), { code: 'E_CANCELLED' }));
      } catch (error) { controller.abort(error); }
      finally { heartbeating = false; }
    };
    const heartbeat = setInterval(renew, Math.min(2000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    const completed = [];
    const context = {
      jobId: job.id, job, signal: controller.signal,
      onCompleted: callback => completed.push(callback),
      checkpoint: async (patch, state) => {
        controller.signal.throwIfAborted();
        try { return await store.checkpoint(job, patch, state); }
        catch (error) { if (['LEASE_LOST', 'E_CANCELLED'].includes(error?.code)) controller.abort(error); throw error; }
      },
      progress: async ({ stage, progress, result } = {}) => {
        return context.checkpoint(result ? { progressResult: result } : {}, { phase: stage, progress });
      },
    };
    try {
      await renew();
      controller.signal.throwIfAborted();
      const result = await registry.get(job.kind)(context, job.payload);
      controller.signal.throwIfAborted();
      await store.settle(job, { status: 'completed', result, quotaUsedUnits: result?.quotaUnits, actualCostUSD: result?.actualCostUSD, providerCalled: Boolean(job.checkpoint?.dispatchState),
        onCompleted: async (tx, output) => { for (const callback of completed) await callback(tx, output); },
      });
      await require('./cleanup-inputs').cleanupMediaInputs(job).catch(() => {});
    } catch (error) {
      if (error?.code === 'LEASE_LOST' || controller.signal.reason?.code === 'LEASE_LOST') return;
      if (controller.signal.reason?.code === 'MEDIA_WORKER_STOP') {
        await store.defer(job, 0).catch(() => {});
        return;
      }
      const cancelled = controller.signal.reason?.code === 'E_CANCELLED' || error?.code === 'E_CANCELLED';
      // Polling/downloading a known upstream request is safe to resume. Limit
      // this recovery window so outages do not leave reservations forever.
      if (!cancelled && (job.checkpoint?.providerRequestId || job.checkpoint?.imageResults || job.checkpoint?.audiobookResult) && job.attempt < 8
          && Number(job.age_ms || 0) + Date.now() - (job.claimed_at_ms || Date.now()) < 15 * 60 * 1000
          && !['E_PARAMS', 'E_TIMEOUT', 'MEDIA_TOO_LARGE', 'MEDIA_DISPATCH_UNKNOWN'].includes(error?.code)) {
        await store.defer(job, Math.min(30000, 1000 * 2 ** job.attempt)).catch(() => {});
        return;
      }
      const ambiguous = !cancelled && ['submitting', 'unknown'].includes(job.checkpoint?.dispatchState);
      try {
        await store.settle(job, {
          status: cancelled ? 'cancelled' : ambiguous ? 'unknown' : 'failed',
          code: cancelled ? 'E_CANCELLED' : ambiguous ? 'MEDIA_DISPATCH_UNKNOWN' : (error?.code || 'E_PROVIDER'),
          message: cancelled ? 'Cancelado por el usuario.' : ambiguous
            ? 'No pude confirmar el resultado. No volveré a generar automáticamente para evitar un cobro duplicado.'
            : (error?.publicMessage || 'No se pudo completar la generación. Reintenta o elige otro modelo.'),
          providerCalled: Boolean(job.checkpoint?.dispatchState),
        });
        if (!ambiguous) await require('./cleanup-inputs').cleanupMediaInputs(job).catch(() => {});
      } catch (settleError) {
        if (settleError?.code !== 'LEASE_LOST') logger.warn?.('[media-worker] terminal persistence failed', { jobId: job.id, code: settleError?.code || 'DB_UNAVAILABLE' });
      }
    } finally { clearInterval(heartbeat); controllers.delete(controller); }
  }
  async function pump() {
    if (stopped || polling || !registry.size) return;
    polling = true;
    try {
      while (!stopped && running.size < concurrency) {
        const job = await store.claim([...registry.keys()], leaseMs);
        if (!job) break;
        const task = execute(job);
        running.add(task);
        task.finally(() => running.delete(task)).catch(() => {});
      }
    } catch (error) { logger.warn?.('[media-worker] dispatch unavailable', { code: error?.code || 'DB_UNAVAILABLE' }); }
    finally { polling = false; }
  }
  return {
    start() { if (!stopped) return; stopped = false; timer = setInterval(pump, pollMs); timer.unref?.(); void pump(); },
    async stop() {
      stopped = true; clearInterval(timer);
      for (const controller of controllers) controller.abort(Object.assign(new Error('Worker stopping'), { code: 'MEDIA_WORKER_STOP' }));
      await Promise.allSettled([...running]);
    },
    pump,
  };
}
let worker;
function startMediaWorker() {
  // Re-register executable voice kinds on every boot, not only after the
  // first HTTP request. This is essential to automatic restart recovery.
  require('../voice-studio/jobs').getJobQueue();
  if (!worker) { worker = createMediaWorker(); worker.start(); }
  return worker;
}
async function stopMediaWorker() { if (worker) await worker.stop(); worker = null; }
module.exports = { createMediaWorker, registerMediaRunner, startMediaWorker, stopMediaWorker };
