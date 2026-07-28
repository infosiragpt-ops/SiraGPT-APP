'use strict';

/**
 * Periodic QA for the autonomous coding fleet.
 *
 * Every K successful run-branch merges, this service claims one review range,
 * gives the accumulated base..HEAD diff to the read-only qa_reviewer, and
 * materializes verified findings as durable remediation tasks in the active
 * CodexSwarm DAG (or in a new remediation DAG when no swarm is active).
 *
 * Coordination state is stored in CodexProject.brief.fleetQa so the cadence
 * survives process restarts without another schema migration.
 */

const crypto = require('node:crypto');

const { mutateProjectBrief } = require('./project-brief-store');
const {
  ACTIVE_SWARM_STATUSES,
  CodexSwarmOrchestrator,
  SWARM_STRATEGIES,
  TASK_ROLES,
  TASK_STAGES,
} = require('./swarm-orchestrator');
const agentSdkDefault = require('./agent-sdk');
const { isCodexV2Enabled } = require('./flags');
const projectBudget = require('./project-budget');
const projectSettings = require('./project-settings');
const {
  distributeTasksToPools,
  poolStatus,
} = require('./department-pools');
const { scanBuffer } = require('../security/secret-scanner');
const { redactString } = require('../../utils/secret-redactor');

const DEFAULT_EVERY_MERGES = 5;
const DEFAULT_REVIEW_LEASE_MS = 30 * 60_000;
const MAX_FINDINGS = 20;
const MAX_DIFF_FILES = 80;
const MAX_PATCH_CHARS = 48_000;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const CATEGORIES = new Set(['logic', 'security', 'performance', 'maintainability', 'test']);
const BLOCKED_DIFF_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials|secrets?|tokens?)(?:\/|\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|authorized_keys|known_hosts)(?:\.|$)/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function enabled(env = process.env) {
  const configured = env.CODEX_FLEET_QA_ENABLED;
  return configured != null && String(configured).trim() === '1';
}

