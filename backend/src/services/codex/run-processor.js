'use strict';

/**
 * codex/run-processor — the BullMQ job handler body (feature 05). Owns the run
 * LIFECYCLE: load the queued run, flip it to `running` (+ run_status event),
 * delegate the actual work through AgentAdapter v1 (the native adapter wraps
 * the feature 06 agent loop), then persist the
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
const { createImplementerRequest, assertAgentOutcome } = require('./agent-adapters/contract');
const { getDefaultAgentAdapterRegistry } = require('./agent-adapters/registry');
const { nativeCodexAdapter } = require('./agent-adapters/native-codex-adapter');

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_STEPS = 24;

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function readTimeoutMs(env) {
  const v = Number.parseInt((env || process.env).CODEX_RUN_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function readMaxSteps(env) {
  const v = Number.parseInt((env || process.env).CODEX_MAX_STEPS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_STEPS;
}

function executionContextForAdapter({ adapter, signal, isCancelled, run, project, deps, runAgentLoop }) {
  const context = { signal, isCancelled, deps: {} };
  // Database/event-store handles and full Prisma snapshots belong to the
  // control plane. Only the exact built-in singleton needs them to preserve the
  // current loop. External adapters must operate on the path-free request and
  // their own bounded clients.
  if (adapter === nativeCodexAdapter) {
    context.deps = deps;
    context.nativeRun = run;
    context.nativeProject = project;
    if (runAgentLoop) context.runAgentLoop = runAgentLoop;
  }
  return context;
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
  agentAdapterRegistry,
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

  const timeoutMs = readTimeoutMs(env);
  const controller = new AbortController();

  async function isCancelled() {
    const fresh = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return fresh?.status === 'cancelled';
  }

  let outcome;
  let timer;
  try {
    const registry = agentAdapterRegistry || getDefaultAgentAdapterRegistry();
    const adapter = registry.resolveImplementer({ env });
    const request = createImplementerRequest({
      run,
      project,
      timeoutMs,
      maxSteps: readMaxSteps(env),
    });
    const context = executionContextForAdapter({
      adapter,
      signal: controller.signal,
      isCancelled,
      run,
      project,
      deps: { prisma, eventStore, env, clock },
      // Test injection remains at the native boundary; production lazily
      // resolves agent-loop inside native-codex-adapter.
      runAgentLoop,
    });
    const work = Promise.resolve(adapter.execute(request, context));
    const timeout = new Promise((_, reject) => {
      // Reject BEFORE aborting so the timeout deterministically wins the race
      // even if the loop resolves synchronously inside its abort handler.
      timer = setTimeout(() => { reject(new TimeoutError(timeoutMs)); controller.abort(); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    outcome = assertAgentOutcome(await Promise.race([work, timeout]));
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

  const status = outcome.status;
  const errorMsg = status === 'error' ? String(outcome?.error || 'run failed').slice(0, 2000) : null;

  // Guard the terminal transition against a concurrent cancelRun / boot-recovery
  // that flipped the row to a terminal state in the window after our isCancelled()
  // check above. Only transition a row still `running`; if nothing was updated
  // someone else already finalized it, so we MUST NOT emit a second run_status
  // (which would duplicate the terminal event and could revert `cancelled`).
  const flip = await prisma.codexRun.updateMany({
    where: { id: runId, status: 'running' },
    data: {
      status,
      error: errorMsg,
      finishedAt: status === 'waiting_approval' ? null : new Date(nowIso(clock)),
    },
  });
  if (!flip || flip.count === 0) {
    const fresh = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return { status: fresh?.status || status, raced: true };
  }
  await eventStore.appendEvent(runId, 'run_status', { status }, { prisma });

  // Free the per-run in-memory seq/append-chain caches now that the run is
  // truly terminal (waiting_approval can still resume, so keep its cache).
  if (status !== 'waiting_approval' && typeof eventStore.forgetRun === 'function') {
    try { eventStore.forgetRun(runId); } catch { /* best-effort */ }
  }

  return { status, error: errorMsg };
}

module.exports = {
  processCodexRunJob,
  TimeoutError,
  readTimeoutMs,
  readMaxSteps,
  executionContextForAdapter,
};
