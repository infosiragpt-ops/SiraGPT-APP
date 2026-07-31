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

  const startedAt = new Date(nowIso(clock));
  const claim = await prisma.codexRun.updateMany({
    where: { id: runId, status: 'queued' },
    data: { status: 'running', startedAt },
  });
  if (claim?.count !== 1) {
    const current = await prisma.codexRun.findUnique({ where: { id: runId } }).catch(() => null);
    return { status: current?.status || 'not_found', skipped: true, claimLost: true };
  }
  const run = await prisma.codexRun.findUnique({ where: { id: runId } })
    .catch(() => null) || { ...queuedRun, status: 'running', startedAt };

  const project = run.projectId
    ? await prisma.codexProject.findUnique({ where: { id: run.projectId } }).catch(() => null)
    : null;

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
      let branch = await checkpointService.prepareRunBranch({
        run,
        project,
        deps: { runner: nativeRunner },
      }).catch((error) => ({
        ok: false,
        code: 'run_branch_setup_failed',
        detail: String(error?.message || error).slice(0, 1000),
      }));
      if (
        !branch?.ok
        && branch?.code === 'working_tree_dirty'
        && typeof nativeRunner.recoverRunBase === 'function'
      ) {
        const baseBranch = checkpointService.projectBaseBranch(project);
        const recovery = baseBranch
          ? await nativeRunner.recoverRunBase(run.projectId, run.id, { baseBranch }).catch((error) => ({
            ok: false,
            code: error?.body?.error || 'run_worktree_recovery_failed',
            detail: String(error?.body?.detail || error?.message || error).slice(0, 1000),
          }))
          : { ok: false, code: 'invalid_base_branch' };
        if (recovery?.ok) {
          branch = await checkpointService.prepareRunBranch({
            run,
            project,
            deps: { runner: nativeRunner },
          }).catch((error) => ({
            ok: false,
            code: 'run_branch_setup_failed',
            detail: String(error?.message || error).slice(0, 1000),
          }));
          if (branch?.ok) {
            branch.recovery = recovery;
            await eventStore.appendEvent(run.id, 'narrative_delta', {
              text: `Se preservó el workspace previo en ${recovery.recoveryRef || 'una referencia Git de recuperación'} antes de aislar la ejecución.`,
            }, { prisma }).catch(() => {});
          }
        } else {
          branch = recovery;
        }
      }
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
        nativeRunner = nativeRunner.forRun(run.id, run.projectId);
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
  const drainTimeoutMs = readDrainTimeoutMs(runtimeEnv);
  const maxSteps = readMaxSteps(runtimeEnv, runtimePolicy);
  const controller = new AbortController();
  activeControllers.set(String(runId), controller);

  try {
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
        checkpointService,
        sessionService: nativeSessionService,
        resumeSnapshot: nativeResumeSnapshot,
        openclawRuntimeProfile,
        openclawPromptBlock: promptBlocks.join('\n\n'),
      },
      // Test injection remains at the native boundary; production lazily
      // resolves agent-loop inside native-codex-adapter.
      runAgentLoop,
    });
    work = Promise.resolve(adapter.execute(request, context));
    const timeout = new Promise((_, reject) => {
      // Reject BEFORE aborting so the timeout deterministically wins the race
      // even if the loop resolves synchronously inside its abort handler.
      timer = setTimeout(() => {
        const timeoutError = new TimeoutError(timeoutMs);
        reject(timeoutError);
        controller.abort(timeoutError);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    outcome = assertAgentOutcome(await Promise.race([work, timeout]));
  } catch (err) {
    // A timeout is cooperative: abort the adapter, then give it a bounded drain
    // window before committing the terminal row. This prevents late adapter
    // completion from racing the lifecycle write while keeping a hung adapter
    // from holding the worker forever. The timeout outcome always wins.
    if (err?.isTimeout) await drainExecution(work, drainTimeoutMs);
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
    qaTimer.unref?.();
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
  } finally {
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
