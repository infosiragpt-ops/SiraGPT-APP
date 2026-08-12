'use strict';

const {
  CodexSwarmOrchestrator,
  TASK_ROLES,
} = require('./swarm-orchestrator');
const { buildEnterpriseSwarmTasks } = require('./enterprise-swarm-plan');
const { configuredRunCap } = require('./run-service');
const departmentPools = require('./department-pools');
const usageLedger = require('./usage-ledger');
const { BUILT_IN_DEPARTMENTS, readDepartments } = require('./company-departments');
const { ensureFleetDepartmentPools } = require('./proactive-engine');

const { listDepartmentPools } = departmentPools;

const DEFAULT_PLANNER_TASKS = 64;
// Matches swarm-orchestrator / enterprise-swarm-plan logical capacity (10k).
const MAX_PLANNER_TASKS = 10_000;
const DEFAULT_QA_EVERY = 5;
const DEFAULT_DEPARTMENT_IDS = Object.freeze(
  BUILT_IN_DEPARTMENTS.map((department) => department.id),
);
const DEPARTMENT_ALIASES = Object.freeze({
  ceo: 'ceo-office',
  strategy: 'ceo-office',
  infrastructure: 'agent-infrastructure',
  'agent-infra': 'agent-infrastructure',
  engineering: 'product-engineering',
  product: 'product-engineering',
  software: 'product-engineering',
  'engineering-1': 'engineering-01',
  'engineering-2': 'engineering-02',
  qa: 'engineering-02',
  quality: 'engineering-02',
  research: 'market-intelligence',
  market: 'market-intelligence',
  support: 'customer-success',
  'customer-support': 'customer-success',
  growth: 'growth-engines',
  web: 'website-distribution',
  website: 'website-distribution',
  connectors: 'integrations',
  security: 'trust',
  compliance: 'trust',
  'trust-quality': 'trust',
});

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

function markFatalFleetPlannerError(error) {
  const out = error instanceof Error ? error : new Error(String(error || 'fleet_planner_failed'));
  out.fatalFleetPlanner = true;
  return out;
}

function createBudgetedFleetPlanner({
  planner,
  prisma,
  project,
  departmentId = 'ceo-office',
  env = process.env,
  budgetService = departmentPools,
  usageService = usageLedger,
} = {}) {
  if (typeof planner !== 'function') return planner;
  return async function budgetedFleetPlanner(args) {
    let budget;
    try {
      budget = await budgetService.requireOperationBudget({
        prisma,
        project,
        departmentId,
        env,
        now: new Date(),
      });
    } catch (error) {
      throw markFatalFleetPlannerError(error);
    }
    const callId = usageService.createUsageCallId();
    const completion = await planner(args);
    try {
      await usageService.recordCompletionUsage({
        prisma,
        projectId: project.id,
        departmentPoolId: budget?.pool?.id || null,
        source: 'fleet_planner',
        sourceId: `${project.id}:fleet-planner`,
        completion,
        callId,
        env,
      });
    } catch (error) {
      // Spending without durable accounting would bypass the company and pool
      // kill switches on the next launch. Fail closed instead of falling back
      // to an unaccounted swarm plan.
      throw markFatalFleetPlannerError(error);
    }
    return completion;
  };
}

function requireCompleteFleetDepartmentPools({ project, pools }) {
  const expected = readDepartments(project)
    .filter((department) => department && department.enabled !== false)
    .map((department) => department.id);
  const poolByDepartment = new Map(
    (Array.isArray(pools) ? pools : []).map((pool) => [String(pool.departmentId), pool]),
  );
  const missingDepartmentIds = expected.filter((departmentId) => !poolByDepartment.has(departmentId));
  const disabledDepartmentIds = expected.filter((departmentId) => (
    poolByDepartment.get(departmentId)?.enabled === false
  ));
  if (missingDepartmentIds.length || disabledDepartmentIds.length) {
    const error = new Error('fleet_department_pool_bootstrap_incomplete');
    error.code = 'fleet_department_pool_bootstrap_incomplete';
    error.status = 503;
    error.details = {
      missingDepartmentIds,
      disabledDepartmentIds,
    };
    throw error;
  }
  return expected;
}

