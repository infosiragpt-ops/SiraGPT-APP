'use strict';

/**
 * proactive-engine — modo PROACTIVO del panel de compañía de agentes (/code).
 *
 * matrix.build-style autonomy: while a project has proactive mode enabled,
 * its agent departments propose and execute work on their own. Two-phase,
 * riding the EXISTING run machinery (no run-service changes):
 *
 *   tick N:   department proposes the next most valuable task (LLM ladder)
 *             → createRun(mode 'plan', prompt '[PROACTIVO · <dept>] …')
 *   tick N+1: that plan reached waiting_approval → the engine auto-approves
 *             ONLY ITS OWN plans (the [PROACTIVO prefix) by creating the
 *             build run — a human's waiting plan is never touched.
 *
 * State lives in CodexProject.brief.proactive (Json column — no migration):
 *   { enabled, enabledAt, dayKey, runsToday, deptIndex, lastCycleAt, lastError,
 *     costTodayUsd, dailyBudgetUsd, budgetBlocked }
 *
 * Safety rails:
 *   - Per-project daily proposal cap (CODEX_PROACTIVE_MAX_PER_DAY, default 48)
 *     and USD kill switch (CODEX_PROACTIVE_DAILY_BUDGET_USD, default 25).
 *   - Single-active-run gate for code builds; operational depts still rotate.
 *   - Departments rotate round-robin so one mandate can't monopolize.
 *   - On enable: every department is activated (enabled=true) for permanent fleet work.
 *   - Proactive plan/build runs always set autoExecute for multi-hour continuity
 *     (OpenClaw-style durable autonomous work).
 *   - Ticker default-on ONLY in production; explicit CODEX_PROACTIVE_ENABLED
 *     overrides both ways ('1' forces on, '0' forces off). Default tick 2 min.
 *   - All external effects (prisma, run-service, LLM, runner) are injectable.
 */

const PROACTIVE_PREFIX = '[PROACTIVO';
const progressLedger = require('./progress-ledger');
const proactiveMetrics = require('./proactive-metrics');
const companyOperatingProfile = require('./company-operating-profile');
const companyMissionOrchestrator = require('./company-mission-orchestrator');
const companyDepartments = require('./company-departments');
const departmentPools = require('./department-pools');
const companyResources = require('./company-resources');
const businessAnalyzer = require('./business-analyzer');
const proactiveLease = require('./proactive-lease');
const projectBudget = require('./project-budget');
const { mutateProjectBrief } = require('./project-brief-store');

/** Backend mirror of lib/code-agent-company.ts AGENT_COMPANY_DEPARTMENTS. */
const DEPARTMENTS = companyDepartments.BUILT_IN_DEPARTMENTS;
const DIRECT_OPERATION_DEPARTMENTS = new Set(['sales', 'customer-success', 'marketing']);

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function businessAnalyzerEnabled(env = process.env) {
  if (env.CODEX_BUSINESS_ANALYZER_ENABLED === '1') return true;
  if (env.CODEX_BUSINESS_ANALYZER_ENABLED === '0') return false;
  return env.NODE_ENV === 'production';
}

function readProactiveState(project) {
  const brief = project && typeof project.brief === 'object' && project.brief !== null ? project.brief : {};
  const p = typeof brief.proactive === 'object' && brief.proactive !== null ? brief.proactive : {};
  return {
    enabled: p.enabled === true,
    enabledAt: p.enabledAt || null,
    dayKey: typeof p.dayKey === 'string' ? p.dayKey : null,
    runsToday: Number.isFinite(Number(p.runsToday)) ? Number(p.runsToday) : 0,
    deptIndex: Number.isFinite(Number(p.deptIndex)) ? Number(p.deptIndex) : 0,
    lastCycleAt: p.lastCycleAt || null,
    lastError: p.lastError || null,
    costTodayUsd: Math.max(0, Number(p.costTodayUsd) || 0),
    dailyBudgetUsd: p.dailyBudgetUsd == null || !Number.isFinite(Number(p.dailyBudgetUsd))
      ? null
      : Math.max(0, Number(p.dailyBudgetUsd)),
    configuredDailyBudgetUsd: p.configuredDailyBudgetUsd == null
      || !Number.isFinite(Number(p.configuredDailyBudgetUsd))
      ? null
      : Math.max(0, Number(p.configuredDailyBudgetUsd)),
    budgetBlocked: p.budgetBlocked === true,
    lastDepartment: typeof p.lastDepartment === 'string' ? p.lastDepartment : null,
    missionIndex: Number.isFinite(Number(p.missionIndex)) ? Number(p.missionIndex) : 0,
    lastMissionId: typeof p.lastMissionId === 'string' ? p.lastMissionId : null,
  };
}

async function writeProactiveState({ prisma, project, patch }) {
  let next = null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief, fresh) => {
      const current = readProactiveState({ ...fresh, brief });
      next = { ...current, ...patch };
      return { ...brief, proactive: next };
    },
  });
  return next;
}

/**
 * Ensure every enabled department has a physical pool seat so the office and
 * fleet show real capacity (not 0/0 puestos) and writers can claim isolation.
 * Caps per-department size to keep total under department-pools project max.
 */
