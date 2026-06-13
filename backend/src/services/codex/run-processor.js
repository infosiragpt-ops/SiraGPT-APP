'use strict';

/**
 * codex/run-processor — the BullMQ job handler body (feature 05). Owns the run
 * LIFECYCLE: load the queued run, flip it to `running` (+ run_status event),
 * delegate the actual work to the agent loop (feature 06), then persist the
 * terminal transition (`waiting_approval | done | error | cancelled`) with its
 * run_status event. The agent loop emits all DOMAIN events (plan_proposed,
 * narrative, actions, checkpoint, run_summary); the processor owns only the
 * run_status transitions so lifecycle stays in one place.
 *
 * A hard per-job timeout (CODEX_RUN_TIMEOUT_MS, default 15 min) aborts a hung
 * loop into a clean `error`. Cancellation is cooperative: the loop polls
 * `isCancelled()` between steps; if the run was cancelled out-of-band the
 * terminal status is preserved as `cancelled`.
 *
 * All deps are injectable for offline tests.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();
const eventStoreDefault = require('./event-store');

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function readTimeoutMs(env) {
  const v = Number.parseInt((env || process.env).CODEX_RUN_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

class TimeoutError extends Error {
  constructor(ms) { super(`codex run exceeded ${ms}ms hard timeout`); this.name = 'TimeoutError'; this.isTimeout = true; }
}

/**
 * Process one codex run. Returns the final status. Never throws out (errors are
 * captured into the run row + a run_status error event) so BullMQ marks the job
 * complete and there is no zombie.
 */
async function processCodexRunJob({
  runId,
  prisma = defaultPrisma,
  eventStore = eventStoreDefault,
  runAgentLoop,
  clock,
  env = process.env,
} = {}) {
  if (!prisma || !prisma.codexRun) throw new Error('database unavailable');

  const run = await prisma.codexRun.findUnique({ where: { id: runId } });
  if (!run) return { status: 'not_found' };
  // Idempotency: only a freshly-queued run should be processed.
  if (run.status !== 'queued') return { status: run.status, skipped: true };

  const project = run.projectId
    ? await prisma.codexProject.findUnique({ where: { id: run.projectId } }).catch(() => null)
    : null;

  // ── running ──
  await prisma.codexRun.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date(nowIso(clock)) } });
  await eventStore.appendEvent(runId, 'run_status', { status: 'running' }, { prisma });

  const loop = runAgentLoop || ((args) => require('./agent-loop').runAgentLoop(args));
  const timeoutMs = readTimeoutMs(env);
  const controller = new AbortController();

  async function isCancelled() {
    const fresh = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return fresh?.status === 'cancelled';
  }

  let outcome;
  let timer;
  try {
    const work = Promise.resolve(
      loop({ run, project, signal: controller.signal, isCancelled, deps: { prisma, eventStore, env, clock } }),
    );
    const timeout = new Promise((_, reject) => {
      // Reject BEFORE aborting so the timeout deterministically wins the race
      // even if the loop resolves synchronously inside its abort handler.
      timer = setTimeout(() => { reject(new TimeoutError(timeoutMs)); controller.abort(); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    outcome = await Promise.race([work, timeout]);
  } catch (err) {
    outcome = { status: 'error', error: err?.isTimeout ? err.message : String(err?.message || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Cancellation (out-of-band) wins over a late "done". cancelRun already
  // flipped the row to `cancelled` and emitted the run_status event, so here we
  // only stamp finishedAt — emitting again would duplicate the terminal event.
  if (await isCancelled()) {
    await prisma.codexRun
      .update({ where: { id: runId }, data: { finishedAt: new Date(nowIso(clock)) } })
      .catch(() => {});
    return { status: 'cancelled' };
  }

  const status = ['waiting_approval', 'done', 'error', 'cancelled'].includes(outcome?.status)
    ? outcome.status
    : 'done';
  const errorMsg = status === 'error' ? String(outcome?.error || 'run failed').slice(0, 2000) : null;

  await prisma.codexRun.update({
    where: { id: runId },
    data: {
      status,
      error: errorMsg,
      finishedAt: status === 'waiting_approval' ? null : new Date(nowIso(clock)),
    },
  });
  await eventStore.appendEvent(runId, 'run_status', { status }, { prisma });

  return { status, error: errorMsg };
}

module.exports = { processCodexRunJob, TimeoutError, readTimeoutMs };