async function reloadFleetProject({ prisma, project }) {
  if (!prisma?.codexProject?.findFirst || !project?.id || !project?.userId) {
    const error = new Error('fleet_project_store_unavailable');
    error.code = 'fleet_project_store_unavailable';
    error.status = 503;
    throw error;
  }
  const fresh = await prisma.codexProject.findFirst({
    where: {
      id: project.id,
      userId: project.userId,
      deletedAt: null,
    },
  });
  if (!fresh) {
    const error = new Error('codex_project_not_found');
    error.code = 'codex_project_not_found';
    error.status = 404;
    throw error;
  }
  return fresh;
}

function roleFor(value) {
  const role = String(value || TASK_ROLES.WRITER).trim().toLowerCase().replace(/_/g, '-');
  if (['reviewer', 'qa', 'qa-reviewer'].includes(role)) return TASK_ROLES.REVIEWER;
  if (['read-only', 'readonly', 'researcher', 'research'].includes(role)) return TASK_ROLES.READ_ONLY;
  if (role === TASK_ROLES.INTEGRATOR) return TASK_ROLES.INTEGRATOR;
  return TASK_ROLES.WRITER;
}

function orderedDepartmentIds(departmentIds = DEFAULT_DEPARTMENT_IDS) {
  const supplied = new Set(
    (Array.isArray(departmentIds) ? departmentIds : [])
      .map((departmentId) => slug(departmentId, ''))
      .filter(Boolean),
  );
  if (supplied.size === 0) return [...DEFAULT_DEPARTMENT_IDS];
  const ordered = DEFAULT_DEPARTMENT_IDS.filter((departmentId) => supplied.delete(departmentId));
  return [...ordered, ...Array.from(supplied).sort()];
}

function invalidDepartmentError(value) {
  const requested = slug(value, '') || 'missing';
  const error = new Error(`fleet_planner_department_invalid:${requested}`);
  error.code = 'fleet_planner_department_invalid';
  error.departmentId = requested === 'missing' ? null : requested;
  return error;
}

function normalizeDepartmentId(value, { departmentIds } = {}) {
  const allowed = orderedDepartmentIds(departmentIds);
  const requested = slug(value, '');
  if (requested && allowed.includes(requested)) return requested;
  const alias = DEPARTMENT_ALIASES[requested];
  if (alias && allowed.includes(alias)) return alias;
  throw invalidDepartmentError(requested);
}

function fallbackDepartmentRoute(value, {
  departmentIds = DEFAULT_DEPARTMENT_IDS,
  preferredDepartmentId = 'ceo-office',
  reason = 'department_unavailable',
} = {}) {
  const allowed = orderedDepartmentIds(departmentIds);
  const requested = slug(value, '');
  let departmentId = null;
  try {
    departmentId = normalizeDepartmentId(requested, { departmentIds: allowed });
  } catch {
    const preferred = slug(preferredDepartmentId, '');
    departmentId = allowed.includes(preferred) ? preferred : allowed[0];
  }
  return {
    departmentId,
    trace: {
      source: 'fleet-fallback',
      reason,
      requestedDepartmentId: requested || null,
      assignedDepartmentId: departmentId,
    },
  };
}

function normalizePlannerTasks(rawTasks, {
  maxTasks = MAX_PLANNER_TASKS,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
} = {}) {
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
    const requestedDepartmentId = source.departmentId || source.deptId || source.department;
    let departmentId;
    let departmentRouting = null;
    if (requestedDepartmentId) {
      departmentId = normalizeDepartmentId(requestedDepartmentId, { departmentIds });
      const requestedSlug = slug(requestedDepartmentId, '');
      if (departmentId !== requestedSlug) {
        departmentRouting = {
          source: 'explicit-alias',
          requestedDepartmentId: requestedSlug,
          assignedDepartmentId: departmentId,
        };
      }
    } else {
      const fallback = fallbackDepartmentRoute(null, {
        departmentIds,
        preferredDepartmentId: 'product-engineering',
        reason: 'department_missing',
      });
      departmentId = fallback.departmentId;
      departmentRouting = fallback.trace;
    }
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
        ...(departmentRouting ? { departmentRouting } : {}),
      },
    };
  });
}

