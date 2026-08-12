'use strict';

const proactiveLeaseDefault = require('./proactive-lease');
const briefStoreDefault = require('./project-brief-store');

class CodexSwarmLifecycleError extends Error {
  constructor(code, message, status = 500, details = null) {
    super(message);
    this.name = 'CodexSwarmLifecycleError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function proactiveSnapshot(brief) {
  const source = record(brief);
  return {
    present: Object.prototype.hasOwnProperty.call(source, 'proactive'),
    value: cloneJson(source.proactive),
  };
}

async function suspendProactiveForFleetLaunch({
  prisma,
  projectId,
  userId,
  briefStore = briefStoreDefault,
} = {}) {
  let snapshot = null;
  let changed = false;
  const updated = await briefStore.mutateProjectBrief({
    prisma,
    projectId,
    userId,
    mutate: (brief) => {
      snapshot = proactiveSnapshot(brief);
      const current = record(brief.proactive);
      if (current.enabled !== true) return brief;
      changed = true;
      return {
        ...brief,
        proactive: {
          ...current,
          enabled: false,
          fleetMode: null,
          continuity: null,
        },
      };
    },
  });
  if (!updated || !snapshot) {
    throw new CodexSwarmLifecycleError(
      'codex_swarm_project_unavailable',
      'The project could not be prepared for the durable swarm.',
      404,
    );
  }
  return { changed, snapshot };
}

async function restoreProactiveAfterFailedFleetLaunch({
  prisma,
  projectId,
  userId,
  snapshot,
  briefStore = briefStoreDefault,
} = {}) {
  if (!snapshot || typeof snapshot.present !== 'boolean') {
    throw new CodexSwarmLifecycleError(
      'codex_swarm_proactive_snapshot_invalid',
      'The proactive state snapshot is unavailable.',
      500,
    );
  }
  const restored = await briefStore.mutateProjectBrief({
    prisma,
    projectId,
    userId,
    mutate: (brief) => {
      if (snapshot.present) {
        return { ...brief, proactive: cloneJson(snapshot.value) };
      }
      const next = { ...brief };
      delete next.proactive;
      return next;
    },
  });
  if (!restored) {
    throw new CodexSwarmLifecycleError(
      'codex_swarm_project_unavailable',
      'The project proactive state could not be restored.',
      404,
    );
  }
  return restored;
}

function lifecycleCause(error) {
  return {
    code: String(error?.code || 'codex_swarm_failed').slice(0, 160),
    message: String(error?.message || error || 'Enterprise swarm failed.').slice(0, 500),
  };
}

async function launchFleetSafely({
  prisma,
  project,
  userId,
  createFleet,
  enqueueSwarm,
  cancelSwarm,
  hasActiveRun,
  proactiveLease = proactiveLeaseDefault,
  briefStore = briefStoreDefault,
  env = process.env,
} = {}) {
  if (!prisma || !project?.id || !userId) {
    throw new CodexSwarmLifecycleError(
      'codex_swarm_launch_context_required',
      'A project and owner are required to launch the durable swarm.',
      400,
    );
  }
  if (typeof createFleet !== 'function' || typeof enqueueSwarm !== 'function') {
    throw new CodexSwarmLifecycleError(
      'codex_swarm_launch_dependencies_required',
      'The durable swarm launch dependencies are unavailable.',
      500,
    );
  }

  const lease = await proactiveLease.acquireProactiveLease({
    prisma,
    projectId: project.id,
    now: new Date(),
    env,
  });
  if (!lease) {
    throw new CodexSwarmLifecycleError(
      'codex_proactive_cycle_in_progress',
      'Espera a que termine el ciclo PROACTIVO actual antes de iniciar la flota.',
      409,
    );
  }

  let fleet = null;
  let transition = null;
  try {
    // Planning and durable creation happen while the previous proactive state
    // is still intact. The shared lease prevents the legacy ticker from
    // starting a new run while the fleet planner is working.
    fleet = await createFleet();
    const swarmId = String(fleet?.swarm?.id || '').trim();
    if (!swarmId) {
      throw new CodexSwarmLifecycleError(
        'codex_swarm_create_invalid',
        'The fleet planner did not create a durable swarm.',
        500,
      );
    }

    // Only suspend the legacy ticker after a durable swarm exists. If enqueue
    // fails, the exact raw JSON snapshot (including unknown future fields or
    // property absence) is restored before the error is returned.
    transition = await suspendProactiveForFleetLaunch({
      prisma,
      projectId: project.id,
      userId,
      briefStore,
    });

    if (typeof hasActiveRun === 'function' && await hasActiveRun()) {
      throw new CodexSwarmLifecycleError(
        'run_in_progress',
        'A run became active while the durable swarm was being prepared.',
        409,
      );
    }

    await enqueueSwarm({ swarmId });
    return { fleet, proactiveWasEnabled: transition.changed };
  } catch (error) {
    const compensation = [];
    const swarmId = String(fleet?.swarm?.id || '').trim();
    if (swarmId && typeof cancelSwarm === 'function') {
      try {
        await cancelSwarm({ swarmId, reason: 'swarm_launch_not_accepted' });
      } catch (cancelError) {
        compensation.push({ phase: 'cancel_swarm', ...lifecycleCause(cancelError) });
      }
    }
    if (transition) {
      try {
        await restoreProactiveAfterFailedFleetLaunch({
          prisma,
          projectId: project.id,
          userId,
          snapshot: transition.snapshot,
          briefStore,
        });
      } catch (restoreError) {
        compensation.push({ phase: 'restore_proactive', ...lifecycleCause(restoreError) });
      }
    }
    if (compensation.length) {
      throw new CodexSwarmLifecycleError(
        'codex_swarm_launch_compensation_failed',
        'The swarm was not accepted and its previous state could not be restored completely.',
        503,
        { cause: lifecycleCause(error), compensation },
      );
    }
    throw error;
  } finally {
    try {
      await proactiveLease.releaseProactiveLease({ prisma, lease });
    } catch (releaseError) {
      // Once accepted, PROACTIVO is already off; an expired lease is harmless.
      // Before acceptance, compensation has already restored the state.
      console.warn('[codex swarm] proactive launch lease release failed:', releaseError?.message || releaseError);
    }
  }
}

async function cancelRunFamiliesReliably({
  runIds,
  cancelRunFamily,
  maxAttempts = 2,
  concurrency = 8,
} = {}) {
  const uniqueRunIds = [...new Set(
    (Array.isArray(runIds) ? runIds : [])
      .map((runId) => String(runId || '').trim())
      .filter(Boolean),
  )];
  const attemptsLimit = Math.max(1, Math.min(3, Number.parseInt(maxAttempts, 10) || 2));
  const concurrencyLimit = Math.max(1, Math.min(32, Number.parseInt(concurrency, 10) || 8));
  const results = new Array(uniqueRunIds.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < uniqueRunIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const runId = uniqueRunIds[index];
      const errors = [];
      for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
        try {
          const result = await cancelRunFamily(runId);
          results[index] = {
            runId,
            status: 'cancelled',
            attempts: attempt,
            cancelledRunIds: Array.isArray(result?.cancelledRunIds)
              ? result.cancelledRunIds.map(String)
              : [],
            runs: Array.isArray(result?.runs) ? result.runs : [],
          };
          break;
        } catch (error) {
          errors.push(lifecycleCause(error));
        }
      }
      if (!results[index]) {
        results[index] = {
          runId,
          status: 'failed',
          attempts: attemptsLimit,
          errors,
        };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrencyLimit, uniqueRunIds.length) },
      () => worker(),
    ),
  );
  const failed = results.filter((result) => result.status === 'failed');
  return {
    complete: failed.length === 0,
    requested: uniqueRunIds.length,
    cancelled: results.length - failed.length,
    failed: failed.length,
    results,
  };
}

module.exports = {
  CodexSwarmLifecycleError,
  cancelRunFamiliesReliably,
  launchFleetSafely,
  proactiveSnapshot,
  restoreProactiveAfterFailedFleetLaunch,
  suspendProactiveForFleetLaunch,
};
