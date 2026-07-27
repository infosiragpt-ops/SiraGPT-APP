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
 *   - Per-project daily proposal cap (CODEX_PROACTIVE_MAX_PER_DAY, default 6)
 *     and USD kill switch (CODEX_PROACTIVE_DAILY_BUDGET_USD, default 2).
 *   - Single-active-run gate: a busy project is skipped, never queued up.
 *   - Departments rotate round-robin so one mandate can't monopolize.
 *   - Ticker default-on ONLY in production; explicit CODEX_PROACTIVE_ENABLED
 *     overrides both ways ('1' forces on, '0' forces off).
 *   - All external effects (prisma, run-service, LLM, runner) are injectable.
 */

const PROACTIVE_PREFIX = '[PROACTIVO';
const progressLedger = require('./progress-ledger');
const proactiveMetrics = require('./proactive-metrics');

/** Backend mirror of lib/code-agent-company.ts AGENT_COMPANY_DEPARTMENTS. */
const DEPARTMENTS = Object.freeze([
  { id: 'ceo-office', name: 'CEO Office', mission: 'Define prioridades, conserva decisiones y coordina el trabajo del resto de departamentos. Propone la mejora de mayor impacto para el producto AHORA.' },
  { id: 'agent-infrastructure', name: 'Infraestructura de Agentes', mission: 'Orquestación, runners, aislamiento y continuidad operativa. Propone mejoras de robustez, rendimiento o developer-experience del propio proyecto.' },
  { id: 'growth-engines', name: 'Motores de Crecimiento y Distribución', mission: 'Adquisición, distribución, monetización y crecimiento medible. Propone features orientadas a conseguir y retener usuarios.' },
  { id: 'localization', name: 'Localización e IA Transcultural', mission: 'Idiomas, regiones, accesibilidad cultural y adaptación de mercado. Propone internacionalización y accesibilidad.' },
  { id: 'integrations', name: 'Ecosistema de Integraciones y Conectores', mission: 'APIs, canales, conectores, herramientas y automatizaciones. Propone integraciones que multipliquen el valor del producto.' },
  { id: 'trust', name: 'Confianza, Privacidad y Cumplimiento', mission: 'Seguridad, privacidad, cumplimiento y manejo responsable de datos. Propone endurecimiento y transparencia.' },
  { id: 'product-engineering', name: 'Producto e Ingeniería SiraGPT', mission: 'Arquitectura, experiencia de producto y entrega verificable. Propone y construye mejoras incrementales con pruebas.' },
  { id: 'marketing', name: 'Marketing', mission: 'Posicionamiento, contenido y campañas medibles. Prepara activos y distribución; las publicaciones externas solo se ejecutan mediante cuentas conectadas y la política explícita de Recursos.' },
]);

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
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
    dailyBudgetUsd: Math.max(0, Number(p.dailyBudgetUsd) || 0),
    budgetBlocked: p.budgetBlocked === true,
    lastDepartment: typeof p.lastDepartment === 'string' ? p.lastDepartment : null,
  };
}

async function writeProactiveState({ prisma, project, patch }) {
  // A run can append to brief.ledger while the scheduler is still holding an
  // older project snapshot. Reload before merging so a state tick never erases
  // newly-written long-term memory or objectives.
  const fresh = prisma?.codexProject?.findUnique
    ? await prisma.codexProject.findUnique({ where: { id: project.id } }).catch(() => null)
    : null;
  const source = fresh || project;
  const brief = source && typeof source.brief === 'object' && source.brief !== null ? source.brief : {};
  const current = readProactiveState(source);
  const next = { ...current, ...patch };
  await prisma.codexProject.update({
    where: { id: project.id },
    data: { brief: { ...brief, proactive: next } },
  });
  return next;
}

async function setProactive({ prisma, projectId, userId, enabled, now = () => new Date() }) {
  const project = await prisma.codexProject.findFirst({ where: { id: projectId, userId } });
  if (!project) return null;
  const state = await writeProactiveState({
    prisma,
    project,
    patch: enabled
      ? { enabled: true, enabledAt: now().toISOString(), lastError: null }
      : { enabled: false },
  });
  return { projectId, state };
}