function addQaCheckpoints(tasks, {
  every = DEFAULT_QA_EVERY,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
  taskLimit = MAX_PLANNER_TASKS,
} = {}) {
  const qaEvery = boundedInteger(every, DEFAULT_QA_EVERY, 1, 50);
  const totalTaskLimit = boundedInteger(taskLimit, MAX_PLANNER_TASKS, 1, MAX_PLANNER_TASKS);
  if (!Array.isArray(tasks) || tasks.length > totalTaskLimit) {
    const error = new Error('fleet_qa_task_budget_exceeded');
    error.code = 'fleet_qa_task_budget_exceeded';
    error.details = {
      baseTasks: Array.isArray(tasks) ? tasks.length : 0,
      totalTasks: Array.isArray(tasks) ? tasks.length : 0,
      taskLimit: totalTaskLimit,
    };
    throw error;
  }
  const qaRoute = fallbackDepartmentRoute('trust', {
    departmentIds,
    preferredDepartmentId: 'engineering-02',
    reason: 'qa_department_unavailable',
  });
  const qaDepartmentId = qaRoute.departmentId;
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
            departmentId: qaDepartmentId,
            ...(qaRoute.trace.requestedDepartmentId === qaDepartmentId
              ? {}
              : { departmentRouting: qaRoute.trace }),
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
        departmentId: qaDepartmentId,
        ...(qaRoute.trace.requestedDepartmentId === qaDepartmentId
          ? {}
          : { departmentRouting: qaRoute.trace }),
        instruction: 'Valida el resultado integrado, ejecuta la revisión final y devuelve hallazgos verificables. No inventes pruebas ni modifiques archivos.',
        acceptance: ['Resultado integrado revisado', 'Gates y riesgos documentados'],
      },
    });
  }
  if (output.length > totalTaskLimit) {
    const error = new Error('fleet_qa_task_budget_exceeded');
    error.code = 'fleet_qa_task_budget_exceeded';
    error.details = {
      baseTasks: tasks.length,
      qaTasks: output.length - tasks.length,
      totalTasks: output.length,
      taskLimit: totalTaskLimit,
    };
    throw error;
  }
  return output;
}

function fallbackFleetTasks({
  companyPlan,
  objective,
  logicalTasks,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
}) {
  const legacy = buildEnterpriseSwarmTasks({
    plan: companyPlan,
    objective,
    logicalTasks,
  });
  return legacy.map((task) => {
    const requestedDepartmentId = task.input?.departmentId || task.input?.workstreamId;
    const route = fallbackDepartmentRoute(requestedDepartmentId, {
      departmentIds,
      preferredDepartmentId: 'ceo-office',
      reason: 'planner_fallback',
    });
    const fallbackInput = {
      ...(task.input || {}),
      departmentId: route.departmentId,
      fallback: true,
      departmentRouting: route.trace,
    };
    if (task.role === TASK_ROLES.INTEGRATOR) {
      return {
        ...task,
        input: fallbackInput,
      };
    }
    if (task.input?.kind === 'draft') {
      return {
        ...task,
        role: TASK_ROLES.WRITER,
        stage: 'work',
        input: {
          ...fallbackInput,
          instruction: String(task.input.instruction || '').replace(
            /no modifiques archivos\.?/i,
            'implementa el entregable en el workspace y verifica los cambios.',
          ),
        },
      };
    }
    return {
      ...task,
      input: fallbackInput,
    };
  });
}