async function ensureFleetDepartmentPools({ prisma, project }) {
  const departments = companyDepartments.readDepartments(project)
    .filter((department) => department && department.enabled !== false);
  if (!departments.length) return [];
  const existing = await departmentPools.listDepartmentPools({
    prisma,
    projectId: project.id,
  });
  const byId = new Map(existing.map((pool) => [pool.departmentId, pool]));
  const maxProject = departmentPools.MAX_PROJECT_POOL_CAPACITY || 512;
  // Reserve at least 1 seat per department; distribute remaining capacity by desiredAgents.
  const logicalTotal = departments.reduce(
    (sum, department) => sum + Math.max(1, Number(department.desiredAgents) || 1),
    0,
  );
  const created = [];
  for (const department of departments) {
    if (byId.has(department.id)) continue;
    const desired = Math.max(1, Number(department.desiredAgents) || 1);
    // Proportional share of project capacity, min 1, max 32 for first bootstrap.
    const share = logicalTotal > 0
      ? Math.max(1, Math.round((desired / logicalTotal) * Math.min(maxProject, logicalTotal)))
      : 1;
    const size = Math.min(32, Math.max(1, share));
    try {
      const pool = await departmentPools.upsertDepartmentPool({
        prisma,
        project,
        departmentId: department.id,
        size,
        enabled: true,
      });
      if (pool) created.push(pool);
    } catch (err) {
      console.warn(
        `[codex proactive] pool bootstrap failed for ${department.id}:`,
        err?.message || err,
      );
    }
  }
  return created;
}

async function setProactive({ prisma, projectId, userId, enabled, now = () => new Date() }) {
  let project = await prisma.codexProject.findFirst({ where: { id: projectId, userId } });
  if (!project) return null;
  // Permanent fleet: when PROACTIVO turns on, unhide every built-in department
  // and re-enable custom units so the whole company participates in the loop.
  if (enabled) {
    try {
      await require('./project-brief-store').mutateProjectBrief({
        prisma,
        projectId: project.id,
        userId: project.userId,
        mutate: (brief) => {
          const custom = Array.isArray(brief.companyDepartments)
            ? brief.companyDepartments.map((row) => (
              row && typeof row === 'object' ? { ...row, enabled: true } : row
            ))
            : brief.companyDepartments;
          return {
            ...brief,
            companyDepartmentHidden: [],
            companyDepartments: custom,
          };
        },
      });
      project = await prisma.codexProject.findFirst({ where: { id: projectId, userId } }) || project;
    } catch (err) {
      console.warn('[codex proactive] enable-all-departments failed:', err?.message || err);
    }
    try {
      await ensureFleetDepartmentPools({ prisma, project });
      project = await prisma.codexProject.findFirst({ where: { id: projectId, userId } }) || project;
    } catch (err) {
      console.warn('[codex proactive] ensure fleet pools failed:', err?.message || err);
    }
  }
  const state = await writeProactiveState({
    prisma,
    project,
    patch: enabled
      ? {
        enabled: true,
        enabledAt: now().toISOString(),
        lastError: null,
        budgetBlocked: false,
        // OpenClaw-style continuous heartbeat metadata
        fleetMode: 'all-departments',
        continuity: 'permanent-until-paused',
      }
      : { enabled: false, fleetMode: null, continuity: null },
  });
  return { projectId, state };
}

function maxPerDay(env = process.env) {
  const n = Number.parseInt(env.CODEX_PROACTIVE_MAX_PER_DAY ?? '', 10);
  // Continuous professional company mode: many department cycles per day.
  return Number.isFinite(n) && n >= 0 ? n : 48;
}

function dailyBudgetUsd(env = process.env) {
  return projectBudget.configuredCompanyBudgetUsd(null, env);
}

function projectDailyBudgetUsd(project, env = process.env) {
  return projectBudget.configuredCompanyBudgetUsd(project, env);
}

