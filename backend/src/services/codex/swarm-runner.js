'use strict';

const { Queue, Worker } = require('bullmq');
const { randomUUID } = require('node:crypto');

const prismaDefault = require('../../config/database');
const { createSandboxClient } = require('./sandbox-provider');
const {
  createRedisConnection,
  getRuntimeOptions,
} = require('./run-queue');
const { isCodexV2Enabled } = require('./flags');
const runServiceDefault = require('./run-service');
const projectBudget = require('./project-budget');
const projectSettings = require('./project-settings');
const usageLedger = require('./usage-ledger');
const {
  CodexSwarmError,
  CodexSwarmOrchestrator,
  MAX_LEASE_MS,
  SWARM_STATUSES,
  TERMINAL_SWARM_STATUSES,
  TASK_ROLES,
  TASK_STATUSES,
} = require('./swarm-orchestrator');

const QUEUE_NAME = process.env.CODEX_SWARM_QUEUE_NAME || 'codex-swarms';
const DEFAULT_RUNTIME_CONCURRENCY = 8;
const MAX_RUNTIME_CONCURRENCY = 32;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_INTEGRATION_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_TASK_BUDGET_RESERVATION_USD = 0.25;

let queue = null;
let queueConnection = null;
let worker = null;
let workerConnection = null;

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSwarmQueue() {
  if (queue) return queue;
  queueConnection = createRedisConnection({ label: 'codex-swarms-queue' });
  queue = new Queue(QUEUE_NAME, {
    ...getRuntimeOptions(),
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 500 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    },
  });
  queue.on('error', (error) => {
    console.error('[codex-swarms] queue error:', error?.message || error);
  });
  return queue;
}

async function enqueueSwarm({ swarmId }) {
  if (!swarmId) throw new Error('swarmId is required');
  const swarmQueue = getSwarmQueue();
  const jobId = String(swarmId);
  const existing = await swarmQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => 'unknown');
    if (!['completed', 'failed'].includes(state)) return existing;
    await existing.remove().catch(() => {});
  }
  return swarmQueue.add('codex-swarm', { swarmId }, { jobId });
}