function addFallbackQaWithinBudget(tasks, options = {}) {
  const taskLimit = boundedInteger(
    options.taskLimit,
    MAX_PLANNER_TASKS,
    1,
    MAX_PLANNER_TASKS,
  );
  try {
    return addQaCheckpoints(tasks, { ...options, taskLimit });
  } catch (error) {
    if (error?.code !== 'fleet_qa_task_budget_exceeded') throw error;
    const excess = Math.max(1, Number(error.details?.totalTasks || tasks.length) - taskLimit);
    const removable = tasks
      .filter((task) => task.role === TASK_ROLES.READ_ONLY && /^parallel-audit-/.test(task.key))
      .slice(-excess);
    if (removable.length < excess) throw error;
    const removedKeys = new Set(removable.map((task) => task.key));
    const budgeted = tasks
      .filter((task) => !removedKeys.has(task.key))
      .map((task) => ({
        ...task,
        dependsOn: (task.dependsOn || []).filter((dependency) => !removedKeys.has(dependency)),
      }));
    return addQaCheckpoints(budgeted, { ...options, taskLimit });
  }
}

/**
 * When the LLM planner returns a small DAG but the CEO Office requested
 * hundreds/thousands of logical agents, pad with independent read-only
 * research shards so activation of 100–10_000 agents is real, not cosmetic.
 * Writers / integrators stay untouched; shards never write the workspace.
 */
function padFleetToLogicalCapacity(tasks, {
  objective,
  targetCount,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
} = {}) {
  const current = Array.isArray(tasks) ? tasks.slice() : [];
  const target = boundedInteger(targetCount, current.length, 1, MAX_PLANNER_TASKS);
  if (current.length >= target) return current;

  const used = new Set(current.map((task) => task.key));
  const normalizedObjective = String(objective || '').trim().slice(0, 4_000)
    || 'Cumplir el objetivo de la empresa de agentes.';
  const departments = orderedDepartmentIds(departmentIds);
  let shard = 0;
  while (current.length < target) {
    shard += 1;
    let key = `parallel-audit-${String(shard).padStart(4, '0')}`;
    while (used.has(key)) {
      shard += 1;
      key = `parallel-audit-${String(shard).padStart(4, '0')}`;
    }
    used.add(key);
    const perspective = [
      'arquitectura y límites de módulos',
      'correctitud funcional y casos borde',
      'experiencia de usuario y accesibilidad',
      'rendimiento de frontend y backend',
      'seguridad, permisos y secretos',
      'datos, migraciones e integridad',
      'observabilidad y recuperación de errores',
      'pruebas, fixtures y regresiones',
      'API, contratos e integraciones',
      'producto, conversión y propuesta de valor',
    ][(shard - 1) % 10];
    current.push({
      key,
      title: `Auditoría paralela: ${perspective}`,
      role: TASK_ROLES.READ_ONLY,
      stage: 'map',
      priority: 20,
      dependsOn: [],
      maxAttempts: 2,
      input: {
        agent: 'explorer',
        departmentId: departments[(shard - 1) % departments.length],
        objective: normalizedObjective,
        perspective,
        instruction: [
          `Analiza el workspace de forma independiente desde la perspectiva de ${perspective}.`,
          `Objetivo global: ${normalizedObjective}`,
          'Devuelve hallazgos priorizados, rutas o fuentes concretas, riesgos y recomendaciones. No modifiques archivos.',
        ].join('\n'),
        acceptance: ['Hallazgos con evidencia', 'Sin modificar archivos'],
      },
    });
  }
  return current;
}

function terminalTaskKeys(tasks) {
  const dependedOn = new Set(
    (Array.isArray(tasks) ? tasks : [])
      .flatMap((task) => (Array.isArray(task.dependsOn) ? task.dependsOn : [])),
  );
  return (Array.isArray(tasks) ? tasks : [])
    .map((task) => task.key)
    .filter((key) => key && !dependedOn.has(key));
}