function qaEveryCycles(env = process.env) {
  const value = Number.parseInt(env.CODEX_PROACTIVE_QA_EVERY_CYCLES ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 5;
}

async function costTodayUsd({ prisma, projectId, now = new Date() }) {
  return projectBudget.costTodayUsd({ prisma, projectId, now });
}

async function checkDailyBudget({
  prisma,
  project,
  env = process.env,
  now = new Date(),
  budgetService = projectBudget,
}) {
  return budgetService.checkCompanyDailyBudget({
    prisma,
    project,
    env,
    now,
  });
}

function budgetBlockedMessage(status) {
  if (status.reason === 'daily_budget_exceeded') {
    return `Presupuesto proactivo diario alcanzado: $${Number(status.costTodayUsd || 0).toFixed(4)} de $${Number(status.dailyBudgetUsd || 0).toFixed(2)}.`;
  }
  return `No se pudo verificar de forma segura el presupuesto proactivo diario: ${status.error || status.reason}.`;
}

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function resourcesAssignedToDepartment(project, departmentId, assignments = null) {
  const source = assignments || companyResources.readCompanyResources(project).assignments;
  return Object.entries(source)
    .filter(([, ownerDepartmentId]) => ownerDepartmentId === departmentId)
    .map(([resourceKey]) => resourceKey)
    .sort();
}

function autoMarketingTask(result = {}) {
  if (result.action === 'drafted_review') return 'Contenido preparado como borrador para revisión humana.';
  if (result.action === 'scheduled_auto') return 'Contenido programado bajo política auto explícitamente habilitada.';
  if (result.action === 'already_generated') return 'Contenido diario ya generado; idempotencia conservada.';
  return `Sin efecto externo: ${result.action || 'política no disponible'}.`;
}

async function finishOperationalCycle({
  prisma,
  project,
  state,
  today,
  now,
  spentUsd,
  budgetUsd,
  departments,
  department,
  runId,
  outcome,
  task,
  evidence,
  learnings,
}) {
  await progressLedger.appendLedgerEntry({
    prisma,
    project,
    entry: {
      department: department.name,
      runId,
      outcome,
      task,
      diffstat: { additions: 0, deletions: 0, filesChanged: 0 },
      acceptance: [{
        criterion: 'La operación queda respaldada por registros reales y respeta la política de autonomía.',
        passed: outcome === 'passed',
        evidence,
      }],
      learnings,
      createdAt: now().toISOString(),
    },
  });
  await writeProactiveState({
    prisma,
    project,
    patch: {
      dayKey: today,
      runsToday: (state.dayKey === today ? state.runsToday : 0) + 1,
      deptIndex: (state.deptIndex + 1) % departments.length,
      lastCycleAt: now().toISOString(),
      lastError: outcome === 'passed' ? null : task,
      costTodayUsd: spentUsd,
      dailyBudgetUsd: budgetUsd,
      budgetBlocked: false,
      lastDepartment: department.id,
    },
  });
}

/** LLM proposal: the department's next most valuable task for this project. */
async function proposeTask({
  project,
  department,
  recentRuns,
  fileTree,
  notes,
  ledger = [],
  objectives = [],
  companyContext = null,
  mission = null,
  qaCycle = false,
  chatComplete,
}) {
  const assignedResources = resourcesAssignedToDepartment(project, department.id);
  const openFailures = progressLedger.readOpenFailures(ledger);
  const responseSchema = department.id === 'ceo-office'
    ? '{"title":"<3-8 palabras>","goal":"<instrucción concreta y autosuficiente, 1-3 frases>","acceptanceCriteria":["<resultado observable>"],"objectiveIds":["<id>"],"swarm":[{"agent":"explorer|planner|qa_reviewer|enterprise_analyst|market_researcher|sales_strategist|customer_success","task":"<investigación concreta de solo lectura>"}],"objectives":[{"id":"...","title":"...","ownerDepartmentId":"...","status":"active|at_risk|done|paused","priority":1,"keyResults":[{"id":"...","title":"...","metric":"...","baseline":"...","current":"...","target":"...","unit":"...","status":"not_started|on_track|at_risk|achieved","progress":0}]}],"companyProfile":{"stage":"new|existing|growing|unknown","mission":"... o null","vision":"... o null","offer":"... o null","targetCustomer":"... o null","businessModel":"... o null","industry":"... o null","market":"... o null","brandVoice":"... o null","websiteUrl":"... o null","salesProcess":"... o null"}}'
    : '{"title":"<3-8 palabras>","goal":"<instrucción concreta y autosuficiente, 1-3 frases>","acceptanceCriteria":["<resultado observable>"],"objectiveIds":["<id>"],"swarm":[{"agent":"explorer|planner|qa_reviewer|enterprise_analyst|market_researcher|sales_strategist|customer_success","task":"<investigación concreta de solo lectura>"}],"objectives":[]}';
  const messages = [
    {
      role: 'system',
      content: [
        'Eres el director del departamento indicado dentro de una compañía de agentes de software autónomos.',
        'Tu trabajo: proponer LA SIGUIENTE tarea más valiosa (una sola, concreta, completable por un agente de código en una sesión) para este proyecto.',
        `Responde SOLO JSON: ${responseSchema}.`,
        'La tarea debe ser INCREMENTAL sobre lo ya construido (no re-hacer lo existente), y del ámbito del departamento.',
        'Incluye entre 2 y 5 criterios de aceptación observables. No uses criterios vagos como "que se vea bien".',
        'Para swarm elige de 2 a 6 especialistas de solo lectura con tareas distintas que puedan ejecutarse en paralelo antes de escribir. Usa market_researcher/sales_strategist/customer_success solo cuando el objetivo empresarial lo requiera.',
        department.id === 'ceo-office'
          ? 'Como CEO Office, revisa y re-prioriza objectives con un máximo de 5 OKR medibles. Cada OKR debe tener de 1 a 5 keyResults observables; conserva ids estables para objetivos y KR vigentes, actualiza current/progress solo con evidencia y no conviertas hipótesis en resultados. Actualiza companyProfile solo con hechos sostenidos por el contexto; usa null cuando un dato del negocio no esté confirmado.'
          : 'Para objectives devuelve [] y enlaza la tarea a los objectiveIds vigentes que corresponda.',
        qaCycle
          ? 'Esta es una auditoría acumulada: el constructor DEBE delegar primero en qa_reviewer, revisar el diff y añadir o mejorar smoke tests antes de corregir hallazgos.'
          : null,
        'Para tareas amplias diseña unidades lógicas independientes y delega análisis de solo lectura en paralelo con run_subagent. Las escrituras se integran de forma serial por archivo y terminan en una sola verificación global.',
        'La respuesta final de CEO Office debe ser ejecutiva: resultado, evidencia, riesgos y siguiente paso; el detalle queda en el timeline, los archivos y las pruebas.',
        'Nunca incluyas secretos. No publiques en redes ni actives gasto desde una tarea de código; prepara el trabajo y usa los controles explícitos de Recursos para efectos externos.',
      ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: [
        `Proyecto: ${project.name || project.id}`,
        project.brief && project.brief.goal ? `Objetivo del proyecto: ${String(project.brief.goal).slice(0, 500)}` : null,
        `Departamento: ${department.name} — ${department.mission}`,
        assignedResources.length
          ? `Recursos asignados a este departamento (no asumas acceso a otros):\n${assignedResources.map((resourceKey) => `- ${resourceKey}`).join('\n')}`
          : null,
        companyContext ? `Contexto operativo compartido:\n${companyOperatingProfile.formatCompanyContext(companyContext)}` : null,
        mission ? companyMissionOrchestrator.formatMissionContext(mission) : null,
        fileTree ? `Archivos del workspace:\n${String(fileTree).slice(0, 1800)}` : 'Workspace aún vacío (proyecto nuevo).',
        notes ? `Notas del proyecto (.sira/notes.md):\n${String(notes).slice(0, 1200)}` : null,
        objectives.length
          ? `OKR vigentes:\n${objectives.map((item) => {
            const keyResults = Array.isArray(item.keyResults)
              ? item.keyResults.map((kr) => `  - ${kr.id} [${kr.status}${kr.progress == null ? '' : `, ${kr.progress}%`}] ${kr.title}${kr.target ? ` · meta ${kr.target}` : ''}`).join('\n')
              : '';
            return `- ${item.id} [P${item.priority}, ${item.status}] ${item.title}${item.metric ? ` · ${item.metric}: ${item.target || 'sin meta'}` : ''}${keyResults ? `\n${keyResults}` : ''}`;
          }).join('\n')}`
          : 'Aún no hay OKR estructurados.',
        ledger.length
          ? `Progress Ledger (resultados acumulados, no repitas fallos ni trabajo):\n${ledger.slice(-12).map((item) => {
            const diff = `+${Math.max(0, Number(item.diffstat?.additions) || 0)}/-${Math.max(0, Number(item.diffstat?.deletions) || 0)}`;
            const learning = item.learnings?.[0] ? ` · ${item.learnings[0]}` : '';
            return `- [${item.outcome}] ${item.department} · ${diff} · ${item.task || item.runId}${learning}`;
          }).join('\n')}`
          : 'Progress Ledger vacío: esta será una de las primeras decisiones.',
        openFailures.length
          ? `FALLOS ABIERTOS DEL LEDGER (no propongas de nuevo el mismo título/tarea; elige otro avance o una remediación explícitamente distinta):\n${openFailures.slice(-12).map((item) => {
            const learning = item.learnings[0] ? ` · evidencia: ${item.learnings[0]}` : '';
            return `- failureKey=${item.failureKey} · run=${item.runId} · ${item.title || item.task || 'tarea sin título'}${learning}`;
          }).join('\n')}`
          : 'Sin fallos abiertos en el ledger.',
        recentRuns && recentRuns.length
          ? `Últimos trabajos (no los repitas):\n${recentRuns.map((r) => `- [${r.status}] ${String(r.prompt || '').slice(0, 140)}`).join('\n')}`
          : 'Sin trabajos previos.',
      ].filter(Boolean).join('\n\n'),
    },
  ];
  const completionOptions = {
    temperature: 0.5,
    maxTokens: department.id === 'ceo-office' ? 1_000 : 450,
  };
  let out = await chatComplete({ messages, ...completionOptions });
  let parsed = extractJson(out && out.content);
  let repeatedFailure = parsed?.title
    ? progressLedger.findOpenFailure(ledger, parsed.title)
    : null;
  if (repeatedFailure) {
    messages.push({
      role: 'assistant',
      content: String(out?.content || '').slice(0, 4000),
    });
    messages.push({
      role: 'user',
      content: [
        `PROPUESTA RECHAZADA: repite el fallo abierto ${repeatedFailure.failureKey} del run ${repeatedFailure.runId}.`,
        'Propón una tarea diferente. Si debes perseguir el mismo objetivo, cambia explícitamente el enfoque usando la evidencia del fallo y asigna un título que describa la remediación concreta.',
      ].join(' '),
    });
    out = await chatComplete({ messages, ...completionOptions });
    parsed = extractJson(out && out.content);
    repeatedFailure = parsed?.title
      ? progressLedger.findOpenFailure(ledger, parsed.title)
      : null;
    if (repeatedFailure) return null;
  }
  if (!parsed || !parsed.goal || typeof parsed.goal !== 'string') return null;
  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : 'Tarea proactiva';
  const acceptanceCriteria = progressLedger.normalizeAcceptanceCriteria(parsed.acceptanceCriteria);
  const defaults = [
    'La funcionalidad solicitada queda disponible y comprobable en la aplicación.',
    'El proyecto compila sin errores y los smoke tests aplicables pasan.',
    'La vista previa renderiza contenido sin excepciones ni requests fallidos.',
  ];
  return {
    title: title.slice(0, 90),
    goal: parsed.goal.trim().slice(0, 1200),
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : defaults,
    objectiveIds: Array.isArray(parsed.objectiveIds)
      ? parsed.objectiveIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 12)
      : objectives.filter((item) => item.status === 'active').slice(0, 3).map((item) => item.id),
    objectives: department.id === 'ceo-office'
      ? progressLedger.normalizeObjectives(parsed.objectives)
      : [],
    companyProfile: department.id === 'ceo-office' && parsed.companyProfile && typeof parsed.companyProfile === 'object'
      ? parsed.companyProfile
      : null,
    swarm: progressLedger.normalizeSwarm(parsed.swarm),
  };
}

/**
 * One proactive cycle for one project. Returns a { action } tag for tests/logs:
 *   'approved_plan' | 'proposed' | 'skipped_active' | 'skipped_budget' |
 *   'skipped_no_proposal' | 'disabled'
 */
async function runCycleInternal({ project, deps = {}, env = process.env, now = () => new Date() }) {
  const prisma = deps.prisma;
  const state = readProactiveState(project);
  if (!state.enabled) return { action: 'disabled' };
  const runService = deps.runService || require('./run-service');

  const today = dayKey(now());
  const runsToday = state.dayKey === today ? state.runsToday : 0;
  const budget = await checkDailyBudget({
    prisma,
    project,
    env,
    now: now(),
    budgetService: deps.projectBudget || projectBudget,
  });
  const budgetUsd = budget.dailyBudgetUsd;
  const spentUsd = budget.costTodayUsd;
  const budgetBlocked = !budget.allowed;
  proactiveMetrics.setBudgetBlocked(budgetBlocked);

  // Newest active run decides the phase.
  const active = await prisma.codexRun.findFirst({
    where: { projectId: project.id, status: { in: ['queued', 'running', 'waiting_approval'] } },
    orderBy: { createdAt: 'desc' },
  });

  if (active) {
    const isOwnPlan = active.mode === 'plan'
      && active.status === 'waiting_approval'
      && String(active.prompt || '').startsWith(PROACTIVE_PREFIX);
    if (!isOwnPlan) return { action: 'skipped_active' };
    const activeDepartmentId = progressLedger.taskMetaFromPrompt(active.prompt)?.departmentId;
    const activePoolBudget = activeDepartmentId
      ? await (deps.departmentPools || departmentPools).checkDepartmentPoolBudget({
        prisma,
        projectId: project.id,
        departmentId: activeDepartmentId,
        env,
        now: now(),
      })
      : { allowed: true };
    if (!activePoolBudget.allowed) {
      const message = activePoolBudget.reason === 'pool_disabled'
        ? `El pool ${activeDepartmentId} está pausado.`
        : `El pool ${activeDepartmentId} alcanzó su presupuesto diario.`;
      await writeProactiveState({
        prisma,
        project,
        patch: {
          lastCycleAt: now().toISOString(),
          lastError: message,
          costTodayUsd: spentUsd,
          dailyBudgetUsd: budgetUsd,
          budgetBlocked: false,
        },
      });
      return {
        action: activePoolBudget.reason === 'pool_disabled'
          ? 'skipped_department_pool'
          : 'skipped_department_budget',
        department: activeDepartmentId,
        poolBudget: activePoolBudget,
      };
    }
    if (budgetBlocked) {
      const message = budgetBlockedMessage(budget);
      await writeProactiveState({
        prisma,
        project,
        patch: {
          dayKey: today,
          costTodayUsd: spentUsd,
          dailyBudgetUsd: budgetUsd,
          budgetBlocked: true,
          lastCycleAt: now().toISOString(),
          lastError: message,
        },
      });
      return {
        action: 'skipped_cost_budget',
        reason: budget.reason,
        costTodayUsd: spentUsd,
        dailyBudgetUsd: budgetUsd,
      };
    }
    // Phase 2 — auto-approve OUR OWN plan by creating its build run.
    const run = await runService.createRun({
      userId: project.userId,
      projectId: project.id,
      mode: 'build',
      prompt: active.prompt,
      planRunId: active.id,
      // Durable multi-hour continuation even if the browser tab closes.
      autoExecute: true,
      db: prisma,
    });
    await writeProactiveState({
      prisma,
      project,
      patch: {
        lastCycleAt: now().toISOString(),
        lastError: null,
        costTodayUsd: spentUsd,
        dailyBudgetUsd: budgetUsd,
        budgetBlocked: false,
      },
    });
    return { action: 'approved_plan', runId: run && run.id, planRunId: active.id };
  }

  if (budgetBlocked) {
    const message = budgetBlockedMessage(budget);
    await writeProactiveState({
      prisma,
      project,
      patch: {
        dayKey: today,
        costTodayUsd: spentUsd,
        dailyBudgetUsd: budgetUsd,
        budgetBlocked: true,
        lastCycleAt: now().toISOString(),
        lastError: message,
      },
    });
    return {
      action: 'skipped_cost_budget',
      reason: budget.reason,
      costTodayUsd: spentUsd,
      dailyBudgetUsd: budgetUsd,
    };
  }
  if (maxPerDay(env) === 0 || runsToday >= maxPerDay(env)) return { action: 'skipped_budget' };

  // Phase 1 — CEO Office selects a grounded mission, then routes it to the
  // responsible department. Persisted/custom departments remain the fallback,
  // and QA cycles remain independent quality gates.
  const departments = companyDepartments.readDepartments(project)
    .filter((department) => department.enabled !== false);
  if (!departments.length) return { action: 'skipped_no_department' };
  const qaEvery = qaEveryCycles(env);
  const qaCycle = qaEvery > 0 && (runsToday + 1) % qaEvery === 0;
  const memory = progressLedger.readProgressContext(project);
  const companyContext = await companyOperatingProfile.loadCompanyOperatingContext({
    prisma,
    project,
    now: now(),
  });
  const analyzer = deps.businessAnalyzer || (
    businessAnalyzerEnabled(env) ? businessAnalyzer : null
  );
  if (
    analyzer
    && !businessAnalyzer.isAuditFresh(companyContext.businessAudit, now())
  ) {
    try {
      const analyze = typeof analyzer === 'function'
        ? analyzer
        : analyzer.analyzeBusiness;
      if (typeof analyze === 'function') {
        const audit = await analyze({
          project,
          companyContext,
          webSearch: deps.webSearch,
          webFetch: deps.webFetch,
          browserAudit: deps.browserAudit,
          networkEnabled: deps.businessAnalyzerNetworkEnabled == null
            ? env.CODEX_BUSINESS_ANALYZER_WEB_ENABLED !== '0'
            : deps.businessAnalyzerNetworkEnabled === true,
          now,
        });
        if (audit) {
          companyContext.businessAudit = audit;
          await businessAnalyzer.persistBusinessAudit({ prisma, project, audit });
        }
      }
    } catch {
      // A presence audit is advisory. Cached readiness still lets the cycle
      // continue when search or the public website is temporarily unavailable.
    }
  }
  const prioritizedMission = qaCycle
    ? null
    : companyMissionOrchestrator.selectMissionForCycle(
      companyContext.portfolio,
      state.missionIndex,
    );
  const roundRobinDepartment = departments[state.deptIndex % departments.length];
  const sourceCounts = companyContext.portfolio?.summary?.sources || {};
  const hasDecisionSignals = ['auditFindings', 'ledgerBlockers', 'objectives']
    .some((key) => Number(sourceCounts[key]) > 0);
  // CEO Office v2 routes sourced work ahead of the legacy direct-operation
  // rotation. The old rotation remains a compatibility fallback until the
  // company has an audit, a ledger blocker or an active OKR.
  const directDepartmentTurn = !qaCycle && !hasDecisionSignals && (
    roundRobinDepartment.custom === true
    || DIRECT_OPERATION_DEPARTMENTS.has(roundRobinDepartment.id)
  );
  const selectedMission = directDepartmentTurn ? null : prioritizedMission;
  const missionDepartment = selectedMission
    ? departments.find((entry) => entry.id === selectedMission.departmentId)
    : null;
  const department = qaCycle
    ? {
      id: 'qa-reviewer',
      name: 'QA Reviewer',
      mission: 'Audita el diff acumulado, ejecuta pruebas y corrige regresiones antes de que el producto siga creciendo.',
    }
    : directDepartmentTurn
      ? roundRobinDepartment
      : missionDepartment || roundRobinDepartment;
  const poolBudget = await (deps.departmentPools || departmentPools).checkDepartmentPoolBudget({
    prisma,
    projectId: project.id,
    departmentId: department.id,
    env,
    now: now(),
  });
  if (!poolBudget.allowed) {
    const message = poolBudget.reason === 'pool_disabled'
      ? `El pool ${department.name} está pausado.`
      : `El pool ${department.name} alcanzó su presupuesto diario.`;
    await writeProactiveState({
      prisma,
      project,
      patch: {
        dayKey: today,
        deptIndex: qaCycle ? state.deptIndex : (state.deptIndex + 1) % departments.length,
        lastCycleAt: now().toISOString(),
        lastError: message,
        costTodayUsd: spentUsd,
        dailyBudgetUsd: budgetUsd,
        budgetBlocked: false,
        lastDepartment: department.id,
      },
    });
    return {
      action: poolBudget.reason === 'pool_disabled'
        ? 'skipped_department_pool'
        : 'skipped_department_budget',
      department: department.id,
      poolBudget,
    };
  }
  const resourceAssignments = companyResources.readCompanyResources(project).assignments;
  const assignedResources = resourcesAssignedToDepartment(
    project,
    department.id,
    resourceAssignments,
  );
  const chatComplete = deps.chatComplete || ((a) => require('./llm-provider').chatComplete(a));

  // Marketing is an external-effect department, not another code generator.
  // It delegates to the real social-company pipeline and remains constrained
  // by the user's review/auto policy. Default review/disabled can never publish.
  if (!qaCycle && department.id === 'marketing') {
    const social = deps.socialAutopilot || require('../social-company/autopilot');
    const result = await social.generateDepartmentPost({
      prisma,
      project,
      ledger: memory.ledger,
      objectives: memory.objectives,
      allowedPlatforms: assignedResources
        .map((resourceKey) => companyResources.parseSocialResourceKey(resourceKey)?.platform)
        .filter(Boolean),
      chatComplete,
      now,
    });
    const outcome = ['scheduled_auto', 'drafted_review', 'already_generated'].includes(result.action)
      ? 'passed'
      : 'blocked';
    await progressLedger.appendLedgerEntry({
      prisma,
      project,
      entry: {
        department: department.name,
        runId: result.postId ? `social:${result.postId}` : `social:${today}:${project.id}`,
        outcome,
        task: autoMarketingTask(result),
        diffstat: { additions: 0, deletions: 0, filesChanged: 0 },
        acceptance: [{
          criterion: 'La salida social respeta la política explícita del usuario.',
          passed: outcome === 'passed',
          evidence: `social-company: ${result.action}${result.reason ? ` (${result.reason})` : ''}`,
        }],
        learnings: [`Marketing → social-company: ${result.action}.`],
        createdAt: now().toISOString(),
      },
    });
    await writeProactiveState({
      prisma,
      project,
      patch: {
        dayKey: today,
        runsToday: runsToday + 1,
        deptIndex: (state.deptIndex + 1) % departments.length,
        lastCycleAt: now().toISOString(),
        lastError: outcome === 'passed' ? null : `Marketing no ejecutó efecto externo: ${result.action}.`,
        costTodayUsd: spentUsd,
        dailyBudgetUsd: budgetUsd,
        budgetBlocked: false,
        lastDepartment: department.id,
        missionIndex: state.missionIndex + 1,
        lastMissionId: selectedMission?.id || null,
      },
    });
    return {
      action: `marketing_${result.action}`,
      department: department.id,
      postId: result.postId || null,
      policyOutcome: result.action,
    };
  }

  if (!qaCycle && department.id === 'sales') {
    const operations = deps.companyOperations || require('./company-operations');
    const result = await operations.researchLeads({
      prisma,
      project,
      companyContext,
      chatComplete,
      webSearch: deps.webSearch,
      now,
    });
    const passed = ['leads_saved', 'no_qualified_results', 'no_results'].includes(result.action);
    await finishOperationalCycle({
      prisma,
      project,
      state,
      today,
      now,
      spentUsd,
      budgetUsd,
      departments,
      department,
      runId: `sales:${today}:${project.id}`,
      outcome: passed ? 'passed' : 'blocked',
      task: result.action === 'leads_saved'
        ? `${result.leads.length} prospecto(s) investigados y guardados con fuente pública.`
        : `Investigación comercial: ${result.action}.`,
      evidence: `${result.sourceCount || 0} fuente(s), ${result.leads?.length || 0} lead(s) persistidos.`,
      learnings: [`Ventas → pipeline: ${result.action}.`],
    });
    return {
      action: `sales_${result.action}`,
      department: department.id,
      leads: result.leads?.length || 0,
    };
  }

  if (!qaCycle && department.id === 'customer-success') {
    const operations = deps.companyOperations || require('./company-operations');
    const hasGmailResource = assignedResources.includes('connector:gmail');
    const hasSocialResource = assignedResources.some(
      (resourceKey) => resourceKey.startsWith('social:'),
    );
    let inboxResult = {
      action: 'company_resource_not_assigned',
      items: [],
      actions: [],
      error: 'connector:gmail is not assigned to customer-success',
    };
    if (hasGmailResource) {
      try {
        inboxResult = await operations.triageInbox({
          prisma,
          project,
          companyContext,
          chatComplete,
          gmailLoader: deps.gmailLoader,
          env,
          now,
        });
      } catch (error) {
        inboxResult = {
          action: error?.code || 'inbox_unavailable',
          items: [],
          actions: [],
          error: String(error?.message || error).slice(0, 500),
        };
      }
    }
    let socialResult = {
      action: 'company_social_resource_not_assigned',
      items: [],
      actions: [],
      errors: [],
    };
    if (
      hasSocialResource
      && typeof operations.triageSocialConversations === 'function'
    ) {
      try {
        socialResult = await operations.triageSocialConversations({
          prisma,
          project,
          companyContext,
          chatComplete,
          env,
          now,
        });
      } catch (error) {
        socialResult = {
          action: error?.code || 'social_inbox_unavailable',
          items: [],
          actions: [],
          errors: [{ message: String(error?.message || error).slice(0, 500) }],
        };
      }
    }
    const inboxPassed = ['inbox_clear', 'triaged_review', 'triaged_auto'].includes(inboxResult.action);
    const socialPassed = [
      'social_not_connected',
      'social_inbox_clear',
      'social_triaged_review',
      'social_triaged_auto',
    ].includes(socialResult.action);
    const passed = inboxPassed && socialPassed;
    const inboxCount = inboxResult.items?.length || 0;
    const socialCount = socialResult.items?.length || 0;
    const actionCount = (inboxResult.actions?.length || 0) + (socialResult.actions?.length || 0);
    await finishOperationalCycle({
      prisma,
      project,
      state,
      today,
      now,
      spentUsd,
      budgetUsd,
      departments,
      department,
      runId: `inbox:${today}:${project.id}`,
      outcome: passed ? 'passed' : 'blocked',
      task: passed
        ? `${inboxCount} correo(s) y ${socialCount} conversación(es) social(es) revisados; ${actionCount} acción(es) trazables.`
        : `Canales no procesados: email=${inboxResult.error || inboxResult.action}; social=${socialResult.action}.`,
      evidence: `inbox=${inboxCount}; social=${socialCount}; actions=${actionCount}; email_policy=${inboxResult.policy?.mode || 'n/a'}; social_policy=${socialResult.policy?.mode || 'n/a'}.`,
      learnings: [
        `Clientes y Soporte → inbox: ${inboxResult.action}.`,
        `Clientes y Soporte → social: ${socialResult.action}.`,
      ],
    });
    return {
      action: `customer_success_${inboxResult.action}`,
      department: department.id,
      inboxItems: inboxCount,
      socialItems: socialCount,
      actions: actionCount,
    };
  }

  let fileTree = '';
  let notes = '';
  if (deps.runner) {
    try { fileTree = String((await deps.runner.fileTree?.(project.id)) || ''); } catch { /* best-effort */ }
    try { notes = String((await deps.runner.readFile(project.id, '.sira/notes.md'))?.content || ''); } catch { /* best-effort */ }
  }
  const recentRuns = await prisma.codexRun.findMany({
    where: { projectId: project.id, status: { in: ['done', 'error', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { prompt: true, status: true },
  }).catch(() => []);

  let proposal = null;
  try {
    proposal = await proposeTask({
      project,
      department,
      recentRuns,
      fileTree,
      notes,
      ledger: memory.ledger,
      objectives: memory.objectives,
      companyContext,
      mission: selectedMission,
      qaCycle,
      chatComplete,
    });
  } catch (err) {
    await writeProactiveState({ prisma, project, patch: { lastCycleAt: now().toISOString(), lastError: String(err?.message || err).slice(0, 300) } });
    return { action: 'skipped_no_proposal' };
  }
  if (!proposal) {
    await writeProactiveState({ prisma, project, patch: { lastCycleAt: now().toISOString(), lastError: 'propuesta inválida del modelo' } });
    return { action: 'skipped_no_proposal' };
  }

  if (proposal.objectives.length) {
    await progressLedger.writeObjectives({
      prisma,
      project,
      objectives: proposal.objectives,
      reviewer: 'CEO Office',
      source: 'proactive_cycle',
      rationale: selectedMission
        ? `Cartera revisada para priorizar la misión ${selectedMission.id}.`
        : 'Cartera revisada para seleccionar el siguiente trabajo empresarial verificable.',
      now: now(),
    });
  }
  if (proposal.companyProfile) {
    await companyOperatingProfile.writeCompanyProfile({
      prisma,
      project,
      patch: proposal.companyProfile,
      now: now(),
    });
  }
  const prompt = progressLedger.formatProactivePrompt({
    department,
    title: proposal.title,
    goal: proposal.goal,
    acceptanceCriteria: proposal.acceptanceCriteria,
    objectiveIds: proposal.objectiveIds,
    qaCycle,
    missionId: selectedMission?.id || null,
    swarm: proposal.swarm,
  });
  const run = await runService.createRun({
    userId: project.userId,
    projectId: project.id,
    mode: 'plan',
    prompt,
    // OpenClaw-style durable autonomy: plan auto-continues into build.
    autoExecute: true,
    db: prisma,
  });
  await writeProactiveState({
    prisma,
    project,
    patch: {
      dayKey: today,
      runsToday: runsToday + 1,
      deptIndex: qaCycle ? state.deptIndex : (state.deptIndex + 1) % departments.length,
      lastCycleAt: now().toISOString(),
      lastError: null,
      costTodayUsd: spentUsd,
      dailyBudgetUsd: budgetUsd,
      budgetBlocked: false,
      lastDepartment: department.id,
      missionIndex: qaCycle ? state.missionIndex : state.missionIndex + 1,
      lastMissionId: selectedMission?.id || null,
    },
  });
  return {
    action: 'proposed',
    runId: run && run.id,
    department: department.id,
    missionId: selectedMission?.id || null,
    qaCycle,
  };
}

async function runCycle(args) {
  const startedAt = Date.now();
  let result;
  let lease = null;
  try {
    const currentTime = args?.now ? args.now() : new Date();
    lease = await proactiveLease.acquireProactiveLease({
      prisma: args?.deps?.prisma,
      projectId: args?.project?.id,
      now: currentTime,
      env: args?.env,
    });
    if (!lease) {
      result = { action: 'skipped_cycle_leased' };
      return result;
    }
    result = await runCycleInternal(args);
    return result;
  } finally {
    await proactiveLease.releaseProactiveLease({
      prisma: args?.deps?.prisma,
      lease,
    }).catch(() => {});
    proactiveMetrics.recordCycle({
      action: result?.action || 'error',
      department: result?.department || progressLedger.taskMetaFromPrompt(args?.project?.prompt)?.departmentId || 'none',
      durationMs: Date.now() - startedAt,
    });
  }
}

/** One tick over every proactive-enabled project (bounded, failure-isolated). */
async function tickAll({ deps = {}, env = process.env, now = () => new Date(), maxProjects = 10 } = {}) {
  const prisma = deps.prisma || require('../../config/database');
  const projects = await prisma.codexProject.findMany({
    where: { brief: { path: ['proactive', 'enabled'], equals: true }, deletedAt: null },
    take: maxProjects,
    orderBy: { updatedAt: 'asc' },
  }).catch(() => []);
  const results = [];
  for (const project of projects) {
    try {
      results.push({ projectId: project.id, ...(await runCycle({ project, deps: { ...deps, prisma }, env, now })) });
    } catch (err) {
      results.push({ projectId: project.id, action: 'error', error: String(err?.message || err).slice(0, 200) });
    }
  }
  return results;
}

// ── Ticker (wired from index.js boot) ────────────────────────────────────────
let _timer = null;

function tickerEnabled(env = process.env) {
  if (env.CODEX_PROACTIVE_ENABLED === '1') return true;
  if (env.CODEX_PROACTIVE_ENABLED === '0') return false;
  return env.NODE_ENV === 'production';
}

function startProactiveTicker({ env = process.env, deps = {} } = {}) {
  if (!tickerEnabled(env) || _timer) return false;
  const raw = Number.parseInt(env.CODEX_PROACTIVE_INTERVAL_MS ?? '', 10);
  // Heartbeat-style cadence (OpenClaw): default every 2 minutes for continuous company work.
  const intervalMs = Number.isFinite(raw) && raw >= 60_000 ? raw : 2 * 60_000;
  _timer = setInterval(() => {
    tickAll({ deps, env })
      .then(() => require('./proactive-digest').sendDailyDigest({ prisma: deps.prisma, env }))
      .catch((err) => {
        console.warn('[codex proactive] tick failed:', err?.message || err);
      });
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  return true;
}

function stopProactiveTicker() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  DEPARTMENTS,
  PROACTIVE_PREFIX,
  readProactiveState,
  setProactive,
  ensureFleetDepartmentPools,
  proposeTask,
  runCycle,
  tickAll,
  tickerEnabled,
  startProactiveTicker,
  stopProactiveTicker,
  extractJson,
  maxPerDay,
  dailyBudgetUsd,
  projectDailyBudgetUsd,
  costTodayUsd,
  checkDailyBudget,
  qaEveryCycles,
};
