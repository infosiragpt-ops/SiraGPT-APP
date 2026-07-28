'use strict';

const { mutateProjectBrief } = require('./project-brief-store');

/**
 * Structured, bounded memory for the autonomous company. It lives inside the
 * existing CodexProject.brief JSON column so rollout needs no schema migration.
 */

const MAX_LEDGER_ENTRIES = 120;
const MAX_OBJECTIVES = 12;
const MAX_ACCEPTANCE_CRITERIA = 8;
const MAX_SWARM_SPECIALISTS = 12;
const PROACTIVE_META_MARKER = '[SIRA_PROACTIVE_META]';
const OPEN_FAILURE_OUTCOMES = new Set(['failed', 'blocked']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function slug(value) {
  return boundedText(value, 120)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function taskFingerprint(value) {
  return boundedText(value, 600)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 180);
}

function normalizeAcceptanceCriteria(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((value) => boundedText(value, 280)).filter(Boolean))]
    .slice(0, MAX_ACCEPTANCE_CRITERIA);
}

function normalizeSwarm(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map((value) => {
      const source = asRecord(value);
      const agent = boundedText(source.agent || source.name, 40).toLowerCase();
      const task = boundedText(source.task || source.goal, 600);
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(agent) || !task) return null;
      const key = `${agent}:${task.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return { agent, task };
    })
    .filter(Boolean)
    .slice(0, MAX_SWARM_SPECIALISTS);
}

function normalizeObjective(value, index = 0) {
  const source = asRecord(value);
  const title = boundedText(source.title || source.objective, 180);
  if (!title) return null;
  const status = ['active', 'at_risk', 'done', 'paused'].includes(source.status)
    ? source.status
    : 'active';
  const priority = Math.max(1, Math.min(5, Number.parseInt(source.priority, 10) || index + 1));
  return {
    id: boundedText(source.id, 80) || slug(title) || `objective-${index + 1}`,
    title,
    metric: boundedText(source.metric, 180) || null,
    target: boundedText(source.target, 180) || null,
    status,
    priority,
    updatedAt: boundedText(source.updatedAt, 40) || null,
  };
}

function normalizeObjectives(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map(normalizeObjective)
    .filter((objective) => {
      if (!objective || seen.has(objective.id)) return false;
      seen.add(objective.id);
      return true;
    })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_OBJECTIVES);
}

function normalizeLedgerEntry(value) {
  const source = asRecord(value);
  const runId = boundedText(source.runId, 180);
  if (!runId) return null;
  const missionId = boundedText(source.missionId, 100) || null;
  const task = boundedText(source.title || source.task, 600) || null;
  const failureKey = boundedText(source.failureKey, 180) || taskFingerprint(task);
  const createdAt = boundedText(source.ts || source.createdAt, 40) || new Date().toISOString();
  const acceptance = Array.isArray(source.acceptance)
    ? source.acceptance.slice(0, MAX_ACCEPTANCE_CRITERIA).map((item) => ({
      criterion: boundedText(item?.criterion, 280),
      passed: item?.passed === true,
      evidence: boundedText(item?.evidence, 500) || null,
    })).filter((item) => item.criterion)
    : [];
  return {
    department: boundedText(source.department, 100) || 'unknown',
    runId,
    ...(missionId ? { missionId } : {}),
    outcome: ['passed', 'failed', 'cancelled', 'blocked'].includes(source.outcome)
      ? source.outcome
      : 'failed',
    title: task,
    task,
    failureKey: failureKey || null,
    checkpointSha: boundedText(source.checkpointSha, 80) || null,
    diffstat: {
      additions: Math.max(0, Number(source.diffstat?.additions) || 0),
      deletions: Math.max(0, Number(source.diffstat?.deletions) || 0),
      filesChanged: Math.max(0, Number(source.diffstat?.filesChanged) || 0),
    },
    costUsd: Math.max(0, Number(source.costUsd) || 0),
    acceptance,
    learnings: Array.isArray(source.learnings)
      ? source.learnings.map((item) => boundedText(item, 500)).filter(Boolean).slice(0, 8)
      : [],
    ts: createdAt,
    createdAt,
  };
}

function normalizeLedger(input) {
  if (!Array.isArray(input)) return [];
  const byRun = new Map();
  for (const value of input) {
    const entry = normalizeLedgerEntry(value);
    if (entry) byRun.set(entry.runId, entry);
  }
  return [...byRun.values()].slice(-MAX_LEDGER_ENTRIES);
}

function readProgressContext(project) {
  const brief = asRecord(project?.brief);
  return {
    objectives: normalizeObjectives(brief.objectives),
    ledger: normalizeLedger(brief.ledger),
  };
}

function readOpenFailures(input) {
  const open = new Map();
  for (const entry of normalizeLedger(input)) {
    if (!entry.failureKey) continue;
    if (OPEN_FAILURE_OUTCOMES.has(entry.outcome)) {
      open.set(entry.failureKey, entry);
    } else if (entry.outcome === 'passed') {
      open.delete(entry.failureKey);
    }
  }
  return [...open.values()];
}

function findOpenFailure(input, title) {
  const failureKey = taskFingerprint(title);
  if (!failureKey) return null;
  return readOpenFailures(input).find((entry) => entry.failureKey === failureKey) || null;
}

function formatProgressContext(project, { maxEntries = 12, maxChars = 9000 } = {}) {
  const { objectives, ledger } = readProgressContext(project);
  if (!objectives.length && !ledger.length) return '';
  const lines = [];
  if (objectives.length) {
    lines.push('OBJETIVOS VIGENTES:');
    for (const objective of objectives) {
      lines.push(
        `- [${objective.status}] P${objective.priority} ${objective.title}`
        + `${objective.metric ? ` | métrica: ${objective.metric}` : ''}`
        + `${objective.target ? ` | meta: ${objective.target}` : ''}`,
      );
    }
  }
  const recent = ledger.slice(-Math.max(1, maxEntries));
  if (recent.length) {
    if (lines.length) lines.push('');
    lines.push('LEDGER DE CORRIDAS RECIENTES:');
    for (const entry of recent) {
      lines.push(
        `- ${entry.createdAt} | ${entry.department} | ${entry.outcome} | run=${entry.runId}`
        + `${entry.task ? ` | ${entry.task}` : ''}`
        + `${entry.checkpointSha ? ` | sha=${entry.checkpointSha}` : ''}`,
      );
      for (const learning of entry.learnings.slice(0, 4)) {
        lines.push(`  aprendizaje: ${learning}`);
      }
    }
  }
  return lines.join('\n').slice(0, maxChars);
}

function extractJsonObject(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function deterministicLearnings({ outcome, checkpointSha, diffstat, verification }) {
  const files = Math.max(0, Number(diffstat?.filesChanged) || 0);
  const lines = [
    outcome === 'passed'
      ? `Corrida cerrada con gates verdes${checkpointSha ? ` en ${String(checkpointSha).slice(0, 12)}` : ''}.`
      : `Corrida cerrada como ${outcome}; revisar la evidencia de calidad antes de continuar.`,
    `Impacto: ${files} archivo(s), +${Math.max(0, Number(diffstat?.additions) || 0)} -${Math.max(0, Number(diffstat?.deletions) || 0)}.`,
  ];
  const blocked = verification?.blockingGates || verification?.gatesFailed;
  if (blocked) lines.push(`Gates observados: ${String(blocked).slice(0, 420)}.`);
  return lines;
}

async function generateAutoLearnings({
  llmTurn,
  task,
  outcome,
  checkpointSha,
  diffstat,
  verification,
  env = process.env,
}) {
  const fallback = deterministicLearnings({
    outcome,
    checkpointSha,
    diffstat,
    verification,
  });
  if (typeof llmTurn !== 'function') return { learnings: fallback, usage: null };
  const evidence = boundedText(JSON.stringify(verification || {}), 4000);
  try {
    const turn = await llmTurn({
      messages: [
        {
          role: 'system',
          content: 'Extrae memoria técnica durable de una corrida de software. Devuelve SOLO JSON válido: {"learnings":["..."]}. Incluye de 1 a 6 hechos reutilizables, decisiones, errores o convenciones. No inventes y no incluyas secretos.',
        },
        {
          role: 'user',
          content: [
            `Tarea: ${boundedText(task, 1800) || '(sin descripción)'}`,
            `Resultado: ${outcome}`,
            `Checkpoint: ${checkpointSha || '(sin cambios)'}`,
            `Diffstat: ${JSON.stringify(diffstat || {})}`,
            `Verificación: ${evidence || '(sin evidencia adicional)'}`,
          ].join('\n'),
        },
      ],
      tools: [],
      maxTokens: 700,
      effort: 'low',
      env,
    });
    const parsed = extractJsonObject(turn?.text);
    const learnings = Array.isArray(parsed?.learnings)
      ? parsed.learnings.map((value) => boundedText(value, 500)).filter(Boolean).slice(0, 8)
      : [];
    return {
      learnings: learnings.length ? learnings : fallback,
      usage: turn?.usage || null,
    };
  } catch {
    return { learnings: fallback, usage: null };
  }
}

function mergeObjectives(current, proposed, now = new Date()) {
  const existing = new Map(normalizeObjectives(current).map((item) => [item.id, item]));
  const next = normalizeObjectives(proposed).map((item) => ({
    ...existing.get(item.id),
    ...item,
    updatedAt: now.toISOString(),
  }));
  return (next.length ? next : [...existing.values()])
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_OBJECTIVES);
}

function taskMetaFromPrompt(prompt) {
  const text = String(prompt || '');
  const markerIndex = text.lastIndexOf(PROACTIVE_META_MARKER);
  if (markerIndex === -1) return null;
  const raw = text.slice(markerIndex + PROACTIVE_META_MARKER.length).trim().split('\n')[0];
  try {
    const parsed = JSON.parse(raw);
    const missionId = boundedText(parsed.missionId, 100) || null;
    return {
      department: boundedText(parsed.department, 100) || 'unknown',
      departmentId: boundedText(parsed.departmentId, 100) || null,
      title: boundedText(parsed.title, 180) || null,
      acceptanceCriteria: normalizeAcceptanceCriteria(parsed.acceptanceCriteria),
      objectiveIds: Array.isArray(parsed.objectiveIds)
        ? parsed.objectiveIds.map((id) => boundedText(id, 80)).filter(Boolean).slice(0, MAX_OBJECTIVES)
        : [],
      qaCycle: parsed.qaCycle === true,
      ...(missionId ? { missionId } : {}),
      swarm: normalizeSwarm(parsed.swarm),
    };
  } catch {
    return null;
  }
}

function formatProactivePrompt({
  department,
  title,
  goal,
  acceptanceCriteria,
  objectiveIds,
  qaCycle = false,
  missionId = null,
  swarm = [],
}) {
  const criteria = normalizeAcceptanceCriteria(acceptanceCriteria);
  const normalizedMissionId = boundedText(missionId, 100) || null;
  const meta = {
    department: department.name,
    departmentId: department.id,
    title: boundedText(title, 180),
    acceptanceCriteria: criteria,
    objectiveIds: Array.isArray(objectiveIds) ? objectiveIds.slice(0, MAX_OBJECTIVES) : [],
    qaCycle: Boolean(qaCycle),
    ...(normalizedMissionId ? { missionId: normalizedMissionId } : {}),
    swarm: normalizeSwarm(swarm),
  };
  const lines = [
    `[PROACTIVO · ${department.name}] ${boundedText(title, 180)}: ${boundedText(goal, 1800)}`,
    '',
    'Criterios de aceptación obligatorios:',
    ...(criteria.length ? criteria.map((criterion) => `- ${criterion}`) : ['- La mejora solicitada funciona y queda verificada.']),
    '',
    `${PROACTIVE_META_MARKER}${JSON.stringify(meta)}`,
  ];
  return lines.join('\n');
}

async function loadFreshProject(prisma, projectId, fallback = null) {
  if (prisma?.codexProject?.findUnique) {
    const project = await prisma.codexProject.findUnique({ where: { id: projectId } }).catch(() => null);
    if (project) return project;
  }
  return fallback;
}

async function appendLedgerEntry({ prisma, project, entry }) {
  if (!prisma?.codexProject?.update || !project?.id) return null;
  let appended = null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const ledger = normalizeLedger([...(brief.ledger || []), entry]);
      appended = ledger.at(-1) || null;
      return { ...brief, ledger };
    },
  });
  return appended;
}

async function appendLedgerEntryIfMissing({ prisma, project, entry }) {
  if (!prisma?.codexProject?.update || !project?.id) return null;
  let stored = null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const current = normalizeLedger(brief.ledger);
      const existing = current.find((item) => item.runId === entry?.runId);
      if (existing) {
        stored = existing;
        return brief;
      }
      const ledger = normalizeLedger([...current, entry]);
      stored = ledger.at(-1) || null;
      return { ...brief, ledger };
    },
  });
  return stored;
}

async function writeObjectives({ prisma, project, objectives, now = new Date() }) {
  if (!prisma?.codexProject?.update || !project?.id) return [];
  let merged = [];
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      merged = mergeObjectives(brief.objectives, objectives, now);
      return { ...brief, objectives: merged };
    },
  });
  return merged;
}

module.exports = {
  MAX_LEDGER_ENTRIES,
  MAX_OBJECTIVES,
  MAX_ACCEPTANCE_CRITERIA,
  MAX_SWARM_SPECIALISTS,
  PROACTIVE_META_MARKER,
  appendLedgerEntry,
  appendLedgerEntryIfMissing,
  asRecord,
  formatProactivePrompt,
  mergeObjectives,
  normalizeAcceptanceCriteria,
  normalizeLedger,
  normalizeSwarm,
  normalizeObjectives,
  readProgressContext,
  readOpenFailures,
  findOpenFailure,
  formatProgressContext,
  generateAutoLearnings,
  deterministicLearnings,
  taskFingerprint,
  taskMetaFromPrompt,
  writeObjectives,
};