function hierarchicalReducerCount(inputCount, fanIn) {
  let width = Math.max(0, Number(inputCount) || 0);
  if (width === 0) return 0;
  if (width === 1) return 1;
  let count = 0;
  while (width > 1) {
    width = Math.ceil(width / fanIn);
    count += width;
  }
  return count;
}

function addHierarchicalFleetVerdict(tasks, {
  objective,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
  fanIn = 50,
} = {}) {
  const output = Array.isArray(tasks) ? tasks.slice() : [];
  let frontier = terminalTaskKeys(output);
  if (!frontier.length) return output;
  const boundedFanIn = boundedInteger(fanIn, 50, 2, MAX_PLANNER_TASKS);
  const used = new Set(output.map((task) => task.key));
  const route = fallbackDepartmentRoute('trust', {
    departmentIds,
    preferredDepartmentId: 'engineering-02',
    reason: 'fleet_reduction_department_unavailable',
  });
  const normalizedObjective = String(objective || '').trim().slice(0, 4_000)
    || 'Emitir un veredicto verificable para la flota.';
  let level = 0;

  // Even one terminal node receives a final QA verdict so the graph never
  // ends in an unreviewed research shard or writer.
  do {
    level += 1;
    const next = [];
    for (let start = 0; start < frontier.length; start += boundedFanIn) {
      const dependencies = frontier.slice(start, start + boundedFanIn);
      let key = `fleet-reduce-${level}-${Math.floor(start / boundedFanIn) + 1}`;
      let suffix = 2;
      while (used.has(key)) {
        key = `fleet-reduce-${level}-${Math.floor(start / boundedFanIn) + 1}-${suffix}`;
        suffix += 1;
      }
      used.add(key);
      output.push({
        key,
        title: frontier.length <= boundedFanIn
          ? 'Veredicto final de la flota'
          : `Reducción jerárquica de evidencia · nivel ${level}`,
        role: TASK_ROLES.REVIEWER,
        stage: 'reduce',
        priority: 1_000_000 + level,
        dependsOn: dependencies,
        maxAttempts: 3,
        input: {
          agent: 'qa_reviewer',
          departmentId: route.departmentId,
          ...(route.trace.requestedDepartmentId === route.departmentId
            ? {}
            : { departmentRouting: route.trace }),
          objective: normalizedObjective,
          reductionLevel: level,
          instruction: dependencies.length === 1 && frontier.length === 1
            ? 'Emite el veredicto final verificable, confirma criterios, riesgos y pruebas a partir del resultado precedente.'
            : 'Reduce este lote de evidencias sin perder hallazgos, elimina duplicados y produce conclusiones trazables para el siguiente nivel de QA.',
          acceptance: ['Evidencia trazable', 'Riesgos priorizados', 'Veredicto verificable'],
        },
      });
      next.push(key);
    }
    frontier = next;
  } while (frontier.length > 1);

  return output;
}

