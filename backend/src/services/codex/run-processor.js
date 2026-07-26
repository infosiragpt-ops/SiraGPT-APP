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
const { remoteAgentEnv } = require('./agent-adapters/remote-http-adapter');
const buildTools = require('./build-tools');
const checkpointServiceDefault = require('./checkpoint-service');
const { createSandboxClient } = require('./sandbox-provider');
const {
  createSessionService,
  snapshotIsResumable,
} = require('./session-service');
const autonomousRunPolicy = require('./autonomous-run-policy');
const openclawCapabilityKernel = require('../openclaw-capability-kernel');

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_STEPS = 24;

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function readTimeoutMs(env, policy = null) {
  if (policy?.timeoutMs) return policy.timeoutMs;
  const v = Number.parseInt((env || process.env).CODEX_RUN_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function readMaxSteps(env, policy = null) {
  if (policy?.maxSteps) return policy.maxSteps;
  const v = Number.parseInt((env || process.env).CODEX_MAX_STEPS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_STEPS;
}

function defaultOnFeature(env, key) {
  const source = env || process.env;
  const fallback = source.NODE_ENV === 'production' ? '1' : '0';
  return !/^(0|false|off|no)$/i.test(String(source[key] ?? fallback).trim());
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
  } else if (adapter.id === 'remote-http') {
    // The remote adapter receives only its own operator configuration. Never
    // expose Prisma, host paths, provider API keys, or the full process env.
    context.deps = { env: remoteAgentEnv(deps.env) };
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
  runService,
  runner = null,
  sessionService = null,
  checkpointService = checkpointServiceDefault,
  clock,
  env = process.env,
  resumeSnapshot = null,
} = {}) {
  if (!prisma || !prisma.codexRun) throw new Error('database unavailable');

  const run = await prisma.codexRun.findUnique({ where: { id: runId } });
  if (!run) return { status: 'not_found' };
  // Idempotency: only a freshly-queued run should be processed.
  if (run.status !== 'queued') return { status: run.status, skipped: true };

  const project = run.projectId
    ? await prisma.codexProject.findUnique({ where: { id: run.projectId } }).catch(() => null)
    : null;

  // A worker that has claimed the queued job owns its lifecycle from this
  // point onward, including configuration/preflight failures.
  await prisma.codexRun.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date(nowIso(clock)) } });
  await eventStore.appendEvent(runId, 'run_status', { status: 'running' }, { prisma });

  const registry = agentAdapterRegistry || getDefaultAgentAdapterRegistry();
  let adapter;
  try {
    adapter = registry.resolveImplementer({ env });
  } catch (err) {
    const error = String(err?.message || err);
    await prisma.codexRun.update({
      where: { id: runId },
      data: { status: 'error', error, finishedAt: new Date(nowIso(clock)) },
    });
    await eventStore.appendEvent(runId, 'run_status', { status: 'error' }, { prisma });
    return { status: 'error', error };
  }
  let nativeRunner = runner;
  let nativeSessionService = sessionService;
  let nativeResumeSnapshot = null;
  let unregisterTranscript = null;

  if (adapter === nativeCodexAdapter) {
    nativeRunner = nativeRunner || createSandboxClient();
    if (defaultOnFeature(env, 'CODEX_SESSION_ARTIFACTS')) {
      nativeSessionService = nativeSessionService || createSessionService({ db: prisma, clock });
    }

    if (
      nativeSessionService
      && resumeSnapshot?.sessionId === run.id
      && Number.isSafeInteger(resumeSnapshot.cursorSeq)
    ) {
      try {
        const stored = await nativeSessionService.readSnapshot({
          projectId: run.projectId,
          sessionId: run.id,
        });
        if (
          snapshotIsResumable(stored)
          && stored.cursorSeq === resumeSnapshot.cursorSeq
          && (!resumeSnapshot.checkpointSha || stored.checkpointSha === resumeSnapshot.checkpointSha)
        ) {
          nativeResumeSnapshot = stored.loopState || null;
        }
      } catch {
        // The loop falls back to the latest durable context_snapshot event.
      }
    }

    if (run.mode === 'build' && defaultOnFeature(env, 'CODEX_RUN_BRANCHES')) {
      const branch = await checkpointService.prepareRunBranch({
        run,
        project,
        deps: { runner: nativeRunner },
      }).catch((error) => ({
        ok: false,
        code: 'run_branch_setup_failed',
        detail: String(error?.message || error).slice(0, 1000),
      }));
      if (!branch?.ok) {
        const error = `run branch setup failed (${branch?.code || 'unknown'}): ${String(branch?.detail || '').slice(0, 1000)}`;
        await prisma.codexRun.update({
          where: { id: runId },
          data: { status: 'error', error, finishedAt: new Date(nowIso(clock)) },
        });
        await eventStore.appendEvent(runId, 'run_status', { status: 'error' }, { prisma });
        return { status: 'error', error };
      }
    }

    if (
      nativeSessionService
      && typeof eventStore.registerTranscriptSink === 'function'
    ) {
      unregisterTranscript = eventStore.registerTranscriptSink(run.id, async (envelope) => {
        const appended = await nativeSessionService.appendTranscript({
          projectId: run.projectId,
          sessionId: run.id,
          entry: { ...envelope, sourceSeq: envelope.seq },
        });
        if (envelope.type === 'context_snapshot') {
          await nativeSessionService.saveSnapshot({
            projectId: run.projectId,
            sessionId: run.id,
            cursorSeq: appended.record.seq,
            loopState: {
              summary: envelope.data?.summary || '',
              tailMessages: envelope.data?.tailMessages || [],
              state: envelope.data?.state || {},
            },
          });
        }
      });
    }
  }

  const agentRun = {
    ...run,
    prompt: autonomousRunPolicy.stripAutoExecutePrompt(run.prompt),
  };
  const openclawRuntimeProfile = openclawCapabilityKernel.buildCapabilityProfile({
    prompt: agentRun.prompt || '',
    userId: run.userId,
    chatId: null,
    model: run.model || null,
    toolNames: buildTools.toolRegistry().map((tool) => tool.name),
    context: {
      projectId: run.projectId,
      runId: run.id,
      mode: run.mode,
    },
  });
  const openclawRuntimeSummary =
    openclawCapabilityKernel.buildOpenClawRuntimeSummary(openclawRuntimeProfile);
  const runtimePolicy = autonomousRunPolicy.deriveAutonomousRunPolicy({
    run,
    profile: openclawRuntimeProfile,
    env,
  });
  const runtimeEnv = autonomousRunPolicy.buildAutonomousRunEnv(env, runtimePolicy);
  const timeoutMs = readTimeoutMs(runtimeEnv, runtimePolicy);
  const maxSteps = readMaxSteps(runtimeEnv, runtimePolicy);
  const controller = new AbortController();

  for (const runtimeEvent of openclawCapabilityKernel.buildOpenClawRuntimeEvents(openclawRuntimeProfile)) {
    await eventStore
      .appendEvent(run.id, runtimeEvent.type, runtimeEvent, { prisma })
      .catch(() => {});
  }

  async function isCancelled() {
    const fresh = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return fresh?.status === 'cancelled';
  }

  let outcome;
  let timer;
  try {
    const request = createImplementerRequest({
      run: agentRun,
      project,
      timeoutMs,
      maxSteps,
      evidence: {
        openclawRuntime: openclawRuntimeSummary,
        execution: {
          mode: runtimePolicy.depth,
          autoExecute: runtimePolicy.autoExecute,
          verifyDevServer: runtimePolicy.verifyDevServer,
        },
      },
    });
    const context = executionContextForAdapter({
      adapter,
      signal: controller.signal,
      isCancelled,
      run: agentRun,
      project,
      deps: {
        prisma,
        eventStore,
        env: runtimeEnv,
        clock,
        runner: nativeRunner,
        sessionService: nativeSessionService,
        resumeSnapshot: nativeResumeSnapshot,
        openclawRuntimeProfile,
        openclawPromptBlock:
          openclawCapabilityKernel.buildOpenClawPromptBlock(openclawRuntimeProfile),
      },
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
    if (unregisterTranscript) unregisterTranscript();
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
    if (unregisterTranscript) unregisterTranscript();
    return { status: fresh?.status || status, raced: true };
  }
  await eventStore.appendEvent(runId, 'run_status', { status }, { prisma });

  let autoContinuedRunId = null;
  let autoContinueError = null;
  if (status === 'waiting_approval' && runtimePolicy.autoExecute) {
    try {
      const service = runService || require('./run-service');
      const buildRun = await service.createRun({
        userId: run.userId,
        projectId: run.projectId,
        mode: 'build',
        prompt: agentRun.prompt,
        model: run.model,
        tier: run.tier,
        planRunId: run.id,
        autoExecute: true,
        db: prisma,
      });
      autoContinuedRunId = buildRun?.id || null;
      await eventStore.appendEvent(
        runId,
        'auto_continue',
        {
          status: 'queued',
          buildRunId: autoContinuedRunId,
          message: 'Plan aprobado automáticamente; la construcción continúa en segundo plano.',
        },
        { prisma },
      ).catch(() => {});
    } catch (err) {
      autoContinueError = String(err?.message || err).slice(0, 1000);
      await eventStore.appendEvent(
        runId,
        'auto_continue',
        {
          status: 'error',
          message: 'No se pudo iniciar automáticamente la construcción.',
          error: autoContinueError,
        },
        { prisma },
      ).catch(() => {});
    }
  }

  // Free the per-run in-memory seq/append-chain caches now that the run is
  // truly terminal (waiting_approval can still resume, so keep its cache).
  if (status !== 'waiting_approval' && typeof eventStore.forgetRun === 'function') {
    try { eventStore.forgetRun(runId); } catch { /* best-effort */ }
  }
  if (unregisterTranscript) unregisterTranscript();

  return {
    status,
    error: errorMsg,
    autoContinuedRunId,
    autoContinueError,
    executionMode: runtimePolicy.depth,
  };
}

module.exports = {
  processCodexRunJob,
  TimeoutError,
  readTimeoutMs,
  readMaxSteps,
  defaultOnFeature,
  executionContextForAdapter,
};
