'use strict';

const {
  CodexSwarmOrchestrator,
  TASK_ROLES,
} = require('./swarm-orchestrator');
const { buildEnterpriseSwarmTasks } = require('./enterprise-swarm-plan');
const { configuredRunCap } = require('./run-service');
const { listDepartmentPools } = require('./department-pools');

const DEFAULT_PLANNER_TASKS = 8;
// Keep aligned with enterprise-swarm-plan MAX_LOGICAL_TASKS so "100+ agents"
// requests are not silently truncated back to a 64-task fleet.
const MAX_PLANNER_TASKS = 1000;
const DEFAULT_QA_EVERY = 5;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function slug(value, fallback = 'task') {
  return String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback;
}

function extractJson(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  const unfenced = source
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function roleFor(value) {
  const role = String(value || TASK_ROLES.WRITER).trim().toLowerCase().replace(/_/g, '-');
  if (['reviewer', 'qa', 'qa-reviewer'].includes(role)) return TASK_ROLES.REVIEWER;
  if (['read-only', 'readonly', 'researcher', 'research'].includes(role)) return TASK_ROLES.READ_ONLY;
  if (role === TASK_ROLES.INTEGRATOR) return TASK_ROLES.INTEGRATOR;
  return TASK_ROLES.WRITER;
}

function normalizePlannerTasks(rawTasks, { maxTasks = MAX_PLANNER_TASKS } = {}) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error('fleet_planner_tasks_required');
  }
  if (rawTasks.length > maxTasks) throw new Error('fleet_planner_task_limit');

  const sources = rawTasks.map((source, index) => {
    const rawKey = source?.key || source?.id || `task-${index + 1}`;
    return {
      source: source && typeof source === 'object' ? source : {},
      rawKey: String(rawKey),
      key: slug(rawKey, `task-${index + 1}`),
    };
  });
  const keyByRaw = new Map(sources.map((item) => [item.rawKey, item.key]));
  const seen = new Set();
  return sources.map(({ source, key }, index) => {
    let uniqueKey = key;
    let suffix = 2;
    while (seen.has(uniqueKey)) {
      uniqueKey = `${key}-${suffix}`;
      suffix += 1;
    }
    seen.add(uniqueKey);
    const dependsOn = Array.isArray(source.dependsOn)
      ? source.dependsOn.map((dependency) => (
        keyByRaw.get(String(dependency)) || slug(dependency)
      )).filter(Boolean)
      : [];
    const externalEffect = Boolean(source.externalEffect || source.external_effect);
    const role = externalEffect ? TASK_ROLES.REVIEWER : roleFor(source.role);
    const departmentId = slug(source.departmentId || source.deptId || source.department || 'product-engineering');
    const acceptance = Array.isArray(source.acceptance)
      ? source.acceptance.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
      : [];
    return {
      key: uniqueKey,
      title: String(source.title || source.name || `Tarea ${index + 1}`).trim().slice(0, 300),
      role,
      stage: role === TASK_ROLES.REVIEWER ? 'reduce' : role === TASK_ROLES.INTEGRATOR ? 'integrate' : 'work',
      priority: boundedInteger(source.priority, index, -1_000_000, 1_000_000),
      dependsOn: Array.from(new Set(dependsOn)),
      maxAttempts: boundedInteger(source.maxAttempts, 3, 1, 10),
      input: {
        departmentId,
        objective: String(source.objective || '').trim().slice(0, 4_000) || null,
        instruction: String(
          source.instruction || source.description || source.title || `Completa la tarea ${index + 1}`,
        ).trim().slice(0, 8_000),
        acceptance,
        externalEffect,
        agent: role === TASK_ROLES.REVIEWER ? 'qa_reviewer' : source.agent || null,
      },
    };
  });
}