function scaleFleetWithHierarchicalVerdict(tasks, {
  objective,
  targetCount,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
  fanIn = 50,
} = {}) {
  const base = Array.isArray(tasks) ? tasks.slice() : [];
  const target = boundedInteger(targetCount, base.length, 1, MAX_PLANNER_TASKS);
  if (base.length >= target) return base;
  const boundedFanIn = boundedInteger(fanIn, 50, 2, 100);
  const baseSinks = Math.max(1, terminalTaskKeys(base).length);
  let paddingCount = target - base.length;
  while (
    paddingCount > 0
    && base.length
      + paddingCount
      + hierarchicalReducerCount(baseSinks + paddingCount, boundedFanIn)
      > target
  ) {
    paddingCount -= 1;
  }

  let scaled = padFleetToLogicalCapacity(base, {
    objective,
    targetCount: base.length + paddingCount,
    departmentIds,
  });
  const reducerCount = hierarchicalReducerCount(
    Math.max(1, terminalTaskKeys(scaled).length),
    boundedFanIn,
  );
  // A planner can consume nearly the whole target with independent sinks. If
  // there is not enough room for a bounded tree, one final verdict still
  // connects every sink rather than leaving work orphaned.
  const effectiveFanIn = scaled.length + reducerCount <= target
    ? boundedFanIn
    : Math.max(2, terminalTaskKeys(scaled).length);
  scaled = addHierarchicalFleetVerdict(scaled, {
    objective,
    departmentIds,
    fanIn: effectiveFanIn,
  });

  // Fill rare arithmetic gaps with a serial final-verdict chain. Every added
  // node remains reviewed by the next and the last node is the sole sink.
  while (scaled.length < target) {
    const finalKey = terminalTaskKeys(scaled)[0];
    const extension = addHierarchicalFleetVerdict([
      ...scaled,
    ], {
      objective,
      departmentIds,
      fanIn: Math.max(2, terminalTaskKeys(scaled).length),
    });
    const added = extension.slice(scaled.length);
    if (!added.length) break;
    const next = added[0];
    next.key = `fleet-verdict-extension-${scaled.length + 1}`;
    next.dependsOn = [finalKey];
    next.title = 'Verificación final complementaria de la flota';
    scaled.push(next);
  }
  if (scaled.length !== target) {
    const error = new Error('fleet_reduction_task_budget_mismatch');
    error.code = 'fleet_reduction_task_budget_mismatch';
    error.details = { totalTasks: scaled.length, taskLimit: target };
    throw error;
  }
  return scaled;
}

async function planFleetTasks({
  objective,
  companyPlan,
  explicitTasks = null,
  planner = null,
  desiredTasks = DEFAULT_PLANNER_TASKS,
  qaEvery = DEFAULT_QA_EVERY,
  model = null,
  departmentIds = DEFAULT_DEPARTMENT_IDS,
} = {}) {
  const maxTasks = boundedInteger(desiredTasks, DEFAULT_PLANNER_TASKS, 1, MAX_PLANNER_TASKS);
  const allowedDepartments = orderedDepartmentIds(departmentIds);
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
              `departmentId debe ser uno de: ${allowedDepartments.join(', ')}.`,
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
      if (error?.fatalFleetPlanner === true) throw error;
      plannerError = String(error?.message || error).slice(0, 1_000);
    }
  }

  let normalized;
  try {
    normalized = normalizePlannerTasks(rawTasks, {
      maxTasks,
      departmentIds: allowedDepartments,
    });
  } catch (error) {
    plannerError = plannerError || String(error?.message || error).slice(0, 1_000);
    normalized = fallbackFleetTasks({
      companyPlan,
      objective,
      logicalTasks: Math.max(maxTasks, 8),
      departmentIds: allowedDepartments,
    });
    source = 'fallback';
  }
  // QA consumes the same hard 10k task budget as every other logical agent.
  // Add checkpoints before scale padding so read-only shards fill only the
  // capacity that remains; never produce 10k base tasks plus extra QA tasks.
  let tasksWithQa = source === 'fallback'
    ? addFallbackQaWithinBudget(normalized, {
      every: qaEvery,
      departmentIds: allowedDepartments,
      taskLimit: MAX_PLANNER_TASKS,
    })
    : addQaCheckpoints(normalized, {
      every: qaEvery,
      departmentIds: allowedDepartments,
      taskLimit: MAX_PLANNER_TASKS,
    });
  // Scale logical agents honestly: planner DAGs are small; pad research capacity
  // so "activar 100 / 10_000 agentes" actually queues that many tasks. Every
  // padded shard is then reduced through bounded QA layers to one final verdict.
  if (source !== 'fallback' && tasksWithQa.length < maxTasks) {
    tasksWithQa = scaleFleetWithHierarchicalVerdict(tasksWithQa, {
      objective,
      targetCount: maxTasks,
      departmentIds: allowedDepartments,
    });
    source = source === 'planner' ? 'planner+scale' : source;
  }
  return {
    tasks: tasksWithQa,
    source,
    plannerError,
  };
}