async function recoverSwarmJobs({
  prisma = prismaDefault,
  env = process.env,
} = {}) {
  if (!isCodexV2Enabled(env) || !env.REDIS_URL || !prisma?.codexSwarm?.findMany) {
    return { recovered: 0 };
  }
  const swarms = await prisma.codexSwarm.findMany({
    where: {
      status: {
        in: [SWARM_STATUSES.QUEUED, SWARM_STATUSES.RUNNING],
      },
      cancelRequestedAt: null,
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  const results = await Promise.allSettled(swarms.map((swarm) => (
    enqueueSwarm({ swarmId: swarm.id })
  )));
  return {
    recovered: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

async function defaultWebSearch(query) {
  try {
    const { search } = require('../agents/web-search');
    return search(query, { maxResults: 5 });
  } catch {
    return { results: [] };
  }
}

function safeResult(outcome) {
  return {
    ok: outcome?.ok === true,
    agent: String(outcome?.agent || '').slice(0, 80),
    summary: String(outcome?.result || '').slice(0, 12_000),
    steps: Math.max(0, Number(outcome?.steps) || 0),
    toolCallsCount: Math.max(0, Number(outcome?.toolCallsCount) || 0),
    durationMs: Math.max(0, Number(outcome?.durationMs) || 0),
    tokensIn: Math.max(0, Number(outcome?.tokensIn) || 0),
    tokensOut: Math.max(0, Number(outcome?.tokensOut) || 0),
  };
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function swarmClaimBudgetPolicy({
  project,
  settings,
  env = process.env,
}) {
  const configuredReservation = Number(env.CODEX_SWARM_DEFAULT_RESERVATION_USD);
  return {
    projectDailyBudgetUsd: projectBudget.configuredBudgetUsd(settings, env),
    companyDailyBudgetUsd: projectBudget.configuredCompanyBudgetUsd(project, env),
    defaultReservationUsd: Number.isFinite(configuredReservation) && configuredReservation > 0
      ? Math.min(100_000, configuredReservation)
      : DEFAULT_TASK_BUDGET_RESERVATION_USD,
  };
}

function isBudgetDeferralError(error) {
  const code = String(error?.code || '').trim();
  return code.startsWith('swarm_project_budget_')
    || code.startsWith('swarm_company_budget_')
    || code.startsWith('swarm_department_budget_')
    || code === 'swarm_usage_accounting_failed'
    || code === 'codex_usage_ledger_unavailable';
}

async function assertProjectBudgetAvailable({
  prisma,
  project,
  settings,
  env,
  now,
}) {
  const budget = await projectBudget.checkProjectBudget({
    prisma,
    projectId: project.id,
    settings: settings || projectSettings.settingsFromProject(project),
    env,
    now,
  });
  if (!budget?.allowed) {
    const error = new Error(`swarm_project_budget_blocked:${budget?.reason || 'unknown'}`);
    error.code = budget?.reason === 'daily_budget_exceeded'
      ? 'swarm_project_budget_exceeded'
      : 'swarm_project_budget_check_failed';
    error.budget = budget;
    throw error;
  }
  return budget;
}

async function loadSwarmProjectSettings({
  runner,
  project,
  env = process.env,
}) {
  if (typeof runner?.readFile !== 'function') {
    if (env.NODE_ENV === 'production') {
      const error = new Error('swarm project settings store unavailable');
      error.code = 'swarm_project_settings_unavailable';
      throw error;
    }
    return projectSettings.settingsFromProject(project);
  }
  const state = await projectSettings.loadProjectSettings({
    runner,
    projectId: project.id,
    project,
  });
  if (state.error) {
    const error = new Error(`swarm project settings unavailable: ${state.error}`);
    error.code = 'swarm_project_settings_unavailable';
    throw error;
  }
  return state.settings;
}

function createSwarmUsageAccountant({
  prisma,
  project,
  task,
  settings = null,
  env = process.env,
  costResolver = null,
  idFactory = randomUUID,
  clock = () => new Date(),
}) {
  const input = recordValue(task?.input);
  const departmentPoolId = String(input.departmentPoolId || '').trim() || null;
  const reservationUsd = Number.isFinite(Number(input.poolBudgetReservationUsd))
    ? Math.max(0, Number(input.poolBudgetReservationUsd))
    : null;
  const executionId = idFactory();
  let sequence = 0;
  let taskCostUsd = 0;

  return async (usage) => {
    sequence += 1;
    let entry;
    try {
      entry = await usageLedger.recordUsage({
        prisma,
        projectId: project?.id,
        departmentPoolId,
        source: 'swarm_task',
        sourceId: task?.id,
        idempotencyKey: `swarm:${task?.id}:${executionId}:${sequence}`,
        usage,
        env,
        costResolver,
      });
    } catch (cause) {
      const error = new Error(`swarm_usage_accounting_failed:${cause?.message || cause}`);
      error.code = 'swarm_usage_accounting_failed';
      error.cause = cause;
      throw error;
    }
    taskCostUsd += Math.max(
      0,
      Number(entry?.costOriginalUsd) || 0,
      Number(entry?.costAppliedUsd) || 0,
    );

    const checkAt = clock();
    await assertProjectBudgetAvailable({
      prisma,
      project,
      settings,
      env,
      now: checkAt,
    });
    const companyBudget = await projectBudget.checkCompanyDailyBudget({
      prisma,
      project,
      env,
      now: checkAt,
    });
    if (!companyBudget?.allowed) {
      const error = new Error(`swarm_company_budget_blocked:${companyBudget?.reason || 'unknown'}`);
      error.code = companyBudget?.reason === 'daily_budget_exceeded'
        ? 'swarm_company_budget_exceeded'
        : 'swarm_company_budget_check_failed';
      error.budget = companyBudget;
      throw error;
    }

    if (departmentPoolId) {
      const poolBudget = await projectBudget.checkDepartmentPoolBudget({
        prisma,
        projectId: project.id,
        departmentPoolId,
        swarmTaskId: task.id,
        reservationUsd,
        reservationUsageUsd: taskCostUsd,
        env,
        now: checkAt,
      });
      if (!poolBudget?.allowed) {
        const error = new Error(`swarm_department_budget_blocked:${poolBudget?.reason || 'unknown'}`);
        error.code = ['department_pool_budget_limit', 'department_pool_run_reservation_exceeded']
          .includes(poolBudget?.reason)
          ? 'swarm_department_budget_exceeded'
          : 'swarm_department_budget_check_failed';
        error.budget = poolBudget;
        throw error;
      }
    }
    return entry;
  };
}

async function assertSwarmTaskBudgetAvailable({
  prisma,
  project,
  task,
  settings = null,
  env = process.env,
  clock = () => new Date(),
}) {
  const checkAt = clock();
  await assertProjectBudgetAvailable({
    prisma,
    project,
    settings,
    env,
    now: checkAt,
  });
  const companyBudget = await projectBudget.checkCompanyDailyBudget({
    prisma,
    project,
    env,
    now: checkAt,
  });
  if (!companyBudget?.allowed) {
    const error = new Error(`swarm_company_budget_blocked:${companyBudget?.reason || 'unknown'}`);
    error.code = companyBudget?.reason === 'daily_budget_exceeded'
      ? 'swarm_company_budget_exceeded'
      : 'swarm_company_budget_check_failed';
    error.budget = companyBudget;
    throw error;
  }

  const input = recordValue(task?.input);
  const departmentPoolId = String(input.departmentPoolId || '').trim();
  if (!departmentPoolId) return companyBudget;
  const reservationUsd = Number.isFinite(Number(input.poolBudgetReservationUsd))
    ? Math.max(0, Number(input.poolBudgetReservationUsd))
    : null;
  const poolBudget = await projectBudget.checkDepartmentPoolBudget({
    prisma,
    projectId: project.id,
    departmentPoolId,
    swarmTaskId: task.id,
    reservationUsd,
    reservationUsageUsd: 0,
    env,
    now: checkAt,
  });
  if (!poolBudget?.allowed) {
    const error = new Error(`swarm_department_budget_blocked:${poolBudget?.reason || 'unknown'}`);
    error.code = ['department_pool_budget_limit', 'department_pool_run_reservation_exceeded']
      .includes(poolBudget?.reason)
      ? 'swarm_department_budget_exceeded'
      : 'swarm_department_budget_check_failed';
    error.budget = poolBudget;
    throw error;
  }
  return poolBudget;
}

function dependencyContext(tasks, task, maxChars = 24_000) {
  const dependencies = new Set(Array.isArray(task?.dependsOn) ? task.dependsOn : []);
  const reports = tasks
    .filter((candidate) => dependencies.has(candidate.key))
    .map((candidate) => {
      const result = candidate.result && typeof candidate.result === 'object'
        ? candidate.result
        : {};
      return [
        `### ${candidate.title}`,
        `Estado: ${candidate.status}`,
        String(result.summary || result.error || candidate.error || 'Sin informe.'),
      ].join('\n');
    });
  return reports.join('\n\n').slice(0, maxChars);
}

function subagentForTask(task) {
  const requested = String(task?.input?.agent || '').trim();
  if (task.role === TASK_ROLES.REVIEWER) return requested || 'qa_reviewer';
  return requested || 'explorer';
}

function shouldRetryWriterTask(task, result) {
  return [TASK_ROLES.WRITER, TASK_ROLES.INTEGRATOR].includes(task?.role)
    && result?.ok !== true
    && Number(task?.attemptCount || 0) < Number(task?.maxAttempts || 1)
    && result?.status !== 'cancelled';
}

async function requeueWriterTask({
  prisma,
  task,
  workerId,
  leaseToken,
  result,
}) {
  const retry = await prisma.codexSwarmTask.updateMany({
    where: {
      id: task.id,
      status: TASK_STATUSES.RUNNING,
      leaseOwner: workerId,
      leaseToken,
    },
    data: {
      status: TASK_STATUSES.QUEUED,
      claimId: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: new Date(),
      result: {
        ...result,
        retrying: true,
        previousAttempt: task.attemptCount,
      },
      error: null,
      finishedAt: null,
      version: { increment: 1 },
    },
  });
  if (retry?.count !== 1) {
    throw new CodexSwarmError(
      'codex_swarm_lease_conflict',
      'The writer task changed before it could be requeued.',
      409,
    );
  }
  return { requeued: true, attemptCount: task.attemptCount };
}

async function runReadOnlyTask({
  task,
  swarm,
  project,
  tasks,
  runner,
  sdk,
  env,
  webSearch,
  prisma,
  onUsage = null,
}) {
  const agent = subagentForTask(task);
  const definition = sdk.getSubagent(agent);
  if (!definition?.readOnly) {
    throw new Error(`swarm_read_only_agent_required:${agent}`);
  }
  const instruction = String(task?.input?.instruction || task.title || '').slice(0, 8_000);
  const context = [
    `Empresa/proyecto: ${project.name}`,
    `Objetivo del enjambre: ${String(swarm?.metadata?.objective || '').slice(0, 4_000)}`,
    dependencyContext(tasks, task),
  ].filter(Boolean).join('\n\n');
  const companySoul = String((await require('./company-operating-profile')
    .loadCompanySoul({ prisma, project })
    .catch(() => null))?.content || '');
  const outcome = await sdk.runSubagent({
    name: agent,
    task: instruction,
    context,
    model: task?.input?.model || null,
    effort: task.role === TASK_ROLES.REVIEWER ? 'high' : null,
    deps: {
      runner,
      project: project.id,
      env,
      tier: swarm?.metadata?.tier || null,
      webSearch,
      companySoul,
      onUsage,
      propagateUsageErrors: true,
    },
  });
  return safeResult(outcome);
}

async function waitForAutonomousRun({
  prisma,
  planRunId,
  swarmId = null,
  userId = null,
  runService = runServiceDefault,
  env,
  clock = Date.now,
  delay = sleep,
}) {
  const timeoutMs = integer(
    env.CODEX_SWARM_INTEGRATION_TIMEOUT_MS,
    DEFAULT_INTEGRATION_TIMEOUT_MS,
    60_000,
    4 * 60 * 60_000,
  );
  const pollMs = integer(env.CODEX_SWARM_POLL_MS, DEFAULT_POLL_MS, 250, 10_000);
  const deadline = clock() + timeoutMs;
  let last = null;
  let latestPlan = null;
  let latestBuild = null;
  while (clock() < deadline) {
    const [plan, build, swarm] = await Promise.all([
      prisma.codexRun.findUnique({ where: { id: planRunId } }),
      prisma.codexRun.findFirst({
        where: { planRunId },
        orderBy: { createdAt: 'desc' },
      }),
      swarmId
        ? prisma.codexSwarm.findUnique({
          where: { id: swarmId },
          select: { status: true, cancelRequestedAt: true },
        })
        : null,
    ]);
    latestPlan = plan;
    latestBuild = build;
    last = build || plan;
    if (!last) throw new Error('swarm_integration_run_missing');
    if (swarm?.cancelRequestedAt || swarm?.status === SWARM_STATUSES.CANCELLED) {
      const activeRuns = [build, plan].filter((run) => (
        run && ['queued', 'running', 'waiting_approval'].includes(run.status)
      ));
      await Promise.allSettled(activeRuns.map((run) => (
        runService.cancelRun({ userId, runId: run.id, db: prisma })
      )));
      return {
        ok: false,
        status: 'cancelled',
        planRunId,
        buildRunId: build?.id || null,
        error: 'swarm_cancelled',
      };
    }
    if (['done', 'error', 'cancelled'].includes(last.status)) {
      return {
        ok: last.status === 'done',
        status: last.status,
        planRunId,
        buildRunId: build?.id || null,
        error: last.error || null,
      };
    }
    await delay(pollMs);
  }
  const activeRuns = [latestBuild, latestPlan].filter((run) => (
    run && ['queued', 'running', 'waiting_approval'].includes(run.status)
  ));
  await Promise.allSettled(activeRuns.map((run) => (
    runService.cancelRun({ userId, runId: run.id, db: prisma })
  )));
  return {
    ok: false,
    status: 'timeout',
    planRunId,
    buildRunId: last?.planRunId ? last.id : null,
    error: 'swarm_integration_timeout',
  };
}

function startLeaseHeartbeat({
  orchestrator,
  swarmId,
  taskId,
  workerId,
  leaseToken,
  leaseMs = MAX_LEASE_MS,
  intervalMs = Math.max(5_000, Math.floor(leaseMs / 3)),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let stopped = false;
  let renewing = false;
  let error = null;
  const renew = async () => {
    if (stopped || renewing || error) return;
    renewing = true;
    try {
      await orchestrator.renewTaskLease({
        swarmId,
        taskId,
        workerId,
        leaseToken,
        leaseMs,
      });
    } catch (renewError) {
      error = renewError;
    } finally {
      renewing = false;
    }
  };
  const timer = setIntervalFn(() => {
    void renew();
  }, intervalMs);
  timer?.unref?.();
  return {
    get error() {
      return error;
    },
    async stop() {
      stopped = true;
      clearIntervalFn(timer);
      while (renewing) await sleep(10);
      return error;
    },
  };
}

async function createWriterRun({
  task,
  swarm,
  project,
  tasks,
  prisma,
  runService,
  env,
}) {
  const evidence = dependencyContext(tasks, task);
  const objective = String(task?.input?.objective || swarm?.metadata?.objective || task.title).slice(0, 4_000);
  const departmentId = String(task?.input?.departmentId || 'product-engineering').slice(0, 120);
  const acceptance = Array.isArray(task?.input?.acceptance)
    ? task.input.acceptance.map((item) => `- ${String(item).slice(0, 500)}`).join('\n')
    : '';
  const isIntegrator = task.role === TASK_ROLES.INTEGRATOR;
  const attempt = Math.max(1, Number.parseInt(task?.attemptCount, 10) || 1);
  const prompt = [
    `[SWARM · ${departmentId}]`,
    isIntegrator
      ? 'Eres el integrador final de una flota de agentes. Integra y verifica el objetivo en el workspace real.'
      : 'Eres un writer aislado de una flota de agentes. Implementa solamente tu tarea en el worktree asignado.',
    `Objetivo: ${objective}`,
    `Tarea: ${String(task?.input?.instruction || task.title).slice(0, 8_000)}`,
    acceptance ? `Criterios de aceptación:\n${acceptance}` : null,
    '',
    'Contexto de dependencias ya terminadas:',
    evidence || 'No se recibieron informes; inspecciona el workspace antes de actuar.',
    '',
    task?.result?.error
      ? `Intento anterior: ${String(task.result.error).slice(0, 4_000)}`
      : null,
    'Contrato: lee antes de editar, limita los cambios al encargo, ejecuta type-check/pruebas/preview, corrige fallos y entrega un checkpoint con resumen ejecutivo breve.',
    'El runtime integra tu rama de forma serializada. Si hay conflicto, informa rutas y contexto exacto; no fuerces ni borres cambios de otros runs.',
    'No ejecutes publicaciones, correos, ventas ni otros efectos externos desde esta corrida.',
  ].filter(Boolean).join('\n');
  const planRun = await runService.createRun({
    userId: project.userId,
    projectId: project.id,
    mode: 'plan',
    prompt,
    model: swarm?.metadata?.model || null,
    tier: swarm?.metadata?.tier || null,
    autoExecute: true,
    idempotencyKey: `swarm-task:${task.id}:attempt:${attempt}:plan`,
    departmentPoolId: task?.input?.departmentPoolId || null,
    swarmTaskId: task.id,
    db: prisma,
    env,
  });
  await prisma.codexSwarmTask.update({
    where: { id: task.id },
    data: {
      result: {
        ok: false,
        status: 'running',
        planRunId: planRun.id,
      },
    },
  });
  return waitForAutonomousRun({
    prisma,
    planRunId: planRun.id,
    swarmId: swarm.id,
    userId: project.userId,
    runService,
    env,
  });
}

const createIntegratorRun = createWriterRun;

async function processClaimedTask({
  claimed,
  swarm,
  project,
  orchestrator,
  prisma,
  runner,
  sdk,
  runService,
  env,
  webSearch,
  settings = null,
  usageCostResolver = null,
  usageIdFactory = randomUUID,
  usageClock = () => new Date(),
}) {
  const progress = await orchestrator.getProgress(swarm.id);
  const task = claimed.task;
  const heartbeat = startLeaseHeartbeat({
    orchestrator,
    swarmId: swarm.id,
    taskId: task.id,
    workerId: claimed.workerId,
    leaseToken: task.leaseToken,
  });
  let result;
  try {
    await assertSwarmTaskBudgetAvailable({
      prisma,
      project,
      task,
      settings,
      env,
      clock: usageClock,
    });
    if ([TASK_ROLES.WRITER, TASK_ROLES.INTEGRATOR].includes(task.role)) {
      result = await createWriterRun({
        task,
        swarm: progress.swarm,
        project,
        tasks: progress.tasks,
        prisma,
        runService,
        env,
      });
    } else {
      result = await runReadOnlyTask({
        task,
        swarm: progress.swarm,
        project,
        tasks: progress.tasks,
        runner,
        sdk,
        env,
        webSearch,
        prisma,
        onUsage: createSwarmUsageAccountant({
          prisma,
          project,
          task,
          settings,
          env,
          costResolver: usageCostResolver,
          idFactory: usageIdFactory,
          clock: usageClock,
        }),
      });
    }
  } finally {
    await heartbeat.stop();
  }
  if (heartbeat.error) throw heartbeat.error;
  const ok = result?.ok === true;
  if (shouldRetryWriterTask(task, result)) {
    await requeueWriterTask({
      prisma,
      task,
      workerId: claimed.workerId,
      leaseToken: task.leaseToken,
      result,
    });
    return;
  }
  await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: task.id,
    workerId: claimed.workerId,
    leaseToken: task.leaseToken,
    status: ok ? TASK_STATUSES.SUCCEEDED : TASK_STATUSES.FAILED,
    result,
    error: ok ? null : String(result?.error || result?.summary || 'swarm_task_failed').slice(0, 20_000),
  });
}

async function processSwarmJob({
  swarmId,
  env = process.env,
  prisma = prismaDefault,
  orchestrator = new CodexSwarmOrchestrator({ prisma }),
  runner = createSandboxClient(),
  sdk = require('./agent-sdk'),
  runService = runServiceDefault,
  webSearch = defaultWebSearch,
  usageCostResolver = null,
} = {}) {
  const swarm = await prisma.codexSwarm.findUnique({
    where: { id: swarmId },
    include: { project: true },
  });
  if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'Codex swarm not found.', 404);
  if (TERMINAL_SWARM_STATUSES.has(swarm.status)) return orchestrator.getProgress(swarm.id);
  const settings = await loadSwarmProjectSettings({
    runner,
    project: swarm.project,
    env,
  });
  const budgetPolicy = swarmClaimBudgetPolicy({
    project: swarm.project,
    settings,
    env,
  });

  const runtimeConcurrency = Math.min(
    swarm.maxConcurrency,
    integer(env.CODEX_SWARM_RUNNER_CONCURRENCY, DEFAULT_RUNTIME_CONCURRENCY, 1, MAX_RUNTIME_CONCURRENCY),
  );
  const pollMs = integer(env.CODEX_SWARM_POLL_MS, DEFAULT_POLL_MS, 250, 10_000);
  let stopRequested = false;
  let stopReason = null;

  const runWorker = async (index) => {
    const workerId = `swarm:${swarm.id}:${index}`;
    while (true) {
      if (stopRequested) return;
      const claim = await orchestrator.claimNextTask({
        swarmId: swarm.id,
        workerId,
        claimId: `${workerId}:${randomUUID()}`,
        leaseMs: MAX_LEASE_MS,
        budgetPolicy,
      });
      if (!claim.task) {
        if (claim.reason === 'swarm_paused') return;
        if (String(claim.reason || '').includes('budget')) {
          stopRequested = true;
          stopReason = claim.reason;
          if (claim.reason === 'department_pool_budget_limit') {
            await orchestrator.pauseSwarm({ swarmId: swarm.id });
          }
          return;
        }
        const progress = await orchestrator.getProgress(swarm.id);
        if (TERMINAL_SWARM_STATUSES.has(progress.swarm.status)) return;
        await sleep(pollMs);
        continue;
      }
      claim.workerId = workerId;
      if (stopRequested) {
        await orchestrator.deferTask({
          swarmId: swarm.id,
          taskId: claim.task.id,
          workerId,
          leaseToken: claim.task.leaseToken,
          reason: stopReason || 'swarm_budget_deferred',
        });
        return;
      }
      try {
        await processClaimedTask({
          claimed: claim,
          swarm,
          project: swarm.project,
          orchestrator,
          prisma,
          runner,
          sdk,
          runService,
          env,
          webSearch,
          settings,
          usageCostResolver,
        });
      } catch (error) {
        if (isBudgetDeferralError(error)) {
          stopRequested = true;
          stopReason = String(error?.message || error).slice(0, 20_000);
          await orchestrator.deferTask({
            swarmId: swarm.id,
            taskId: claim.task.id,
            workerId,
            leaseToken: claim.task.leaseToken,
            reason: stopReason,
          });
          return;
        }
        await orchestrator.finishTask({
          swarmId: swarm.id,
          taskId: claim.task.id,
          workerId,
          leaseToken: claim.task.leaseToken,
          status: TASK_STATUSES.FAILED,
          error: String(error?.message || error).slice(0, 20_000),
        }).catch(() => {});
      }
    }
  };

  await Promise.all(Array.from({ length: runtimeConcurrency }, (_, index) => runWorker(index + 1)));
  return orchestrator.getProgress(swarm.id);
}

function startSwarmWorker({ env = process.env, processor = processSwarmJob } = {}) {
  if (worker) return worker;
  if (!isCodexV2Enabled(env) || !env.REDIS_URL) return null;
  workerConnection = createRedisConnection({ label: 'codex-swarms-worker' });
  worker = new Worker(
    QUEUE_NAME,
    (job) => processor({ swarmId: job.data?.swarmId, env }),
    {
      ...getRuntimeOptions(),
      connection: workerConnection,
      concurrency: integer(env.CODEX_SWARM_JOB_CONCURRENCY, 1, 1, 4),
      lockDuration: integer(env.CODEX_SWARM_JOB_LOCK_MS, 2 * 60 * 60_000, 60_000, 4 * 60 * 60_000),
    },
  );
  worker.on('failed', (job, error) => {
    console.error(`[codex-swarms] job ${job?.id || '(unknown)'} failed:`, error?.message || error);
  });
  worker.on('error', (error) => {
    console.error('[codex-swarms] worker error:', error?.message || error);
  });
  return worker;
}

async function closeSwarmRuntime() {
  const closing = [];
  if (worker) closing.push(worker.close());
  if (queue) closing.push(queue.close());
  if (workerConnection) closing.push(workerConnection.quit().catch(() => workerConnection.disconnect()));
  if (queueConnection) closing.push(queueConnection.quit().catch(() => queueConnection.disconnect()));
  worker = null;
  queue = null;
  workerConnection = null;
  queueConnection = null;
  await Promise.allSettled(closing);
}

module.exports = {
  DEFAULT_INTEGRATION_TIMEOUT_MS,
  DEFAULT_RUNTIME_CONCURRENCY,
  DEFAULT_TASK_BUDGET_RESERVATION_USD,
  MAX_RUNTIME_CONCURRENCY,
  QUEUE_NAME,
  closeSwarmRuntime,
  assertSwarmTaskBudgetAvailable,
  assertProjectBudgetAvailable,
  createIntegratorRun,
  createWriterRun,
  dependencyContext,
  createSwarmUsageAccountant,
  enqueueSwarm,
  getSwarmQueue,
  isBudgetDeferralError,
  loadSwarmProjectSettings,
  processClaimedTask,
  processSwarmJob,
  recoverSwarmJobs,
  requeueWriterTask,
  runReadOnlyTask,
  safeResult,
  swarmClaimBudgetPolicy,
  startLeaseHeartbeat,
  startSwarmWorker,
  subagentForTask,
  shouldRetryWriterTask,
  waitForAutonomousRun,
};