function maxPerDay(env = process.env) {
  const n = Number.parseInt(env.CODEX_PROACTIVE_MAX_PER_DAY ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}

function dailyBudgetUsd(env = process.env) {
  const value = Number(env.CODEX_PROACTIVE_DAILY_BUDGET_USD);
  return Number.isFinite(value) && value >= 0 ? value : 2;
}

function qaEveryCycles(env = process.env) {
  const value = Number.parseInt(env.CODEX_PROACTIVE_QA_EVERY_CYCLES ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 5;
}

async function costTodayUsd({ prisma, projectId, now = new Date() }) {
  if (!prisma?.codexRunMetric?.aggregate) return 0;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  try {
    const result = await prisma.codexRunMetric.aggregate({
      where: {
        createdAt: { gte: start },
        run: { projectId },
      },
      _sum: { costAppliedUsd: true },
    });
    return Math.max(0, Number(result?._sum?.costAppliedUsd) || 0);
  } catch {
    return 0;
  }
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

function autoMarketingTask(result = {}) {
  if (result.action === 'drafted_review') return 'Contenido preparado como borrador para revisión humana.';
  if (result.action === 'scheduled_auto') return 'Contenido programado bajo política auto explícitamente habilitada.';
  if (result.action === 'already_generated') return 'Contenido diario ya generado; idempotencia conservada.';
  return `Sin efecto externo: ${result.action || 'política no disponible'}.`;
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
  qaCycle = false,
  chatComplete,
}) {
  const messages = [
    {
      role: 'system',
      content: [
        'Eres el director del departamento indicado dentro de una compañía de agentes de software autónomos.',
        'Tu trabajo: proponer LA SIGUIENTE tarea más valiosa (una sola, concreta, completable por un agente de código en una sesión) para este proyecto.',
        'Responde SOLO JSON: {"title":"<3-8 palabras>","goal":"<instrucción concreta y autosuficiente, 1-3 frases>","acceptanceCriteria":["<resultado observable>"],"objectiveIds":["<id>"],"objectives":[{"id":"...","title":"...","metric":"...","target":"...","status":"active","priority":1}]}.',
        'La tarea debe ser INCREMENTAL sobre lo ya construido (no re-hacer lo existente), y del ámbito del departamento.',
        'Incluye entre 2 y 5 criterios de aceptación observables. No uses criterios vagos como "que se vea bien".',
        department.id === 'ceo-office'
          ? 'Como CEO Office, re-prioriza objectives con un máximo de 5 OKR medibles. Conserva ids estables cuando un objetivo siga vigente.'
          : 'Para objectives devuelve [] y enlaza la tarea a los objectiveIds vigentes que corresponda.',
        qaCycle
          ? 'Esta es una auditoría acumulada: el constructor DEBE delegar primero en qa_reviewer, revisar el diff y añadir o mejorar smoke tests antes de corregir hallazgos.'
          : null,
        'Nunca incluyas secretos. No publiques en redes ni actives gasto desde una tarea de código; prepara el trabajo y usa los controles explícitos de Recursos para efectos externos.',
      ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: [
        `Proyecto: ${project.name || project.id}`,
        project.brief && project.brief.goal ? `Objetivo del proyecto: ${String(project.brief.goal).slice(0, 500)}` : null,
        `Departamento: ${department.name} — ${department.mission}`,
        fileTree ? `Archivos del workspace:\n${String(fileTree).slice(0, 1800)}` : 'Workspace aún vacío (proyecto nuevo).',
        notes ? `Notas del proyecto (.sira/notes.md):\n${String(notes).slice(0, 1200)}` : null,
        objectives.length
          ? `OKR vigentes:\n${objectives.map((item) => `- ${item.id} [P${item.priority}, ${item.status}] ${item.title}${item.metric ? ` · ${item.metric}: ${item.target || 'sin meta'}` : ''}`).join('\n')}`
          : 'Aún no hay OKR estructurados.',
        ledger.length
          ? `Progress Ledger (resultados acumulados, no repitas fallos ni trabajo):\n${ledger.slice(-12).map((item) => {
            const diff = `+${item.diffstat.additions}/-${item.diffstat.deletions}`;
            const learning = item.learnings[0] ? ` · ${item.learnings[0]}` : '';
            return `- [${item.outcome}] ${item.department} · ${diff} · ${item.task || item.runId}${learning}`;
          }).join('\n')}`
          : 'Progress Ledger vacío: esta será una de las primeras decisiones.',
        recentRuns && recentRuns.length
          ? `Últimos trabajos (no los repitas):\n${recentRuns.map((r) => `- [${r.status}] ${String(r.prompt || '').slice(0, 140)}`).join('\n')}`
          : 'Sin trabajos previos.',
      ].filter(Boolean).join('\n\n'),
    },
  ];
  const out = await chatComplete({ messages, temperature: 0.5, maxTokens: 400 });
  const parsed = extractJson(out && out.content);
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
  const budgetUsd = dailyBudgetUsd(env);
  const spentUsd = await costTodayUsd({ prisma, projectId: project.id, now: now() });
  const budgetBlocked = budgetUsd === 0 || spentUsd >= budgetUsd;
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
    if (budgetBlocked) {
      const message = `Presupuesto proactivo diario alcanzado: $${spentUsd.toFixed(4)} de $${budgetUsd.toFixed(2)}.`;
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
      return { action: 'skipped_cost_budget', costTodayUsd: spentUsd, dailyBudgetUsd: budgetUsd };
    }
    // Phase 2 — auto-approve OUR OWN plan by creating its build run.
    const run = await runService.createRun({
      userId: project.userId,
      projectId: project.id,
      mode: 'build',
      prompt: active.prompt,
      planRunId: active.id,
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
    const message = `Presupuesto proactivo diario alcanzado: $${spentUsd.toFixed(4)} de $${budgetUsd.toFixed(2)}.`;
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
    return { action: 'skipped_cost_budget', costTodayUsd: spentUsd, dailyBudgetUsd: budgetUsd };
  }
  if (maxPerDay(env) === 0 || runsToday >= maxPerDay(env)) return { action: 'skipped_budget' };

  // Phase 1 — pick the next department (round-robin) and propose a task.
  const qaEvery = qaEveryCycles(env);
  const qaCycle = qaEvery > 0 && (runsToday + 1) % qaEvery === 0;
  const department = qaCycle
    ? {
      id: 'qa-reviewer',
      name: 'QA Reviewer',
      mission: 'Audita el diff acumulado, ejecuta pruebas y corrige regresiones antes de que el producto siga creciendo.',
    }
    : DEPARTMENTS[state.deptIndex % DEPARTMENTS.length];
  const chatComplete = deps.chatComplete || ((a) => require('./llm-provider').chatComplete(a));
  const memory = progressLedger.readProgressContext(project);

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
        deptIndex: (state.deptIndex + 1) % DEPARTMENTS.length,
        lastCycleAt: now().toISOString(),
        lastError: outcome === 'passed' ? null : `Marketing no ejecutó efecto externo: ${result.action}.`,
        costTodayUsd: spentUsd,
        dailyBudgetUsd: budgetUsd,
        budgetBlocked: false,
        lastDepartment: department.id,
      },
    });
    return {
      action: `marketing_${result.action}`,
      department: department.id,
      postId: result.postId || null,
      policyOutcome: result.action,
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
    await progressLedger.writeObjectives({ prisma, project, objectives: proposal.objectives, now: now() });
  }
  const prompt = progressLedger.formatProactivePrompt({
    department,
    title: proposal.title,
    goal: proposal.goal,
    acceptanceCriteria: proposal.acceptanceCriteria,
    objectiveIds: proposal.objectiveIds,
    qaCycle,
  });
  const run = await runService.createRun({
    userId: project.userId,
    projectId: project.id,
    mode: 'plan',
    prompt,
    db: prisma,
  });
  await writeProactiveState({
    prisma,
    project,
    patch: {
      dayKey: today,
      runsToday: runsToday + 1,
      deptIndex: qaCycle ? state.deptIndex : (state.deptIndex + 1) % DEPARTMENTS.length,
      lastCycleAt: now().toISOString(),
      lastError: null,
      costTodayUsd: spentUsd,
      dailyBudgetUsd: budgetUsd,
      budgetBlocked: false,
      lastDepartment: department.id,
    },
  });
  return { action: 'proposed', runId: run && run.id, department: department.id, qaCycle };
}

async function runCycle(args) {
  const startedAt = Date.now();
  let result;
  try {
    result = await runCycleInternal(args);
    return result;
  } finally {
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
  const intervalMs = Number.isFinite(raw) && raw >= 60_000 ? raw : 5 * 60_000;
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
  proposeTask,
  runCycle,
  tickAll,
  tickerEnabled,
  startProactiveTicker,
  stopProactiveTicker,
  extractJson,
  maxPerDay,
  dailyBudgetUsd,
  costTodayUsd,
  qaEveryCycles,
};