function assignDepartmentPools(tasks, pools) {
  const byDepartment = new Map(
    (pools || []).map((pool) => [String(pool.departmentId), pool]),
  );
  const counts = new Map();
  for (const task of tasks) {
    const departmentId = String(task?.input?.departmentId || '');
    const pool = byDepartment.get(departmentId);
    // `pool?.enabled !== false` once passed for MISSING pools too (undefined !==
    // false) and then crashed on pool.id. A completely fresh project remains a
    // supported no-pool case; when pools exist, the mapper below treats them as
    // authoritative and fails closed on any unmatched department.
    if (pool && pool.enabled !== false) counts.set(pool.id, (counts.get(pool.id) || 0) + 1);
  }
  return tasks.map((task) => {
    const input = task?.input && typeof task.input === 'object' && !Array.isArray(task.input)
      ? task.input
      : {};
    const departmentId = String(input.departmentId || '');
    const pool = byDepartment.get(departmentId);
    if (!pool) {
      // A non-empty pool list is the runtime's routing authority. Never let an
      // LLM-invented department bypass capacity/budget accounting.
      if (byDepartment.size > 0) {
        const error = new Error(`department_pool_unavailable:${departmentId || 'missing'}`);
        error.code = 'department_pool_unavailable';
        throw error;
      }
      return task;
    }
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
  maxConcurrency = 64,
  maxConcurrentWriters = null,
  qaEvery = DEFAULT_QA_EVERY,
  model = null,
  tier = null,
  env = process.env,
} = {}) {
  // A fresh project has no durable pool rows yet, but the fleet planner is a
  // CEO Office operation and its fail-closed budget preflight requires a real
  // pool for attribution. Bootstrap the existing company departments first;
  // the helper uses the unique (projectId, departmentId) upsert and is safe to
  // replay after a timeout or concurrent launch. This only creates capacity —
  // requireOperationBudget below still decides whether provider spend is
  // allowed (including an explicit zero company/pool budget).
  await ensureFleetDepartmentPools({ prisma, project });
  // Pool provisioning mutates the project capacity and an operator may change
  // the company budget while those durable writes run. Never authorize the
  // provider with the stale route snapshot.
  const freshProject = await reloadFleetProject({ prisma, project });
  const pools = await listDepartmentPools({ prisma, projectId: freshProject.id });
  // The proactive bootstrap is intentionally best-effort for a background
  // ticker. A user-requested launch cannot inherit that tolerance: verify the
  // durable rows after all upserts and abort before the planner if even one
  // enabled company department lacks usable capacity.
  const departmentIds = requireCompleteFleetDepartmentPools({ project: freshProject, pools });
  const planned = await planFleetTasks({
    objective,
    companyPlan,
    explicitTasks,
    planner: createBudgetedFleetPlanner({
      planner,
      prisma,
      project: freshProject,
      env,
    }),
    desiredTasks: logicalTasks,
    qaEvery,
    model,
    departmentIds,
  });
  const runCap = configuredRunCap(freshProject, env);
  const plannedTasks = assignDepartmentPools(planned.tasks, pools);
  const writerCap = Math.min(
    maxConcurrency,
    runCap,
    boundedInteger(maxConcurrentWriters, runCap, 1, 32),
  );
  const orchestrator = new CodexSwarmOrchestrator({ prisma });
  const swarm = await orchestrator.createSwarm({
    userId,
    projectId: freshProject.id,
    name: `Fleet · ${freshProject.name}`.slice(0, 300),
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
  DEFAULT_DEPARTMENT_IDS,
  MAX_PLANNER_TASKS,
  padFleetToLogicalCapacity,
  addQaCheckpoints,
  assignDepartmentPools,
  createFleetSwarm,
  createBudgetedFleetPlanner,
  extractJson,
  fallbackFleetTasks,
  normalizePlannerTasks,
  normalizeDepartmentId,
  orderedDepartmentIds,
  planFleetTasks,
  requireCompleteFleetDepartmentPools,
  scaleFleetWithHierarchicalVerdict,
  terminalTaskKeys,
};
