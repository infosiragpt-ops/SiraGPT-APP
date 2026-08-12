'use strict';

const { randomUUID } = require('node:crypto');

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
const usageLedger = require('./usage-ledger');
const openclawCapabilityKernel = require('../openclaw-capability-kernel');
const { inspectSwarmRunState } = require('./swarm-run-state');

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const MAX_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STEPS = 24;
const DEFAULT_FLEET_QA_TIMEOUT_MS = 5 * 60_000;
const MAX_FLEET_QA_TIMEOUT_MS = 30 * 60_000;
const activeControllers = new Map();

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function readTimeoutMs(env, policy = null) {
  if (policy?.timeoutMs) return policy.timeoutMs;
  const v = Number.parseInt((env || process.env).CODEX_RUN_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function readDrainTimeoutMs(env = process.env, override = null) {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(MAX_DRAIN_TIMEOUT_MS, Math.trunc(explicit));
  }
  const parsed = Number.parseInt(env.CODEX_RUN_DRAIN_TIMEOUT_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DRAIN_TIMEOUT_MS;
  return Math.min(MAX_DRAIN_TIMEOUT_MS, parsed);
}

/** Abort the in-process execution for a run, when this worker owns it. */
function abortCodexRun(runId, reason = new Error('codex run cancelled')) {
  const controller = activeControllers.get(String(runId));
  if (!controller) return false;
  if (!controller.signal.aborted) controller.abort(reason);
  return true;
}

function releaseCodexRun(runId, controller) {
  if (activeControllers.get(String(runId)) === controller) activeControllers.delete(String(runId));
}

async function drainExecution(work, timeoutMs) {
  if (!work || typeof work.then !== 'function') return false;
  let timer;
  let drained = false;
  try {
    await Promise.race([
      Promise.resolve(work).then(() => { drained = true; }, () => { drained = true; }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    return drained;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readMaxSteps(env, policy = null) {
  if (policy?.maxSteps) return policy.maxSteps;
  const v = Number.parseInt((env || process.env).CODEX_MAX_STEPS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_STEPS;
}

function readFleetQaTimeoutMs(env = process.env, override = null) {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const parsed = Number.parseInt(env.CODEX_FLEET_QA_TIMEOUT_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FLEET_QA_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_FLEET_QA_TIMEOUT_MS, parsed));
}

async function persistFleetQaUsage({
  prisma,
  project,
  run,
  usage,
  departmentPoolId,
  reviewId,
  idempotencyKey,
  env = process.env,
  costResolver = null,
}) {
  if (!project?.id || !run?.id || !departmentPoolId || !reviewId || !idempotencyKey) {
    const error = new Error('fleet_qa_usage_attribution_unavailable');
    error.code = 'fleet_qa_usage_attribution_unavailable';
    throw error;
  }
  return usageLedger.recordUsage({
    prisma,
    projectId: project.id,
    departmentPoolId,
    source: 'fleet_qa',
    sourceId: reviewId,
    idempotencyKey,
    usage,
    env,
    costResolver,
  });
}

async function publishTerminalSignals({
  run,
  project,
  status,
  error = null,
  prisma,
  triggers,
  env,
  clock,
}) {
  await require('./run-completion').publishRunCompletion({
    run,
    status,
    error,
    triggers,
    env,
  });
  if (!['done', 'error', 'cancelled'].includes(status)) return;
  const outcome = status === 'done' ? 'passed' : status === 'cancelled' ? 'cancelled' : 'failed';
  await require('./progress-ledger').appendLedgerEntryIfMissing({
    prisma,
    project,
    entry: {
      department: 'interactive',
      runId: run?.id,
      outcome,
      task: String(run?.prompt || '').slice(0, 600),
      checkpointSha: null,
      diffstat: {},
      costUsd: 0,
      acceptance: [],
      learnings: [
        status === 'done'
          ? 'Corrida finalizada; no hubo evidencia adicional de checkpoint en el cierre.'
          : status === 'cancelled'
            ? 'Corrida cancelada antes de completar el objetivo.'
            : `Corrida fallida: ${String(error || run?.error || 'error no especificado').slice(0, 450)}`,
      ],
      createdAt: nowIso(clock),
    },
  }).catch(() => {});
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
    context.deps = runAgentLoop
      ? deps
      : {
        ...deps,
        eventStore: guardedEventStore(deps.eventStore, signal),
        runner: guardedRunner(deps.runner, signal),
        checkpointService: guardedCheckpointService(deps.checkpointService, signal),
        executionGuard: () => !signal?.aborted,
      };
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

class CancelledRunError extends Error {
  constructor(phase) {
    super(`codex run cancelled during ${phase}`);
    this.name = 'CancelledRunError';
    this.code = 'CODEX_RUN_CANCELLED';
  }
}

class FleetQaTimeoutError extends Error {
  constructor(ms) {
    super(`fleet QA exceeded ${ms}ms hard timeout`);
    this.name = 'FleetQaTimeoutError';
    this.code = 'fleet_qa_timeout';
    this.isTimeout = true;
  }
}

function guardedEventStore(eventStore, signal) {
  if (!eventStore || typeof eventStore.appendEvent !== 'function') return eventStore;
  const guarded = Object.create(eventStore);
  guarded.appendEvent = (...args) => {
    if (signal?.aborted) return Promise.resolve(null);
    return eventStore.appendEvent(...args);
  };
  return guarded;
}

function executionAborted(operation) {
  const error = new Error(`${operation} blocked after codex run abort`);
  error.code = 'CODEX_RUN_ABORTED';
  return error;
}

function guardedMethods(target, signal, label, nestedMethods = new Set()) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
  const guarded = Object.create(target);
  const names = new Set();
  let current = target;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== 'constructor') names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  for (const name of names) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    guarded[name] = (...args) => {
      if (signal?.aborted) throw executionAborted(`${label}.${name}`);
      const result = Reflect.apply(method, target, args);
      return nestedMethods.has(name) ? guardedMethods(result, signal, label) : result;
    };
  }
  return guarded;
}

// Native agents may ignore AbortSignal and continue their callback after the
// bounded drain. Every runner method is therefore checked at invocation time;
// an operation already in flight cannot be undone, but no later filesystem,
// process, preview, or Git operation can start through this boundary.
function guardedRunner(runner, signal) {
  return guardedMethods(runner, signal, 'runner', new Set(['forRun', 'unscoped']));
}

// Keep checkpoint calls behind the same abort fence as their runner calls. The
// agent loop receives this dependency in production; direct module imports are
// not used for the native execution path after this injection.
function guardedCheckpointService(service, signal) {
  return guardedMethods(service, signal, 'checkpointService');
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
  triggers = null,
  fleetQualityReviewer = null,
  fleetQaSignal = null,
  fleetQaTimeoutMs = null,
  fleetQaCostResolver = null,
} = {}) {
  if (!prisma || !prisma.codexRun) throw new Error('database unavailable');

  const queuedRun = await prisma.codexRun.findUnique({ where: { id: runId } });
  if (!queuedRun) return { status: 'not_found' };
  // Idempotency: only a freshly-queued run should be processed.
  if (queuedRun.status !== 'queued') return { status: queuedRun.status, skipped: true };

  // A job can survive in Redis while its parent swarm is paused, including an
  // old `active` record abandoned by a backend restart. Leave the durable run
  // queued so the explicit swarm resume can publish one fresh job. This check
  // happens before the atomic claim; work already claimed before the pause is
  // still allowed to finish its bounded operation.
  const queuedSwarmState = await inspectSwarmRunState({ prisma, run: queuedRun });
  if (queuedSwarmState.deferred) {
    return {
      status: 'queued',
      skipped: true,
      deferred: true,
      reason: queuedSwarmState.reason,
    };
  }
  // The swarm is the durable cancellation/terminal authority for every linked
  // run. Fail closed before the atomic claim when that authority is cancelled,
  // terminal, missing, invalid, or temporarily unreadable. In particular,
  // external adapters do not run the native loop's later swarm guard, so
  // allowing them past this boundary would execute work after cancellation.
  // The queued reconciler owns durable cancellation/terminal transitions; a
  // store/query failure deliberately leaves the row untouched for a safe retry.
  if (!queuedSwarmState.executable) {
    return {
      status: 'queued',
      skipped: true,
      blocked: true,
      reason: queuedSwarmState.reason,
    };
  }

  const startedAt = new Date(nowIso(clock));
  const claim = await prisma.codexRun.updateMany({
    where: { id: runId, status: 'queued' },
    data: { status: 'running', startedAt },
  });
  if (claim?.count !== 1) {
    const current = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return { status: current?.status || 'not_found', skipped: true, claimLost: true };
  }
  // Register ownership immediately after the atomic claim. Cancellation can
  // arrive while any later setup phase is waiting on IO, so abortRun(runId)
  // must already reach this worker before reading sessions or touching Git.
  const controller = new AbortController();
  activeControllers.set(String(runId), controller);
  let unregisterTranscript = null;
  let hardTimeoutTimer = null;
  let hardTimeout = null;
  let adapterStarted = false;
  // Keep a safe fallback visible to the outer catch; setup can time out before
  // runtimeEnv is computed and must still drain without masking the timeout.
  let drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS;
  const pendingSetup = new Set();
  let run = null;
  let project = null;

  async function isCancelled() {
    const fresh = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return fresh?.status === 'cancelled';
  }

  async function finishCancelled() {
    if (!controller.signal.aborted) controller.abort(new CancelledRunError('setup'));
    await prisma.codexRun
      .update({ where: { id: runId }, data: { finishedAt: new Date(nowIso(clock)) } })
      .catch(() => {});
    return { status: 'cancelled' };
  }

  try {
  run = await prisma.codexRun.findUnique({ where: { id: runId } })
    .catch(() => null) || { ...queuedRun, status: 'running', startedAt };

  async function assertRunActive(phase) {
    if (controller.signal.aborted) {
      if (controller.signal.reason?.isTimeout) throw controller.signal.reason;
      if (await isCancelled()) throw new CancelledRunError(phase);
      throw controller.signal.reason || new Error(`codex run aborted during ${phase}`);
    }
    if (await isCancelled()) {
      controller.abort(new CancelledRunError(phase));
      throw new CancelledRunError(phase);
    }
  }

  const runSetupPhase = async (phase, operation) => {
    await assertRunActive(`${phase}:before`);
    const operationPromise = Promise.resolve().then(operation);
    pendingSetup.add(operationPromise);
    operationPromise.finally(() => pendingSetup.delete(operationPromise)).catch(() => {});
    const result = await Promise.race([operationPromise, hardTimeout].filter(Boolean));
    await assertRunActive(`${phase}:after`);
    return result;
  };

  await assertRunActive('run load');
  project = run.projectId
    ? await prisma.codexProject.findUnique({ where: { id: run.projectId } }).catch(() => null)
    : null;
  await assertRunActive('project load');

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
  drainTimeoutMs = readDrainTimeoutMs(runtimeEnv);
  const maxSteps = readMaxSteps(runtimeEnv, runtimePolicy);
  const timeoutError = new TimeoutError(timeoutMs);
  hardTimeout = new Promise((_, reject) => {
    hardTimeoutTimer = setTimeout(() => {
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);
    // Keep the worker alive until the run settles or reaches its hard limit.
    // A pending Promise alone does not retain Node 22's event loop; unref here
    // allowed an isolated worker to exit with the durable run still pending.
  });

  await assertRunActive('running event:before');
  await eventStore.appendEvent(runId, 'run_status', { status: 'running' }, { prisma });
  await assertRunActive('running event:after');

  const registry = agentAdapterRegistry || getDefaultAgentAdapterRegistry();
  let adapter;
  try {
    await assertRunActive('adapter resolve');
    adapter = registry.resolveImplementer({ env });
  } catch (err) {
    if (err?.code === 'CODEX_RUN_CANCELLED' || err?.isTimeout) throw err;
    const error = String(err?.message || err);
    await prisma.codexRun.update({
      where: { id: runId },
      data: { status: 'error', error, finishedAt: new Date(nowIso(clock)) },
    });
    await eventStore.appendEvent(runId, 'run_status', { status: 'error' }, { prisma });
    await publishTerminalSignals({
      run,
      project,
      status: 'error',
      error,
      prisma,
      triggers,
      env,
      clock,
    });
    return { status: 'error', error };
  }
  let nativeRunner = runner;
  let nativeSessionService = sessionService;
  let nativeResumeSnapshot = null;
  let nativeCheckpointService = checkpointService;

  if (adapter === nativeCodexAdapter) {
    await assertRunActive('native setup');
    nativeRunner = nativeRunner || createSandboxClient();
    nativeRunner = guardedRunner(nativeRunner, controller.signal);
    nativeCheckpointService = guardedCheckpointService(checkpointService, controller.signal);
    if (defaultOnFeature(env, 'CODEX_SESSION_ARTIFACTS')) {
      nativeSessionService = nativeSessionService || createSessionService({ db: prisma, clock });
    }

    if (
      nativeSessionService
      && resumeSnapshot?.sessionId === run.id
      && Number.isSafeInteger(resumeSnapshot.cursorSeq)
    ) {
      try {
        const stored = await runSetupPhase('session read', () => nativeSessionService.readSnapshot({
          projectId: run.projectId,
          sessionId: run.id,
        }));
        if (
          snapshotIsResumable(stored)
          && stored.cursorSeq === resumeSnapshot.cursorSeq
          && (!resumeSnapshot.checkpointSha || stored.checkpointSha === resumeSnapshot.checkpointSha)
        ) {
          nativeResumeSnapshot = stored.loopState || null;
        }
      } catch (error) {
        if (error?.code === 'CODEX_RUN_CANCELLED' || error?.isTimeout) throw error;
        // The loop falls back to the latest durable context_snapshot event.
      }
    }

    if (run.mode === 'build' && defaultOnFeature(env, 'CODEX_RUN_BRANCHES')) {
      let branch;
      try {
        branch = await runSetupPhase('branch prepare', () => nativeCheckpointService.prepareRunBranch({
          run,
          project,
          deps: { runner: nativeRunner },
        }));
      } catch (error) {
        if (error?.code === 'CODEX_RUN_CANCELLED' || error?.isTimeout) throw error;
        branch = {
          ok: false,
          code: 'run_branch_setup_failed',
          detail: String(error?.message || error).slice(0, 1000),
        };
      }
      if (
        !branch?.ok
        && branch?.code === 'working_tree_dirty'
        && typeof nativeRunner.recoverRunBase === 'function'
      ) {
        await assertRunActive('branch recovery decision');
        await assertRunActive('branch recovery:before');
        const baseBranch = nativeCheckpointService.projectBaseBranch(project);
        const recovery = baseBranch
          ? await runSetupPhase('branch recovery', () => nativeRunner.recoverRunBase(run.projectId, run.id, { baseBranch })).catch((error) => {
            if (error?.code === 'CODEX_RUN_CANCELLED' || error?.isTimeout) throw error;
            return {
            ok: false,
            code: error?.body?.error || 'run_worktree_recovery_failed',
            detail: String(error?.body?.detail || error?.message || error).slice(0, 1000),
            };
          })
          : { ok: false, code: 'invalid_base_branch' };
        if (recovery?.ok) {
          try {
            branch = await runSetupPhase('branch prepare after recovery', () => nativeCheckpointService.prepareRunBranch({
              run,
              project,
              deps: { runner: nativeRunner },
            }));
          } catch (error) {
            if (error?.code === 'CODEX_RUN_CANCELLED' || error?.isTimeout) throw error;
            branch = {
              ok: false,
              code: 'run_branch_setup_failed',
              detail: String(error?.message || error).slice(0, 1000),
            };
          }
          if (branch?.ok) {
            branch.recovery = recovery;
            await assertRunActive('branch recovery narrative');
            await eventStore.appendEvent(run.id, 'narrative_delta', {
              text: `Se preservó el workspace previo en ${recovery.recoveryRef || 'una referencia Git de recuperación'} antes de aislar la ejecución.`,
            }, { prisma }).catch(() => {});
          }
        } else {
          branch = recovery;
        }
      }
      await assertRunActive('branch result');
      if (!branch?.ok) {
        const error = `run branch setup failed (${branch?.code || 'unknown'}): ${String(branch?.detail || '').slice(0, 1000)}`;
        await prisma.codexRun.update({
          where: { id: runId },
          data: { status: 'error', error, finishedAt: new Date(nowIso(clock)) },
        });
        await eventStore.appendEvent(runId, 'run_status', { status: 'error' }, { prisma });
        await publishTerminalSignals({
          run,
          project,
          status: 'error',
          error,
          prisma,
          triggers,
          env,
          clock,
        });
        return { status: 'error', error };
      }
      if (branch.worktree && typeof nativeRunner.forRun === 'function') {
        await assertRunActive('scoped runner');
        nativeRunner = nativeRunner.forRun(run.id, run.projectId);
      }
    }

    if (
      nativeSessionService
      && typeof eventStore.registerTranscriptSink === 'function'
    ) {
      await assertRunActive('transcript setup:before');
      unregisterTranscript = eventStore.registerTranscriptSink(run.id, async (envelope) => {
        if (controller.signal.aborted || await isCancelled()) return;
        const appended = await nativeSessionService.appendTranscript({
          projectId: run.projectId,
          sessionId: run.id,
          entry: { ...envelope, sourceSeq: envelope.seq },
        });
        if (envelope.type === 'context_snapshot') {
          if (controller.signal.aborted || await isCancelled()) return;
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
      await assertRunActive('transcript setup:after');
    }
  }
  await assertRunActive('adapter execute');
  for (const runtimeEvent of openclawCapabilityKernel.buildOpenClawRuntimeEvents(openclawRuntimeProfile)) {
    await assertRunActive(`runtime event ${runtimeEvent.type}`);
    await runSetupPhase(`runtime event ${runtimeEvent.type}`, async () => {
      await eventStore
        .appendEvent(run.id, runtimeEvent.type, runtimeEvent, { prisma })
        .catch(() => {});
    });
  }

  let outcome;
  let work = null;
  try {
    const companySoul = await require('./company-registry')
      .loadCompanySoul({ prisma, codexProject: project })
      .catch(() => ({ company: null, prompt: '' }));
    const promptBlocks = [
      openclawCapabilityKernel.buildOpenClawPromptBlock(openclawRuntimeProfile),
      companySoul.prompt,
    ].filter(Boolean);
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
        checkpointService: nativeCheckpointService,
        sessionService: nativeSessionService,
        resumeSnapshot: nativeResumeSnapshot,
        openclawRuntimeProfile,
        openclawPromptBlock: promptBlocks.join('\n\n'),
      },
      // Test injection remains at the native boundary; production lazily
      // resolves agent-loop inside native-codex-adapter.
      runAgentLoop,
    });
    adapterStarted = true;
    work = Promise.resolve(adapter.execute(request, context));
    outcome = assertAgentOutcome(await Promise.race([work, hardTimeout]));
  } catch (err) {
    // A timeout is cooperative: abort the adapter, then give it a bounded drain
    // window before committing the terminal row. This prevents late adapter
    // completion from racing the lifecycle write while keeping a hung adapter
    // from holding the worker forever. The timeout outcome always wins.
    if (err?.isTimeout) await drainExecution(work, drainTimeoutMs);
    outcome = { status: 'error', error: err?.isTimeout ? err.message : String(err?.message || err) };
  }

  // Cancellation (out-of-band) wins over a late "done". cancelRun already
  // flipped the row to `cancelled` and emitted the run_status event, so here we
  // only stamp finishedAt — emitting again would duplicate the terminal event.
  if (await isCancelled()) {
    await prisma.codexRun
      .update({ where: { id: runId }, data: { finishedAt: new Date(nowIso(clock)) } })
      .catch(() => {});
    // cancelRun owns the terminal event, webhook, metric and fallback ledger.
    // Re-publishing here would double-count the same cancellation.
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
    // The concurrent owner that won the conditional transition is responsible
    // for its terminal side effects. This processor must only observe the race.
    return { status: fresh?.status || status, raced: true };
  }
  await eventStore.appendEvent(runId, 'run_status', { status }, { prisma });
  if (['done', 'error', 'cancelled'].includes(status)) {
    await publishTerminalSignals({
      run,
      project,
      status,
      error: errorMsg,
      prisma,
      triggers,
      env,
      clock,
    });
  }

  let fleetQaResult = null;
  const mergedSha = outcome?.close?.branchFinalization?.merge?.status === 'merged'
    ? outcome.close.branchFinalization.merge.commitSha
    : null;
  if (status === 'done' && mergedSha) {
    const reviewer = fleetQualityReviewer || require('./fleet-quality-reviewer');
    const qaController = new AbortController();
    const qaTimeoutMs = readFleetQaTimeoutMs(env, fleetQaTimeoutMs);
    const abortFromParent = () => {
      if (!qaController.signal.aborted) {
        qaController.abort(fleetQaSignal?.reason || new Error('fleet QA cancelled'));
      }
    };
    if (fleetQaSignal) {
      if (fleetQaSignal.aborted) abortFromParent();
      else fleetQaSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    let rejectOnAbort;
    const aborted = new Promise((_, reject) => {
      rejectOnAbort = () => {
        const reason = qaController.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason || 'fleet QA cancelled')));
      };
      if (qaController.signal.aborted) rejectOnAbort();
      else qaController.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    const qaTimer = setTimeout(() => {
      if (!qaController.signal.aborted) {
        qaController.abort(new FleetQaTimeoutError(qaTimeoutMs));
      }
    }, qaTimeoutMs);
    // The matching finally block clears this timer. Keeping it referenced
    // guarantees that post-terminal QA either completes or times out instead
    // of disappearing when it is the last outstanding worker operation.
    const qaUsageExecutionId = randomUUID();
    let qaUsageSequence = 0;
    try {
      fleetQaResult = await Promise.race([
        reviewer.reviewMergedCheckpoint({
          prisma,
          project,
          run,
          mergeSha: mergedSha,
          deps: {
            // The run is terminal and its scoped worktree may already be gone.
            runner: nativeRunner?.baseRunner || nativeRunner,
            tier: run.tier || null,
            model: run.model || null,
            signal: qaController.signal,
            onUsage: (usage, attribution = {}) => {
              qaUsageSequence += 1;
              return persistFleetQaUsage({
                prisma,
                project,
                run,
                usage,
                departmentPoolId: attribution.departmentPoolId,
                reviewId: attribution.reviewId,
                idempotencyKey: `fleet-qa:${run.id}:${qaUsageExecutionId}:${qaUsageSequence}`,
                env,
                costResolver: fleetQaCostResolver,
              });
            },
          },
          env,
          now: clock || (() => new Date()),
        }),
        aborted,
      ]);
      if (fleetQaResult.action === 'reviewed') {
        await eventStore.appendEvent(run.id, 'narrative_delta', {
          text: `QA de flota revisó ${fleetQaResult.mergeCount} merge(s): ${fleetQaResult.findings} hallazgo(s), ${fleetQaResult.tasksCreated} tarea(s) añadida(s) al DAG.`,
        }, { prisma }).catch(() => {});
      } else if (['review_failed', 'review_deferred'].includes(fleetQaResult.action)) {
        await eventStore.appendEvent(run.id, 'narrative_delta', {
          text: `QA de flota conservará el checkpoint pendiente para reintento: ${fleetQaResult.error}.`,
        }, { prisma }).catch(() => {});
      }
    } catch (qaError) {
      fleetQaResult = {
        action: 'review_failed',
        error: String(qaError?.message || qaError).slice(0, 500),
      };
      if (env?.NODE_ENV !== 'test') {
        console.warn('[codex run-processor] fleet QA failed:', qaError?.message || qaError);
      }
    } finally {
      clearTimeout(qaTimer);
      qaController.signal.removeEventListener('abort', rejectOnAbort);
      if (fleetQaSignal) fleetQaSignal.removeEventListener('abort', abortFromParent);
    }
  }

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
        reasoningEffort: run.reasoningEffort,
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
  return {
    status,
    error: errorMsg,
    autoContinuedRunId,
    autoContinueError,
    executionMode: runtimePolicy.depth,
    fleetQaResult,
  };
  } catch (err) {
    if (adapterStarted) throw err;
    if (err?.isTimeout) {
      for (const operation of [...pendingSetup]) {
        await drainExecution(operation, drainTimeoutMs);
      }
    }
    const cancelled = await isCancelled().catch(() => false);
    if (cancelled) return finishCancelled();

    const error = String(err?.message || err).slice(0, 2000);
    const flip = await prisma.codexRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'error', error, finishedAt: new Date(nowIso(clock)) },
    }).catch(() => ({ count: 0 }));
    if (flip?.count === 1) {
      await eventStore.appendEvent(runId, 'run_status', { status: 'error' }, { prisma }).catch(() => {});
      await publishTerminalSignals({
        run,
        project,
        status: 'error',
        error,
        prisma,
        triggers,
        env,
        clock,
      }).catch(() => {});
    }
    return { status: 'error', error };
  } finally {
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
    if (unregisterTranscript) {
      try { unregisterTranscript(); } catch { /* best-effort cleanup */ }
    }
    releaseCodexRun(runId, controller);
  }
}

module.exports = {
  processCodexRunJob,
  abortCodexRun,
  abortRun: abortCodexRun,
  TimeoutError,
  FleetQaTimeoutError,
  readTimeoutMs,
  readDrainTimeoutMs,
  readFleetQaTimeoutMs,
  readMaxSteps,
  persistFleetQaUsage,
  publishTerminalSignals,
  defaultOnFeature,
  executionContextForAdapter,
  guardedRunner,
  guardedCheckpointService,
};