function addQaCheckpoints(tasks, { every = DEFAULT_QA_EVERY } = {}) {
  const qaEvery = boundedInteger(every, DEFAULT_QA_EVERY, 1, 50);
  const output = [];
  let previousQa = null;
  let batch = [];
  let qaIndex = 0;

  for (const source of tasks) {
    const task = {
      ...source,
      dependsOn: Array.from(new Set(source.dependsOn || [])),
      input: { ...(source.input || {}) },
    };
    if ([TASK_ROLES.WRITER, TASK_ROLES.INTEGRATOR].includes(task.role)) {
      if (previousQa && !task.dependsOn.includes(previousQa)) task.dependsOn.push(previousQa);
      output.push(task);
      batch.push(task.key);
      if (batch.length >= qaEvery && task.role !== TASK_ROLES.INTEGRATOR) {
        qaIndex += 1;
        previousQa = `fleet-qa-${qaIndex}`;
        output.push({
          key: previousQa,
          title: `QA de flota ${qaIndex}`,
          role: TASK_ROLES.REVIEWER,
          stage: 'reduce',
          priority: task.priority + 1,
          dependsOn: [...batch],
          maxAttempts: 3,
          input: {
            agent: 'qa_reviewer',
            departmentId: 'trust-quality',
            instruction: 'Revisa el diff acumulado desde el último checkpoint de QA. Reporta fallos concretos, regresiones, seguridad y pruebas faltantes; los hallazgos deben convertirse en trabajo corregible.',
            acceptance: ['Pruebas relevantes en verde', 'Sin regresiones bloqueantes', 'Hallazgos con evidencia y rutas'],
          },
        });
        batch = [];
      }
    } else {
      output.push(task);
    }
  }
  if (batch.length) {
    qaIndex += 1;
    output.push({
      key: `fleet-qa-${qaIndex}`,
      title: `QA final de flota ${qaIndex}`,
      role: TASK_ROLES.REVIEWER,
      stage: 'reduce',
      priority: 1_000_000,
      dependsOn: [...batch],
      maxAttempts: 3,
      input: {
        agent: 'qa_reviewer',
        departmentId: 'trust-quality',
        instruction: 'Valida el resultado integrado, ejecuta la revisión final y devuelve hallazgos verificables. No inventes pruebas ni modifiques archivos.',
        acceptance: ['Resultado integrado revisado', 'Gates y riesgos documentados'],
      },
    });
  }
  return output;
}

function fallbackFleetTasks({ companyPlan, objective, logicalTasks }) {
  const legacy = buildEnterpriseSwarmTasks({
    plan: companyPlan,
    objective,
    logicalTasks,
  });
  return legacy.map((task) => {
    if (task.role === TASK_ROLES.INTEGRATOR) return task;
    if (task.input?.kind === 'draft') {
      return {
        ...task,
        role: TASK_ROLES.WRITER,
        stage: 'work',
        input: {
          ...task.input,
          departmentId: task.input.workstreamId || 'product-engineering',
          instruction: String(task.input.instruction || '').replace(
            /no modifiques archivos\.?/i,
            'implementa el entregable en el workspace y verifica los cambios.',
          ),
        },
      };
    }
    return task;
  });
}

async function planFleetTasks({
  objective,
  companyPlan,
  explicitTasks = null,
  planner = null,
  desiredTasks = DEFAULT_PLANNER_TASKS,
  qaEvery = DEFAULT_QA_EVERY,
  model = null,
} = {}) {
  const maxTasks = boundedInteger(desiredTasks, DEFAULT_PLANNER_TASKS, 1, MAX_PLANNER_TASKS);
  let rawTasks = explicitTasks;
  let source = explicitTasks ? 'explicit' : 'fallback';
  let plannerError = null;

  if (!rawTasks && typeof planner === 'function') {
    try {
      const completion = await planner({
        messages: [
          {
            role: 'system',
            content: [
              'Eres el planner de una flota de ingeniería. Devuelve SOLO JSON válido.',
              'Esquema: {"tasks":[{"id":"kebab","title":"...","description":"...","departmentId":"...","role":"writer|read-only|reviewer|integrator","dependsOn":[],"acceptance":["..."]}]}.',
              'Descompón en un DAG pequeño y ejecutable. Las tareas que cambian código usan role=writer. Investigación usa read-only. Efectos externos nunca son writer. Evita dos writers sobre el mismo archivo en el mismo nivel o explicita su dependencia.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              `Objetivo: ${String(objective || '').slice(0, 4_000)}`,
              `Número objetivo de tareas: ${maxTasks}`,
              `Plan empresarial disponible: ${JSON.stringify(companyPlan || {}).slice(0, 18_000)}`,
            ].join('\n'),
          },
        ],
        temperature: 0.2,
        maxTokens: 4_000,
        model,
      });
      const parsed = extractJson(completion?.content || completion?.text);
      rawTasks = parsed?.tasks;
      source = 'planner';
    } catch (error) {
      plannerError = String(error?.message || error).slice(0, 1_000);
    }
  }

  let normalized;
  try {
    normalized = normalizePlannerTasks(rawTasks, { maxTasks });
  } catch (error) {
    plannerError = plannerError || String(error?.message || error).slice(0, 1_000);
    normalized = fallbackFleetTasks({
      companyPlan,
      objective,
      logicalTasks: Math.max(maxTasks, 8),
    });
    source = 'fallback';
  }
  return {
    tasks: addQaCheckpoints(normalized, { every: qaEvery }),
    source,
    plannerError,
  };
}

