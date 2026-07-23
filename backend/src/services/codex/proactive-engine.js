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
 *   { enabled, enabledAt, dayKey, runsToday, deptIndex, lastCycleAt, lastError }
 *
 * Safety rails:
 *   - Per-project daily proposal cap (CODEX_PROACTIVE_MAX_PER_DAY, default 6).
 *   - Single-active-run gate: a busy project is skipped, never queued up.
 *   - Departments rotate round-robin so one mandate can't monopolize.
 *   - Ticker default-on ONLY in production; explicit CODEX_PROACTIVE_ENABLED
 *     overrides both ways ('1' forces on, '0' forces off).
 *   - All external effects (prisma, run-service, LLM, runner) are injectable.
 */

const PROACTIVE_PREFIX = '[PROACTIVO';

/** Backend mirror of lib/code-agent-company.ts AGENT_COMPANY_DEPARTMENTS. */
const DEPARTMENTS = Object.freeze([
  { id: 'ceo-office', name: 'CEO Office', mission: 'Define prioridades, conserva decisiones y coordina el trabajo del resto de departamentos. Propone la mejora de mayor impacto para el producto AHORA.' },
  { id: 'agent-infrastructure', name: 'Infraestructura de Agentes', mission: 'Orquestación, runners, aislamiento y continuidad operativa. Propone mejoras de robustez, rendimiento o developer-experience del propio proyecto.' },
  { id: 'growth-engines', name: 'Motores de Crecimiento y Distribución', mission: 'Adquisición, distribución, monetización y crecimiento medible. Propone features orientadas a conseguir y retener usuarios.' },
  { id: 'localization', name: 'Localización e IA Transcultural', mission: 'Idiomas, regiones, accesibilidad cultural y adaptación de mercado. Propone internacionalización y accesibilidad.' },
  { id: 'integrations', name: 'Ecosistema de Integraciones y Conectores', mission: 'APIs, canales, conectores, herramientas y automatizaciones. Propone integraciones que multipliquen el valor del producto.' },
  { id: 'trust', name: 'Confianza, Privacidad y Cumplimiento', mission: 'Seguridad, privacidad, cumplimiento y manejo responsable de datos. Propone endurecimiento y transparencia.' },
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
  };
}

async function writeProactiveState({ prisma, project, patch }) {
  const brief = project && typeof project.brief === 'object' && project.brief !== null ? project.brief : {};
  const current = readProactiveState(project);
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

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/** LLM proposal: the department's next most valuable task for this project. */
async function proposeTask({ project, department, recentRuns, fileTree, notes, chatComplete }) {
  const messages = [
    {
      role: 'system',
      content: [
        'Eres el director del departamento indicado dentro de una compañía de agentes de software autónomos.',
        'Tu trabajo: proponer LA SIGUIENTE tarea más valiosa (una sola, concreta, completable por un agente de código en una sesión) para este proyecto.',
        'Responde SOLO un JSON: {"title": "<3-8 palabras>", "goal": "<instrucción concreta y autosuficiente para el agente constructor, 1-3 frases, en español>"}.',
        'La tarea debe ser INCREMENTAL sobre lo ya construido (no re-hacer lo existente), y del ámbito del departamento.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Proyecto: ${project.name || project.id}`,
        project.brief && project.brief.goal ? `Objetivo del proyecto: ${String(project.brief.goal).slice(0, 500)}` : null,
        `Departamento: ${department.name} — ${department.mission}`,
        fileTree ? `Archivos del workspace:\n${String(fileTree).slice(0, 1800)}` : 'Workspace aún vacío (proyecto nuevo).',
        notes ? `Notas del proyecto (.sira/notes.md):\n${String(notes).slice(0, 1200)}` : null,
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
  return { title: title.slice(0, 90), goal: parsed.goal.trim().slice(0, 900) };
}

/**
 * One proactive cycle for one project. Returns a { action } tag for tests/logs:
 *   'approved_plan' | 'proposed' | 'skipped_active' | 'skipped_budget' |
 *   'skipped_no_proposal' | 'disabled'
 */
async function runCycle({ project, deps = {}, env = process.env, now = () => new Date() }) {
  const prisma = deps.prisma;
  const runService = deps.runService || require('./run-service');
  const state = readProactiveState(project);
  if (!state.enabled) return { action: 'disabled' };

  const today = dayKey(now());
  const runsToday = state.dayKey === today ? state.runsToday : 0;

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
    // Phase 2 — auto-approve OUR OWN plan by creating its build run.
    const run = await runService.createRun({
      userId: project.userId,
      projectId: project.id,
      mode: 'build',
      prompt: active.prompt,
      planRunId: active.id,
      db: prisma,
    });
    await writeProactiveState({ prisma, project, patch: { lastCycleAt: now().toISOString(), lastError: null } });
    return { action: 'approved_plan', runId: run && run.id, planRunId: active.id };
  }

  if (maxPerDay(env) === 0 || runsToday >= maxPerDay(env)) return { action: 'skipped_budget' };

  // Phase 1 — pick the next department (round-robin) and propose a task.
  const department = DEPARTMENTS[state.deptIndex % DEPARTMENTS.length];
  const chatComplete = deps.chatComplete || ((a) => require('./llm-provider').chatComplete(a));

  let fileTree = '';
  let notes = '';
  if (deps.runner) {
    try { fileTree = String((await deps.runner.fileTree?.(project.id)) || ''); } catch { /* best-effort */ }
    try { notes = String((await deps.runner.readFile(project.id, '.sira/notes.md'))?.content || ''); } catch { /* best-effort */ }
  }
  const recentRuns = await prisma.codexRun.findMany({
    where: { projectId: project.id, status: { in: ['done', 'error', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { prompt: true, status: true },
  }).catch(() => []);

  let proposal = null;
  try {
    proposal = await proposeTask({ project, department, recentRuns, fileTree, notes, chatComplete });
  } catch (err) {
    await writeProactiveState({ prisma, project, patch: { lastCycleAt: now().toISOString(), lastError: String(err?.message || err).slice(0, 300) } });
    return { action: 'skipped_no_proposal' };
  }
  if (!proposal) {
    await writeProactiveState({ prisma, project, patch: { lastCycleAt: now().toISOString(), lastError: 'propuesta inválida del modelo' } });
    return { action: 'skipped_no_proposal' };
  }

  const prompt = `${PROACTIVE_PREFIX} · ${department.name}] ${proposal.title}: ${proposal.goal}`;
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
      deptIndex: (state.deptIndex + 1) % DEPARTMENTS.length,
      lastCycleAt: now().toISOString(),
      lastError: null,
    },
  });
  return { action: 'proposed', runId: run && run.id, department: department.id };
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
    tickAll({ deps, env }).catch((err) => {
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
  startProactiveTicker,
  stopProactiveTicker,
  extractJson,
  maxPerDay,
};
