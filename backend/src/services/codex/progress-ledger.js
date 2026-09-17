'use strict';

const { mutateProjectBrief } = require('./project-brief-store');

/**
 * Structured, bounded memory for the autonomous company. It lives inside the
 * existing CodexProject.brief JSON column so rollout needs no schema migration.
 */

const MAX_LEDGER_ENTRIES = 120;
const MAX_OBJECTIVES = 12;
const MAX_KEY_RESULTS = 8;
const MAX_OBJECTIVE_REVIEWS = 60;
const MAX_ACCEPTANCE_CRITERIA = 8;
const MAX_SWARM_SPECIALISTS = 12;
const OBJECTIVE_PORTFOLIO_VERSION = 1;
const PROACTIVE_META_MARKER = '[SIRA_PROACTIVE_META]';
const OPEN_FAILURE_OUTCOMES = new Set(['failed', 'blocked']);

class ObjectivePortfolioError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'ObjectivePortfolioError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

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

function normalizeKeyResult(value, index = 0) {
  const source = asRecord(value);
  const title = boundedText(source.title || source.result || source.name, 220);
  if (!title) return null;
  const status = ['not_started', 'on_track', 'at_risk', 'achieved'].includes(source.status)
    ? source.status
    : 'not_started';
  const rawProgress = source.progress == null ? null : Number(source.progress);
  const progress = Number.isFinite(rawProgress)
    ? Math.max(0, Math.min(100, Math.round(rawProgress)))
    : status === 'achieved'
      ? 100
      : null;
  return {
    id: boundedText(source.id, 80) || slug(title) || `key-result-${index + 1}`,
    title,
    metric: boundedText(source.metric, 180) || null,
    baseline: boundedText(source.baseline, 120) || null,
    current: boundedText(source.current, 120) || null,
    target: boundedText(source.target, 120) || null,
    unit: boundedText(source.unit, 60) || null,
    status,
    progress,
    updatedAt: boundedText(source.updatedAt, 40) || null,
  };
}

function normalizeKeyResults(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map(normalizeKeyResult)
    .filter((keyResult) => {
      if (!keyResult || seen.has(keyResult.id)) return false;
      seen.add(keyResult.id);
      return true;
    })
    .slice(0, MAX_KEY_RESULTS);
}