function everyMerges(env = process.env) {
  const parsed = Number.parseInt(env.CODEX_FLEET_QA_EVERY_MERGES ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_EVERY_MERGES;
  return Math.max(1, Math.min(100, parsed));
}

function reviewLeaseMs(env = process.env) {
  const parsed = Number.parseInt(env.CODEX_FLEET_QA_LEASE_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REVIEW_LEASE_MS;
  return Math.max(60_000, Math.min(4 * 60 * 60_000, parsed));
}

async function loadFleetProjectSettings({ runner, project, env = process.env }) {
  if (typeof runner?.readFile !== 'function') {
    if (env.NODE_ENV === 'production') {
      return {
        settings: null,
        error: 'fleet_qa_project_settings_store_unavailable',
      };
    }
    return {
      settings: projectSettings.settingsFromProject(project),
      error: null,
    };
  }
  return projectSettings.loadProjectSettings({
    runner,
    projectId: project.id,
    project,
  });
}

async function findTrustPool({ prisma, projectId }) {
  if (!prisma?.codexDepartmentPool?.findFirst) return null;
  const pool = await prisma.codexDepartmentPool.findFirst({
    where: {
      projectId,
      departmentId: 'trust',
    },
  });
  return pool && poolStatus(pool) === 'active' ? pool : null;
}

function normalizePendingEnqueue(value) {
  const source = asRecord(value);
  if (
    !source.id
    || !source.swarmId
    || !SHA_RE.test(String(source.headSha || ''))
  ) {
    return null;
  }
  return {
    id: boundedText(source.id, 100),
    baseSha: SHA_RE.test(String(source.baseSha || '')) ? String(source.baseSha) : null,
    headSha: String(source.headSha),
    mergeCount: Math.max(1, Number.parseInt(source.mergeCount, 10) || 1),
    runId: boundedText(source.runId, 180) || null,
    swarmId: boundedText(source.swarmId, 200),
    taskKeys: Array.isArray(source.taskKeys)
      ? source.taskKeys.map((key) => boundedText(key, 200)).filter(Boolean).slice(0, MAX_FINDINGS)
      : [],
    findings: Math.max(0, Number.parseInt(source.findings, 10) || 0),
    tasksCreated: Math.max(0, Number.parseInt(source.tasksCreated, 10) || 0),
    deferredAt: boundedText(source.deferredAt, 40) || null,
    attempts: Math.max(0, Number.parseInt(source.attempts, 10) || 0),
    lastAttemptAt: boundedText(source.lastAttemptAt, 40) || null,
  };
}

function normalizeState(value) {
  const source = asRecord(value);
  const inFlight = asRecord(source.inFlight);
  const lastReview = asRecord(source.lastReview);
  return {
    baseSha: SHA_RE.test(String(source.baseSha || '')) ? String(source.baseSha) : null,
    lastReviewedSha: SHA_RE.test(String(source.lastReviewedSha || ''))
      ? String(source.lastReviewedSha)
      : null,
    mergesSinceReview: Math.max(0, Number.parseInt(source.mergesSinceReview, 10) || 0),
    inFlight: inFlight.id && SHA_RE.test(String(inFlight.headSha || ''))
      ? {
        id: boundedText(inFlight.id, 100),
        baseSha: SHA_RE.test(String(inFlight.baseSha || '')) ? String(inFlight.baseSha) : null,
        headSha: String(inFlight.headSha),
        mergeCount: Math.max(1, Number.parseInt(inFlight.mergeCount, 10) || 1),
        startedAt: boundedText(inFlight.startedAt, 40) || null,
        runId: boundedText(inFlight.runId, 180) || null,
      }
      : null,
    pendingEnqueue: normalizePendingEnqueue(source.pendingEnqueue),
    lastReview: lastReview.id
      ? {
        id: boundedText(lastReview.id, 100),
        baseSha: SHA_RE.test(String(lastReview.baseSha || '')) ? String(lastReview.baseSha) : null,
        headSha: SHA_RE.test(String(lastReview.headSha || '')) ? String(lastReview.headSha) : null,
        mergeCount: Math.max(0, Number.parseInt(lastReview.mergeCount, 10) || 0),
        findings: Math.max(0, Number.parseInt(lastReview.findings, 10) || 0),
        tasksCreated: Math.max(0, Number.parseInt(lastReview.tasksCreated, 10) || 0),
        swarmId: boundedText(lastReview.swarmId, 200) || null,
        completedAt: boundedText(lastReview.completedAt, 40) || null,
      }
      : null,
    lastError: boundedText(source.lastError, 500) || null,
  };
}

function abortError(signal) {
  const reason = signal?.reason;
  const detail = reason instanceof Error
    ? reason.message
    : boundedText(reason, 300) || 'fleet QA cancelled';
  const error = new Error(detail);
  error.code = reason?.code || 'fleet_qa_cancelled';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function safeDiffPath(value) {
  const file = String(value || '').trim();
  if (
    !file
    || file.startsWith('/')
    || file.includes('\0')
    || file.split('/').includes('..')
    || BLOCKED_DIFF_PATHS.some((pattern) => pattern.test(file))
  ) {
    return null;
  }
  return file.slice(0, 500);
}

function parseChangedFiles(value) {
  const raw = String(value || '');
  const parts = raw.includes('\0') ? raw.split('\0') : raw.split(/\r?\n/);
  const seen = new Set();
  const files = [];
  let excluded = 0;
  for (const part of parts) {
    if (!part) continue;
    const file = safeDiffPath(part);
    if (!file) {
      excluded += 1;
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    if (files.length < MAX_DIFF_FILES) files.push(file);
    else excluded += 1;
  }
  return { files, excluded };
}

async function git(runner, projectId, args, signal = null) {
  throwIfAborted(signal);
  const result = await runner.exec(projectId, ['git', ...args], { signal });
  throwIfAborted(signal);
  if (result?.exitCode !== 0) {
    const error = new Error(
      `fleet_qa_git_failed:${args[0]}:${boundedText(result?.stderr || result?.stdout, 300)}`,
    );
    error.code = 'fleet_qa_git_failed';
    throw error;
  }
  return String(result.stdout || '');
}

async function parentOfMerge({
  runner,
  projectId,
  mergeSha,
  signal = null,
}) {
  if (!SHA_RE.test(String(mergeSha || ''))) return null;
  try {
    const parent = (await git(
      runner,
      projectId,
      ['rev-parse', `${mergeSha}^1`],
      signal,
    )).trim();
    return SHA_RE.test(parent) ? parent : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function collectAccumulatedDiff({
  runner,
  projectId,
  baseSha,
  headSha,
  signal = null,
}) {
  if (!runner?.exec || !projectId || !SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
    const error = new Error('fleet_qa_diff_range_invalid');
    error.code = 'fleet_qa_diff_range_invalid';
    throw error;
  }
  await git(
    runner,
    projectId,
    ['merge-base', '--is-ancestor', baseSha, headSha],
    signal,
  );
  const [stat, names] = await Promise.all([
    git(runner, projectId, ['diff', '--no-ext-diff', '--stat', baseSha, headSha], signal),
    git(
      runner,
      projectId,
      ['diff', '--no-ext-diff', '--name-only', '-z', baseSha, headSha],
      signal,
    ),
  ]);
  const changed = parseChangedFiles(names);
  const patches = [];
  let patchChars = 0;
  let secretOmissions = 0;
  for (const file of changed.files) {
    throwIfAborted(signal);
    if (patchChars >= MAX_PATCH_CHARS) break;
    const raw = await git(runner, projectId, [
      'diff',
      '--no-ext-diff',
      '--unified=3',
      baseSha,
      headSha,
      '--',
      file,
    ], signal);
    const redacted = redactString(raw, {
      maxLen: Math.min(16_000, MAX_PATCH_CHARS - patchChars),
    });
    if (!scanBuffer(redacted, { maxFindings: 1 }).ok) {
      secretOmissions += 1;
      patches.push(`diff -- ${file}\n[PATCH OMITIDO: posible secreto detectado]`);
      patchChars += patches.at(-1).length;
      continue;
    }
    patches.push(redacted);
    patchChars += redacted.length;
  }
  return {
    baseSha,
    headSha,
    stat: redactString(stat, { maxLen: 8_000 }),
    files: changed.files,
    excludedFiles: changed.excluded,
    secretOmissions,
    truncated: patchChars >= MAX_PATCH_CHARS || patches.length < changed.files.length,
    patch: patches.join('\n\n').slice(0, MAX_PATCH_CHARS),
  };
}

function extractJsonObject(value) {
  const raw = String(value || '');
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

function normalizeFindings(value, changedFiles = []) {
  const parsed = Array.isArray(value)
    ? value
    : (asRecord(value).findings || extractJsonObject(value)?.findings);
  if (!Array.isArray(parsed)) return null;
  const allowedFiles = new Set(changedFiles);
  const seen = new Set();
  const findings = [];
  for (const raw of parsed) {
    const source = asRecord(raw);
    const title = boundedText(source.title, 180);
    const file = safeDiffPath(source.file);
    const evidence = redactString(boundedText(source.evidence, 1_000));
    const remediation = redactString(boundedText(
      source.remediation || source.recommendation,
      1_200,
    ));
    if (
      !title
      || !file
      || !allowedFiles.has(file)
      || evidence.length < 8
      || remediation.length < 8
    ) {
      continue;
    }
    const severity = SEVERITIES.has(source.severity) ? source.severity : 'medium';
    const category = CATEGORIES.has(source.category) ? source.category : 'logic';
    const line = Math.max(1, Number.parseInt(source.line, 10) || 1);
    const key = `${file}:${line}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      title,
      severity,
      category,
      file,
      line,
      evidence,
      remediation,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

async function runQaReviewer({
  project,
  diff,
  mergeCount,
  deps = {},
  env = process.env,
}) {
  const sdk = deps.agentSdk || agentSdkDefault;
  const task = [
    `Revisa únicamente el diff acumulado de ${mergeCount} merge(s), desde ${diff.baseSha} hasta ${diff.headSha}.`,
    'Valida cada hallazgo contra el código real y ejecuta type_check/dev_server_check cuando corresponda.',
    'No corrijas archivos ni propongas refactors especulativos.',
    'La respuesta final debe ser SOLO JSON válido con este contrato:',
    '{"findings":[{"title":"...","severity":"critical|high|medium|low","category":"logic|security|performance|maintainability|test","file":"ruta/cambiada","line":1,"evidence":"hecho verificable","remediation":"cambio mínimo y criterio comprobable"}]}.',
    'Si no existe ningún hallazgo accionable, responde {"findings":[]}.',
  ].join(' ');
  const context = [
    `Diffstat:\n${diff.stat || '(sin diffstat)'}`,
    `Archivos cambiados seguros:\n${diff.files.map((file) => `- ${file}`).join('\n') || '(ninguno)'}`,
    diff.excludedFiles || diff.secretOmissions
      ? `Omisiones de seguridad: ${diff.excludedFiles} ruta(s), ${diff.secretOmissions} parche(s).`
      : null,
    diff.truncated ? 'El parche fue truncado; abre los archivos listados antes de concluir.' : null,
    `Parche acumulado:\n${diff.patch || '(sin contenido textual)'}`,
  ].filter(Boolean).join('\n\n');
  return sdk.runSubagent({
    name: 'qa_reviewer',
    task,
    context,
    effort: 'high',
    deps: {
      runner: deps.runner,
      project: project.id,
      llmTurn: deps.llmTurn,
      env,
      tier: deps.tier || null,
      model: deps.model || null,
      signal: deps.signal,
      onUsage: deps.onUsage,
      emitAction: deps.emitAction,
    },
  });
}

function findingTaskKey(headSha, finding, ordinal = 0) {
  const digest = crypto.createHash('sha256')
    .update([
      headSha,
      finding.file,
      finding.line,
      finding.category,
      finding.severity,
      ordinal,
    ].join(':'))
    .digest('hex')
    .slice(0, 12);
  return `fleet-qa-${String(headSha).slice(0, 10)}-${digest}`;
}

function priorityForSeverity(severity) {
  return {
    critical: 100,
    high: 80,
    medium: 60,
    low: 40,
  }[severity] || 60;
}

function tasksFromFindings({
  reviewId,
  findings,
  parentTaskKey = null,
  baseSha,
  headSha,
}) {
  return findings.map((finding, index) => ({
    key: findingTaskKey(headSha, finding, index),
    title: `[QA ${finding.severity.toUpperCase()}] ${finding.title}`.slice(0, 300),
    role: TASK_ROLES.INTEGRATOR,
    stage: TASK_STAGES.WORK,
    priority: priorityForSeverity(finding.severity),
    dependsOn: parentTaskKey ? [parentTaskKey] : [],
    maxAttempts: finding.severity === 'critical' ? 5 : 3,
    input: {
      source: 'fleet_qa',
      agent: 'debugger',
      departmentId: 'trust',
      objective: [
        `${finding.remediation}`,
        `Hallazgo verificado en ${finding.file}:${finding.line}: ${finding.evidence}`,
        'Aplica el cambio mínimo, agrega o ajusta la prueba de regresión y ejecuta los gates relevantes.',
      ].join('\n'),
      qaFinding: finding,
      qaRange: { baseSha, headSha },
      qaReviewId: reviewId,
    },
  }));
}

function taskOwnsRun(task, run) {
  const result = asRecord(task?.result);
  return Boolean(
    run?.planRunId
    && result.planRunId
    && String(result.planRunId) === String(run.planRunId),
  );
}

async function maybeEnqueueSwarm({ swarmId, deps, env }) {
  const enqueue = deps.enqueueSwarm || (
    env.REDIS_URL && isCodexV2Enabled(env)
      ? require('./swarm-runner').enqueueSwarm
      : null
  );
  if (typeof enqueue !== 'function') {
    return { enqueued: false, error: 'swarm_queue_unavailable' };
  }
  try {
    await enqueue({ swarmId });
    return { enqueued: true, error: null };
  } catch (error) {
    return {
      enqueued: false,
      error: boundedText(error?.message || String(error), 300) || 'enqueue_failed',
    };
  }
}

async function currentFleetQaState({ prisma, project }) {
  const where = project?.userId
    ? { id: project.id, userId: project.userId }
    : { id: project?.id };
  const current = prisma?.codexProject?.findFirst
    ? await prisma.codexProject.findFirst({ where })
    : await prisma?.codexProject?.findUnique?.({ where: { id: project?.id } });
  return normalizeState(current?.brief?.fleetQa);
}

async function deferReviewForEnqueue({
  prisma,
  project,
  review,
  findings,
  materialized,
  error,
  now,
}) {
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const state = normalizeState(brief.fleetQa);
      if (state.inFlight?.id !== review.id) return brief;
      const at = now().toISOString();
      return {
        ...brief,
        fleetQa: {
          ...state,
          inFlight: null,
          pendingEnqueue: {
            id: review.id,
            baseSha: review.baseSha,
            headSha: review.headSha,
            mergeCount: review.mergeCount,
            runId: review.runId || null,
            swarmId: materialized.swarmId,
            taskKeys: materialized.taskKeys,
            findings: findings.length,
            tasksCreated: materialized.tasksCreated,
            deferredAt: at,
            attempts: 0,
            lastAttemptAt: null,
          },
          lastError: error
            ? boundedText(error?.message || String(error), 500) || 'enqueue_failed'
            : null,
        },
      };
    },
  });
}

async function recordPendingEnqueueFailure({
  prisma,
  project,
  pending,
  error,
  now,
}) {
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const state = normalizeState(brief.fleetQa);
      if (state.pendingEnqueue?.id !== pending.id) return brief;
      return {
        ...brief,
        fleetQa: {
          ...state,
          pendingEnqueue: {
            ...state.pendingEnqueue,
            attempts: state.pendingEnqueue.attempts + 1,
            lastAttemptAt: now().toISOString(),
          },
          lastError: boundedText(error?.message || String(error), 500) || 'enqueue_failed',
        },
      };
    },
  });
}

async function materializeFindings({
  prisma,
  project,
  run,
  reviewId,
  findings,
  baseSha,
  headSha,
  trustPool: providedTrustPool = null,
  deps = {},
}) {
  throwIfAborted(deps.signal);
  if (!findings.length) {
    return { swarmId: null, tasksCreated: 0, taskKeys: [], enqueued: false };
  }
  const orchestrator = deps.orchestrator || new CodexSwarmOrchestrator({ prisma });
  let active = await prisma.codexSwarm.findFirst({
    where: {
      projectId: project.id,
      status: { in: Array.from(ACTIVE_SWARM_STATUSES) },
    },
    include: { tasks: { orderBy: { ordinal: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => null);
  const parent = active?.tasks?.find((task) => taskOwnsRun(task, run)) || null;
  let tasks = tasksFromFindings({
    reviewId,
    findings,
    parentTaskKey: parent?.key || null,
    baseSha,
    headSha,
  });
  const trustPool = providedTrustPool || await findTrustPool({
    prisma,
    projectId: project.id,
  });
  throwIfAborted(deps.signal);
  if (!trustPool) {
    throw new Error('fleet_qa_trust_pool_unavailable');
  }
  tasks = distributeTasksToPools({ tasks, pools: [trustPool] }).tasks;

  let result;
  if (active) {
    throwIfAborted(deps.signal);
    try {
      result = await orchestrator.appendTasks({ swarmId: active.id, tasks });
    } catch (error) {
      if (error?.code !== 'codex_swarm_terminal') throw error;
      active = null;
    }
  }
  if (!active) {
    throwIfAborted(deps.signal);
    const created = await orchestrator.createSwarm({
      userId: project.userId,
      projectId: project.id,
      name: `Remediación QA ${headSha.slice(0, 12)}`,
      strategy: SWARM_STRATEGIES.DAG,
      tasks: tasks.map((task) => ({ ...task, dependsOn: [] })),
      maxConcurrency: Math.min(4, Math.max(1, tasks.length)),
      maxConcurrentWriters: 1,
      metadata: {
        source: 'fleet_qa',
        qaReviewId: reviewId,
        qaRange: { baseSha, headSha },
        objective: 'Resolver hallazgos verificados del diff acumulado y conservar gates verdes.',
      },
    });
    result = {
      swarm: created,
      appended: created.tasks || tasks,
      replayed: false,
    };
  }
  const swarmId = result.swarm.id;
  return {
    swarmId,
    tasksCreated: result.appended?.length ?? tasks.length,
    taskKeys: tasks.map((task) => task.key),
    enqueued: false,
    enqueueError: null,
  };
}

async function claimReview({
  prisma,
  project,
  mergeSha,
  parentSha,
  runId,
  env,
  now,
  idFactory,
}) {
  let decision = { action: 'not_due' };
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const state = normalizeState(brief.fleetQa);
      const at = now();
      const inFlightStartedAt = state.inFlight?.startedAt
        ? new Date(state.inFlight.startedAt).getTime()
        : 0;
      const stale = Boolean(
        state.inFlight
        && (!Number.isFinite(inFlightStartedAt)
          || at.getTime() - inFlightStartedAt >= reviewLeaseMs(env)),
      );
      const mergesSinceReview = state.mergesSinceReview + 1;
      const baseSha = state.baseSha || state.lastReviewedSha || parentSha;
      if (state.inFlight && !stale) {
        decision = { action: 'in_flight', reviewId: state.inFlight.id };
        return {
          ...brief,
          fleetQa: {
            ...state,
            baseSha,
            mergesSinceReview,
          },
        };
      }
      if (!baseSha || mergesSinceReview < everyMerges(env)) {
        decision = { action: 'not_due', mergesSinceReview };
        return {
          ...brief,
          fleetQa: {
            ...state,
            baseSha,
            mergesSinceReview,
            inFlight: stale ? null : state.inFlight,
          },
        };
      }
      const review = {
        id: idFactory(),
        baseSha,
        headSha: mergeSha,
        mergeCount: mergesSinceReview,
        startedAt: at.toISOString(),
        runId: runId || null,
      };
      decision = { action: 'claimed', review };
      return {
        ...brief,
        fleetQa: {
          ...state,
          baseSha,
          mergesSinceReview,
          inFlight: review,
          lastError: null,
        },
      };
    },
  });
  return decision;
}

async function completeReview({
  prisma,
  project,
  review,
  findings = null,
  findingCount = null,
  materialized,
  now,
}) {
  const completedFindings = Number.isFinite(Number(findingCount))
    ? Math.max(0, Number(findingCount))
    : Array.isArray(findings)
      ? findings.length
      : 0;
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const state = normalizeState(brief.fleetQa);
      const ownsInFlight = state.inFlight?.id === review.id;
      const ownsPendingEnqueue = state.pendingEnqueue?.id === review.id;
      if (!ownsInFlight && !ownsPendingEnqueue) return brief;
      const remaining = Math.max(0, state.mergesSinceReview - review.mergeCount);
      return {
        ...brief,
        fleetQa: {
          ...state,
          baseSha: review.headSha,
          lastReviewedSha: review.headSha,
          mergesSinceReview: remaining,
          inFlight: null,
          pendingEnqueue: null,
          lastError: materialized.enqueueError || null,
          lastReview: {
            id: review.id,
            baseSha: review.baseSha,
            headSha: review.headSha,
            mergeCount: review.mergeCount,
            findings: completedFindings,
            tasksCreated: materialized.tasksCreated,
            swarmId: materialized.swarmId,
            completedAt: now().toISOString(),
          },
        },
      };
    },
  });
}

async function retryPendingEnqueue({
  prisma,
  project,
  deps,
  env,
  now,
}) {
  const state = await currentFleetQaState({ prisma, project });
  const pending = state.pendingEnqueue;
  if (!pending) return null;
  throwIfAborted(deps.signal);
  const queue = await maybeEnqueueSwarm({
    swarmId: pending.swarmId,
    deps,
    env,
  });
  throwIfAborted(deps.signal);
  if (!queue.enqueued) {
    const error = new Error(queue.error || 'swarm_queue_unavailable');
    await recordPendingEnqueueFailure({
      prisma,
      project,
      pending,
      error,
      now,
    });
    return {
      action: 'review_deferred',
      reviewId: pending.id,
      baseSha: pending.baseSha,
      headSha: pending.headSha,
      mergeCount: pending.mergeCount,
      findings: pending.findings,
      tasksCreated: pending.tasksCreated,
      swarmId: pending.swarmId,
      taskKeys: pending.taskKeys,
      enqueued: false,
      enqueueError: error.message,
      error: error.message,
      retriedEnqueue: true,
    };
  }
  const materialized = {
    swarmId: pending.swarmId,
    tasksCreated: pending.tasksCreated,
    taskKeys: pending.taskKeys,
    enqueued: true,
    enqueueError: null,
  };
  await completeReview({
    prisma,
    project,
    review: pending,
    findingCount: pending.findings,
    materialized,
    now,
  });
  return {
    action: 'reviewed',
    reviewId: pending.id,
    baseSha: pending.baseSha,
    headSha: pending.headSha,
    mergeCount: pending.mergeCount,
    findings: pending.findings,
    ...materialized,
    retriedEnqueue: true,
  };
}

async function failReview({
  prisma,
  project,
  review,
  error,
}) {
  await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief) => {
      const state = normalizeState(brief.fleetQa);
      if (state.inFlight?.id !== review.id) return brief;
      return {
        ...brief,
        fleetQa: {
          ...state,
          inFlight: null,
          lastError: boundedText(error?.message || String(error), 500) || 'fleet_qa_failed',
        },
      };
    },
  });
}

async function reviewMergedCheckpoint({
  prisma,
  project,
  run,
  mergeSha,
  deps = {},
  env = process.env,
  now = () => new Date(),
}) {
  if (!enabled(env)) return { action: 'disabled' };
  throwIfAborted(deps.signal);
  if (
    !prisma?.codexProject
    || !project?.id
    || !project?.userId
    || !deps.runner?.exec
    || !SHA_RE.test(String(mergeSha || ''))
  ) {
    return { action: 'skipped_invalid_context' };
  }
  const settingsState = await loadFleetProjectSettings({
    runner: deps.runner,
    project,
    env,
  });
  if (settingsState.error) {
    return {
      action: 'budget_blocked',
      reason: settingsState.error,
      dailyBudgetUsd: null,
      costTodayUsd: null,
    };
  }
  const checkProjectBudget = (phase) => (
    deps.checkProjectBudget
      ? deps.checkProjectBudget({
        prisma,
        project,
        settings: settingsState.settings,
        env,
        now: now(),
        phase,
      })
      : projectBudget.checkProjectBudget({
        prisma,
        projectId: project.id,
        settings: settingsState.settings,
        env,
        now: now(),
      })
  );
  const checkBudget = (phase) => (
    deps.checkBudget
      ? deps.checkBudget({
        prisma,
        project,
        env,
        now: now(),
        phase,
      })
      : projectBudget.checkCompanyDailyBudget({
        prisma,
        project,
        env,
        now: now(),
      })
  );
  const [projectBudgetStatus, budget] = await Promise.all([
    checkProjectBudget('preflight'),
    checkBudget('preflight'),
  ]);
  if (!projectBudgetStatus?.allowed || !budget?.allowed) {
    const blocked = !projectBudgetStatus?.allowed ? projectBudgetStatus : budget;
    return {
      action: 'budget_blocked',
      reason: blocked?.reason || 'budget_query_failed',
      dailyBudgetUsd: blocked?.dailyBudgetUsd ?? null,
      costTodayUsd: blocked?.costTodayUsd ?? null,
    };
  }
  const trustPool = await findTrustPool({ prisma, projectId: project.id });
  if (!trustPool) {
    return {
      action: 'budget_blocked',
      reason: 'fleet_qa_trust_pool_unavailable',
      dailyBudgetUsd: null,
      costTodayUsd: null,
    };
  }
  const checkTrustBudget = (phase) => (
    deps.checkPoolBudget
      ? deps.checkPoolBudget({
        prisma,
        project,
        departmentPoolId: trustPool.id,
        env,
        now: now(),
        phase,
      })
      : projectBudget.checkDepartmentPoolBudget({
        prisma,
        projectId: project.id,
        departmentPoolId: trustPool.id,
        env,
        now: now(),
      })
  );
  const trustBudget = await checkTrustBudget('preflight');
  if (!trustBudget?.allowed) {
    return {
      action: 'budget_blocked',
      reason: trustBudget?.reason || 'fleet_qa_trust_budget_query_failed',
      dailyBudgetUsd: trustBudget?.dailyBudgetUsd ?? null,
      costTodayUsd: trustBudget?.costTodayUsd ?? null,
      departmentPoolId: trustPool.id,
    };
  }
  const retried = await retryPendingEnqueue({
    prisma,
    project,
    deps,
    env,
    now,
  });
  if (retried?.action === 'review_deferred' || retried?.headSha === mergeSha) {
    return retried;
  }
  throwIfAborted(deps.signal);
  const parentSha = await parentOfMerge({
    runner: deps.runner,
    projectId: project.id,
    mergeSha,
    signal: deps.signal,
  });
  const decision = await claimReview({
    prisma,
    project,
    mergeSha,
    parentSha,
    runId: run?.id || null,
    env,
    now,
    idFactory: deps.idFactory || crypto.randomUUID,
  });
  if (decision.action !== 'claimed') return decision;

  const { review } = decision;
  try {
    const diff = await collectAccumulatedDiff({
      runner: deps.runner,
      projectId: project.id,
      baseSha: review.baseSha,
      headSha: review.headSha,
      signal: deps.signal,
    });
    const reviewerDeps = {
      ...deps,
      onUsage: async (usage) => {
        throwIfAborted(deps.signal);
        if (typeof deps.onUsage !== 'function') {
          const error = new Error('fleet_qa_usage_accounting_unavailable');
          error.code = 'fleet_qa_usage_accounting_unavailable';
          throw error;
        }
        const accounted = await deps.onUsage(usage, {
          departmentPoolId: trustPool.id,
          reviewId: review.id,
        });
        throwIfAborted(deps.signal);
        const [runtimeProjectBudget, runtimeBudget, runtimeTrustBudget] = await Promise.all([
          checkProjectBudget('runtime'),
          checkBudget('runtime'),
          checkTrustBudget('runtime'),
        ]);
        if (
          !runtimeProjectBudget?.allowed
          || !runtimeBudget?.allowed
          || !runtimeTrustBudget?.allowed
        ) {
          const blocked = !runtimeProjectBudget?.allowed
            ? runtimeProjectBudget
            : !runtimeBudget?.allowed
              ? runtimeBudget
              : runtimeTrustBudget;
          const error = new Error(
            blocked?.reason === 'daily_budget_exceeded'
              ? 'fleet_qa_daily_budget_exceeded'
              : `fleet_qa_budget_check_failed:${blocked?.reason || 'budget_query_failed'}`,
          );
          error.code = blocked?.reason === 'daily_budget_exceeded'
            ? 'fleet_qa_daily_budget_exceeded'
            : 'fleet_qa_budget_check_failed';
          error.budget = blocked;
          throw error;
        }
        return accounted;
      },
    };
    const outcome = await runQaReviewer({
      project,
      diff,
      mergeCount: review.mergeCount,
      deps: reviewerDeps,
      env,
    });
    throwIfAborted(deps.signal);
    if (!outcome?.ok) {
      throw new Error(boundedText(outcome?.result, 500) || 'fleet_qa_reviewer_failed');
    }
    const findings = normalizeFindings(outcome.result, diff.files);
    if (!findings) throw new Error('fleet_qa_invalid_review_json');
    if (findings.length) {
      const [
        materializeProjectBudget,
        materializeBudget,
        materializeTrustBudget,
      ] = await Promise.all([
        checkProjectBudget('materialize'),
        checkBudget('materialize'),
        checkTrustBudget('materialize'),
      ]);
      if (
        !materializeProjectBudget?.allowed
        || !materializeBudget?.allowed
        || !materializeTrustBudget?.allowed
      ) {
        const blocked = !materializeProjectBudget?.allowed
          ? materializeProjectBudget
          : !materializeBudget?.allowed
            ? materializeBudget
            : materializeTrustBudget;
        const error = new Error(
          `fleet_qa_materialize_budget_blocked:${blocked?.reason || 'budget_query_failed'}`,
        );
        await failReview({ prisma, project, review, error });
        return {
          action: 'review_deferred',
          reviewId: review.id,
          headSha: review.headSha,
          error: error.message,
          swarmId: null,
          tasksCreated: 0,
        };
      }
    }
    const materialized = await materializeFindings({
      prisma,
      project,
      run,
      reviewId: review.id,
      findings,
      baseSha: review.baseSha,
      headSha: review.headSha,
      trustPool,
      deps,
    });
    if (findings.length) {
      await deferReviewForEnqueue({
        prisma,
        project,
        review,
        findings,
        materialized,
        error: null,
        now,
      });
      const delivery = await retryPendingEnqueue({
        prisma,
        project,
        deps,
        env,
        now,
      });
      if (!delivery) throw new Error('fleet_qa_pending_enqueue_not_persisted');
      return delivery;
    }
    await completeReview({
      prisma,
      project,
      review,
      findings,
      materialized,
      now,
    });
    return {
      action: 'reviewed',
      reviewId: review.id,
      baseSha: review.baseSha,
      headSha: review.headSha,
      mergeCount: review.mergeCount,
      findings: findings.length,
      ...materialized,
    };
  } catch (error) {
    await failReview({ prisma, project, review, error });
    return {
      action: 'review_failed',
      reviewId: review.id,
      error: boundedText(error?.message || String(error), 500),
    };
  }
}

module.exports = {
  DEFAULT_EVERY_MERGES,
  DEFAULT_REVIEW_LEASE_MS,
  MAX_FINDINGS,
  MAX_DIFF_FILES,
  MAX_PATCH_CHARS,
  collectAccumulatedDiff,
  enabled,
  everyMerges,
  materializeFindings,
  normalizeFindings,
  normalizeState,
  parseChangedFiles,
  reviewMergedCheckpoint,
  runQaReviewer,
  safeDiffPath,
  tasksFromFindings,
};
