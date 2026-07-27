'use strict';

/**
 * Structured, bounded memory for the autonomous company. It lives inside the
 * existing CodexProject.brief JSON column so rollout needs no schema migration.
 */

const MAX_LEDGER_ENTRIES = 120;
const MAX_OBJECTIVES = 12;
const MAX_ACCEPTANCE_CRITERIA = 8;
const PROACTIVE_META_MARKER = '[SIRA_PROACTIVE_META]';

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

function normalizeAcceptanceCriteria(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((value) => boundedText(value, 280)).filter(Boolean))]
    .slice(0, MAX_ACCEPTANCE_CRITERIA);
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
    outcome: ['passed', 'failed', 'cancelled', 'blocked'].includes(source.outcome)
      ? source.outcome
      : 'failed',
    task: boundedText(source.task, 600) || null,
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
    createdAt: boundedText(source.createdAt, 40) || new Date().toISOString(),
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
    return {
      department: boundedText(parsed.department, 100) || 'unknown',
      departmentId: boundedText(parsed.departmentId, 100) || null,
      title: boundedText(parsed.title, 180) || null,
      acceptanceCriteria: normalizeAcceptanceCriteria(parsed.acceptanceCriteria),
      objectiveIds: Array.isArray(parsed.objectiveIds)
        ? parsed.objectiveIds.map((id) => boundedText(id, 80)).filter(Boolean).slice(0, MAX_OBJECTIVES)
        : [],
      qaCycle: parsed.qaCycle === true,
    };
  } catch {
    return null;
  }
}

function formatProactivePrompt({ department, title, goal, acceptanceCriteria, objectiveIds, qaCycle = false }) {
  const criteria = normalizeAcceptanceCriteria(acceptanceCriteria);
  const meta = {
    department: department.name,
    departmentId: department.id,
    title: boundedText(title, 180),
    acceptanceCriteria: criteria,
    objectiveIds: Array.isArray(objectiveIds) ? objectiveIds.slice(0, MAX_OBJECTIVES) : [],
    qaCycle: Boolean(qaCycle),
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
  const fresh = await loadFreshProject(prisma, project.id, project);
  const brief = asRecord(fresh?.brief);
  const ledger = normalizeLedger([...(brief.ledger || []), entry]);
  await prisma.codexProject.update({
    where: { id: project.id },
    data: { brief: { ...brief, ledger } },
  });
  return ledger.at(-1) || null;
}

async function writeObjectives({ prisma, project, objectives, now = new Date() }) {
  if (!prisma?.codexProject?.update || !project?.id) return [];
  const fresh = await loadFreshProject(prisma, project.id, project);
  const brief = asRecord(fresh?.brief);
  const merged = mergeObjectives(brief.objectives, objectives, now);
  await prisma.codexProject.update({
    where: { id: project.id },
    data: { brief: { ...brief, objectives: merged } },
  });
  return merged;
}

module.exports = {
  MAX_LEDGER_ENTRIES,
  MAX_OBJECTIVES,
  MAX_ACCEPTANCE_CRITERIA,
  PROACTIVE_META_MARKER,
  appendLedgerEntry,
  asRecord,
  formatProactivePrompt,
  mergeObjectives,
  normalizeAcceptanceCriteria,
  normalizeLedger,
  normalizeObjectives,
  readProgressContext,
  taskMetaFromPrompt,
  writeObjectives,
};