function normalizeObjective(value, index = 0) {
  const source = asRecord(value);
  const title = boundedText(source.title || source.objective, 180);
  if (!title) return null;
  const status = ['active', 'at_risk', 'done', 'paused'].includes(source.status)
    ? source.status
    : 'active';
  const priority = Math.max(
    1,
    Math.min(MAX_OBJECTIVES, Number.parseInt(source.priority, 10) || index + 1),
  );
  const reviewStatus = ['pending', 'approved', 'changes_requested'].includes(source.reviewStatus)
    ? source.reviewStatus
    : 'pending';
  return {
    id: boundedText(source.id, 80) || slug(title) || `objective-${index + 1}`,
    title,
    description: boundedText(source.description, 600) || null,
    ownerDepartmentId: boundedText(source.ownerDepartmentId || source.owner, 100) || null,
    metric: boundedText(source.metric, 180) || null,
    target: boundedText(source.target, 180) || null,
    keyResults: normalizeKeyResults(source.keyResults),
    status,
    priority,
    reviewStatus,
    reviewNote: boundedText(source.reviewNote, 800) || null,
    reviewedBy: boundedText(source.reviewedBy, 120) || null,
    reviewedAt: boundedText(source.reviewedAt, 40) || null,
    createdAt: boundedText(source.createdAt, 40) || null,
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

function normalizeObjectiveReview(value) {
  const source = asRecord(value);
  const revision = Math.max(1, Number.parseInt(source.revision, 10) || 1);
  const createdAt = boundedText(source.createdAt, 40);
  if (!createdAt) return null;
  const changes = asRecord(source.changes);
  return {
    id: boundedText(source.id, 100) || `okr-review-${revision}`,
    revision,
    reviewer: boundedText(source.reviewer, 120) || 'CEO Office',
    source: boundedText(source.source, 80) || 'ceo_review',
    decision: ['approved', 'changes_requested'].includes(source.decision)
      ? source.decision
      : 'approved',
    rationale: boundedText(source.rationale, 1_200) || null,
    objectiveIds: Array.isArray(source.objectiveIds)
      ? source.objectiveIds.map((id) => boundedText(id, 80)).filter(Boolean).slice(0, MAX_OBJECTIVES)
      : [],
    changes: {
      added: Math.max(0, Number(changes.added) || 0),
      removed: Math.max(0, Number(changes.removed) || 0),
      reprioritized: Math.max(0, Number(changes.reprioritized) || 0),
      statusChanged: Math.max(0, Number(changes.statusChanged) || 0),
      keyResultsChanged: Math.max(0, Number(changes.keyResultsChanged) || 0),
    },
    createdAt,
  };
}

function objectiveProgress(objective) {
  const keyResults = normalizeKeyResults(objective?.keyResults);
  const measured = keyResults
    .map((item) => item.progress)
    .filter((value) => Number.isFinite(value));
  if (measured.length) {
    return Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length);
  }
  return objective?.status === 'done' ? 100 : 0;
}

function readObjectivePortfolio(project) {
  const brief = asRecord(project?.brief);
  const metadata = asRecord(brief.okrPortfolio);
  const reviews = (Array.isArray(metadata.reviews) ? metadata.reviews : [])
    .map(normalizeObjectiveReview)
    .filter(Boolean)
    .slice(-MAX_OBJECTIVE_REVIEWS);
  const objectives = normalizeObjectives(brief.objectives);
  const active = objectives.filter((objective) => (
    objective.status === 'active' || objective.status === 'at_risk'
  ));
  return {
    version: OBJECTIVE_PORTFOLIO_VERSION,
    revision: Math.max(0, Number.parseInt(metadata.revision, 10) || 0),
    objectives,
    latestReview: reviews.at(-1) || null,
    summary: {
      total: objectives.length,
      active: active.length,
      atRisk: objectives.filter((objective) => objective.status === 'at_risk').length,
      done: objectives.filter((objective) => objective.status === 'done').length,
      averageProgress: active.length
        ? Math.round(active.reduce((sum, objective) => sum + objectiveProgress(objective), 0) / active.length)
        : objectives.length && objectives.every((objective) => objective.status === 'done')
          ? 100
          : 0,
    },
    reviews,
  };
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
        + `${objective.target ? ` | meta: ${objective.target}` : ''}`
        + `${objective.keyResults.length ? ` | ${objective.keyResults.length} resultados clave` : ''}`,
      );
      for (const keyResult of objective.keyResults.slice(0, 5)) {
        lines.push(
          `  KR ${keyResult.id}: ${keyResult.title}`
          + `${keyResult.progress == null ? '' : ` | avance: ${keyResult.progress}%`}`
          + `${keyResult.target ? ` | meta: ${keyResult.target}` : ''}`,
        );
      }
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
    keyResults: mergeKeyResults(existing.get(item.id)?.keyResults, item.keyResults, now),
    createdAt: existing.get(item.id)?.createdAt || item.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  }));
  return (next.length ? next : [...existing.values()])
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_OBJECTIVES);
}

function mergeKeyResults(current, proposed, now = new Date()) {
  const existing = new Map(normalizeKeyResults(current).map((item) => [item.id, item]));
  const normalized = normalizeKeyResults(proposed);
  if (!normalized.length) return [...existing.values()];
  return normalized.map((item) => ({
    ...existing.get(item.id),
    ...item,
    updatedAt: now.toISOString(),
  }));
}

function objectiveChangeSummary(current, next) {
  const previous = new Map(normalizeObjectives(current).map((item) => [item.id, item]));
  const upcoming = new Map(normalizeObjectives(next).map((item) => [item.id, item]));
  let reprioritized = 0;
  let statusChanged = 0;
  let keyResultsChanged = 0;
  for (const [id, objective] of upcoming) {
    const before = previous.get(id);
    if (!before) continue;
    if (before.priority !== objective.priority) reprioritized += 1;
    if (before.status !== objective.status) statusChanged += 1;
    if (JSON.stringify(before.keyResults) !== JSON.stringify(objective.keyResults)) {
      keyResultsChanged += 1;
    }
  }
  return {
    added: [...upcoming.keys()].filter((id) => !previous.has(id)).length,
    removed: [...previous.keys()].filter((id) => !upcoming.has(id)).length,
    reprioritized,
    statusChanged,
    keyResultsChanged,
  };
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

async function reviewObjectives({
  prisma,
  project,
  objectives,
  reviewer = 'CEO Office',
  source = 'ceo_review',
  decision = 'approved',
  rationale = null,
  expectedRevision = null,
  now = new Date(),
}) {
  if (!prisma?.codexProject?.update || !project?.id) return null;
  const proposed = normalizeObjectives(objectives);
  if (!proposed.length) {
    throw new ObjectivePortfolioError(
      'okr_objectives_required',
      'At least one valid business objective is required.',
    );
  }
  let portfolio = null;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const currentPortfolio = readObjectivePortfolio({ brief });
      if (
        expectedRevision != null
        && Number.parseInt(expectedRevision, 10) !== currentPortfolio.revision
      ) {
        throw new ObjectivePortfolioError(
          'okr_revision_conflict',
          'The OKR portfolio changed after it was loaded.',
          409,
          {
            expectedRevision: Number.parseInt(expectedRevision, 10),
            currentRevision: currentPortfolio.revision,
          },
        );
      }
      const reviewedAt = now.toISOString();
      const normalizedReviewer = boundedText(reviewer, 120) || 'CEO Office';
      const normalizedDecision = decision === 'changes_requested'
        ? 'changes_requested'
        : 'approved';
      const merged = mergeObjectives(brief.objectives, proposed, now).map((objective) => ({
        ...objective,
        reviewStatus: normalizedDecision,
        reviewNote: boundedText(rationale, 800) || objective.reviewNote || null,
        reviewedBy: normalizedReviewer,
        reviewedAt,
      }));
      const revision = currentPortfolio.revision + 1;
      const review = normalizeObjectiveReview({
        id: `okr-review-${revision}`,
        revision,
        reviewer: normalizedReviewer,
        source,
        decision: normalizedDecision,
        rationale,
        objectiveIds: merged.map((objective) => objective.id),
        changes: objectiveChangeSummary(currentPortfolio.objectives, merged),
        createdAt: reviewedAt,
      });
      const reviews = [...currentPortfolio.reviews, review]
        .filter(Boolean)
        .slice(-MAX_OBJECTIVE_REVIEWS);
      const nextBrief = {
        ...brief,
        objectives: merged,
        okrPortfolio: {
          version: OBJECTIVE_PORTFOLIO_VERSION,
          revision,
          reviews,
        },
      };
      portfolio = readObjectivePortfolio({ brief: nextBrief });
      return nextBrief;
    },
  });
  return portfolio;
}