function poolDepartmentId(departmentId) {
  return departmentId === 'trust-quality' ? 'trust' : departmentId;
}

function assignDepartmentPools(tasks, pools) {
  const byDepartment = new Map(
    (pools || []).map((pool) => [String(pool.departmentId), pool]),
  );
  const counts = new Map();
  for (const task of tasks) {
    const departmentId = poolDepartmentId(String(task?.input?.departmentId || ''));
    const pool = byDepartment.get(departmentId);
    if (pool?.enabled !== false) counts.set(pool.id, (counts.get(pool.id) || 0) + 1);
  }
  return tasks.map((task) => {
    const input = task?.input && typeof task.input === 'object' && !Array.isArray(task.input)
      ? task.input
      : {};
    const departmentId = poolDepartmentId(String(input.departmentId || ''));
    const pool = byDepartment.get(departmentId);
    if (!pool) return task;
    if (pool.enabled === false) {
      const error = new Error(`department_pool_disabled:${departmentId}`);
      error.code = 'department_pool_disabled';
      throw error;
    }
    const budget = pool.dailyBudgetUsd == null ? null : Number(pool.dailyBudgetUsd);
    const taskCount = Math.max(1, counts.get(pool.id) || 1);
    const reservation = budget != null && Number.isFinite(budget) && budget >= 0
      ? Math.floor((budget / taskCount) * 10_000) / 10_000
      : null;
    return {
      ...task,
      input: {
        ...input,
        departmentId,
        departmentPoolId: pool.id,
        ...(reservation == null ? {} : { poolBudgetReservationUsd: reservation }),
      },
    };
  });
}

async function createFleetSwarm({
  prisma,
  userId,
  project,
  objective,
  companyPlan,
  explicitTasks = null,
  planner = null,
  enqueue,
  logicalTasks = DEFAULT_PLANNER_TASKS,
  maxConcurrency = 16,
  maxConcurrentWriters = null,
  qaEvery = DEFAULT_QA_EVERY,
  model = null,
  tier = null,
  env = process.env,
} = {}) {
  const planned = await planFleetTasks({
    objective,
    companyPlan,
    explicitTasks,
    planner,
    desiredTasks: logicalTasks,
    qaEvery,
    model,
  });
  const runCap = configuredRunCap(project, env);
  const pools = await listDepartmentPools({ prisma, projectId: project.id });
  const plannedTasks = assignDepartmentPools(planned.tasks, pools);
  const writerCap = Math.min(
    maxConcurrency,
    runCap,
    boundedInteger(maxConcurrentWriters, runCap, 1, 128),
  );
  const orchestrator = new CodexSwarmOrchestrator({ prisma });
  const swarm = await orchestrator.createSwarm({
    userId,
    projectId: project.id,
    name: `Fleet · ${project.name}`.slice(0, 300),
    strategy: 'dag',
    tasks: plannedTasks,
    taskLimit: plannedTasks.length,
    maxConcurrency,
    maxConcurrentWriters: writerCap,
    metadata: {
      objective,
      model,
      tier,
      plannerSource: planned.source,
      plannerError: planned.plannerError,
      qaEvery,
      runCap,
      worktrees: true,
      departments: Array.from(new Set(
        plannedTasks.map((task) => task.input?.departmentId).filter(Boolean),
      )),
      safety: {
        isolatedWriterWorktrees: true,
        serializedBaseMerges: true,
        externalActionsReviewByDefault: true,
      },
    },
  });
  if (typeof enqueue === 'function') await enqueue({ swarmId: swarm.id });
  return { swarm, tasks: plannedTasks, planner: planned };
}

module.exports = {
  DEFAULT_PLANNER_TASKS,
  DEFAULT_QA_EVERY,
  MAX_PLANNER_TASKS,
  addQaCheckpoints,
  assignDepartmentPools,
  createFleetSwarm,
  extractJson,
  fallbackFleetTasks,
  normalizePlannerTasks,
  planFleetTasks,
};