async function reprioritizeObjectives({
  prisma,
  project,
  orderedIds,
  reviewer = 'CEO Office',
  rationale = null,
  expectedRevision = null,
  now = new Date(),
}) {
  const currentPortfolio = readObjectivePortfolio(project);
  const requested = Array.isArray(orderedIds)
    ? [...new Set(orderedIds.map((id) => boundedText(id, 80)).filter(Boolean))]
    : [];
  if (!requested.length) {
    throw new ObjectivePortfolioError(
      'okr_order_required',
      'orderedIds must contain at least one objective id.',
    );
  }
  const byId = new Map(currentPortfolio.objectives.map((objective) => [objective.id, objective]));
  const unknownIds = requested.filter((id) => !byId.has(id));
  if (unknownIds.length) {
    throw new ObjectivePortfolioError(
      'okr_objective_not_found',
      'One or more business objectives do not exist.',
      404,
      { objectiveIds: unknownIds },
    );
  }
  const completeOrder = [
    ...requested,
    ...currentPortfolio.objectives.map((objective) => objective.id)
      .filter((id) => !requested.includes(id)),
  ];
  const objectives = completeOrder.map((id, index) => ({
    ...byId.get(id),
    priority: index + 1,
  }));
  return reviewObjectives({
    prisma,
    project,
    objectives,
    reviewer,
    source: 'ceo_reprioritization',
    decision: 'approved',
    rationale,
    expectedRevision,
    now,
  });
}

async function writeObjectives({
  prisma,
  project,
  objectives,
  reviewer = 'CEO Office',
  source = 'proactive_cycle',
  rationale = 'CEO Office revisó y priorizó la cartera OKR para el siguiente ciclo.',
  now = new Date(),
}) {
  if (!normalizeObjectives(objectives).length) return [];
  const portfolio = await reviewObjectives({
    prisma,
    project,
    objectives,
    reviewer,
    source,
    decision: 'approved',
    rationale,
    now,
  });
  return portfolio?.objectives || [];
}

module.exports = {
  MAX_LEDGER_ENTRIES,
  MAX_OBJECTIVES,
  MAX_KEY_RESULTS,
  MAX_OBJECTIVE_REVIEWS,
  MAX_ACCEPTANCE_CRITERIA,
  MAX_SWARM_SPECIALISTS,
  OBJECTIVE_PORTFOLIO_VERSION,
  PROACTIVE_META_MARKER,
  ObjectivePortfolioError,
  appendLedgerEntry,
  appendLedgerEntryIfMissing,
  asRecord,
  formatProactivePrompt,
  mergeObjectives,
  normalizeKeyResults,
  normalizeAcceptanceCriteria,
  normalizeLedger,
  normalizeSwarm,
  normalizeObjectives,
  objectiveProgress,
  readObjectivePortfolio,
  readProgressContext,
  readOpenFailures,
  findOpenFailure,
  formatProgressContext,
  generateAutoLearnings,
  deterministicLearnings,
  taskFingerprint,
  reprioritizeObjectives,
  reviewObjectives,
  taskMetaFromPrompt,
  writeObjectives,
};
