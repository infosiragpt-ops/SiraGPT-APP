'use strict';

const crypto = require('crypto');
const { buildAgentTaskPlan } = require('../agents/agent-task-plan');
const { buildExecutionProfile } = require('../agents/agentic-execution-profile');
const { buildUserIntentAlignmentProfile } = require('../agents/user-intent-alignment');
const codexRunStore = require('./codex-run-store');
const streamCache = require('../stream-cache');
const { cloneProject } = require('../agents/clone-project-tool');

const PHASES = ['plan', 'execute', 'verify', 'ship'];

/**
 * Detect if the user's text is a code/repo/clone task intent.
 * Heavily weighted for clone-and-deliver scenarios (open-webui, repo).
 */
function detectCodeTaskIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return { isCodeTask: false, confidence: 0 };

  // Clone patterns get boosted confidence because the tools now exist
  const isCloneRequest = /\b(?:clona|clonar|clone|descarga|download|get|dame|trae|baja)\b/i.test(t)
    && /github\.com|gitlab\.com/i.test(t);

  if (isCloneRequest) {
    return { isCodeTask: true, confidence: 0.98, subtype: 'clone_repo' };
  }

  const patterns = [
    /\b(fix|refactor|implement|debug|bug|pull request|commit|github|repo(?:sitory)?|codex|claude code|openclaw|cursor|npm test|eslint)\b/i,
    /\b(arregla|corrige|programa|mejora|implementa|sube|pushea|env[ií]a|vigila|monitorea|despliega|prueba)\b/i,
    /\b(creates?|write|genera|implementa).{0,40}\b(api|endpoint|component|funci[oó]n|script|module|class|software|proyecto|repo)\b/i,
    /\b(push|merge|deploy|ci)\b/i,
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i,
    /\b(siraGPT|local|main|green status|estatus verde)\b/i,
  ];
  const hits = patterns.filter((re) => re.test(t)).length;
  if (hits >= 2) return { isCodeTask: true, confidence: 0.9 };
  if (hits === 1) return { isCodeTask: true, confidence: 0.75 };
  return { isCodeTask: false, confidence: 0 };
}

/**
 * Extract a clone-friendly repo URL from user text.
 * Returns null if no clean URL pattern is found.
 */
function extractRepoUrl(text) {
  const t = String(text || '').trim();
  const m = /(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)[^\s)]+/i.exec(t);
  if (m) return m[0].replace(/\.git$/, '').replace(/\/$/, '');
  return null;
}

// "Clona y sírvelo": el usuario no solo quiere el repo, quiere la web
// funcionando (p. ej. "trabajar en <url> y dame la web en local 5000").
const RUN_REQUEST_RE = /(arranca(?:r|me|lo)?|levanta(?:r|me|lo)?|ejecuta(?:r|me|lo)?|corre(?:r|lo|me)?|sirve(?:r|me|lo)?|despliega(?:r|lo|me)?|pon(?:lo)?\s+en\s+marcha|dame\s+la\s+web|p[aá]same\s+la\s+web|en\s+local|localhost|127\.0\.0\.1|\bpuerto\b|\bpreview\b|\brun\b|\bstart\b|dev\s*server|funcionando)/i;

/**
 * Detecta si el pedido de clonado incluye "y déjalo corriendo" y en qué
 * puerto. Puertos aceptados: `localhost:5000`, `127.0.0.1:5000`,
 * `puerto 5000`, `port: 5000`, `en local 5000`. Rango válido 1024-65535
 * (el runner no puede bindear privilegiados); fuera de rango se ignora el
 * número y el pool asigna uno. Determinista, sin LLM (AGENTS.md §3).
 */
function detectRunRequest(text) {
  const t = String(text || '');
  if (!t.trim()) return { wantsRun: false, requestedPort: null };
  let requestedPort = null;
  const portMatch = /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/i.exec(t)
    || /(?:puerto|port)\s*(?:local)?\s*[:=]?\s*(\d{2,5})\b/i.exec(t)
    || /\ben\s+local\s+(\d{2,5})\b/i.exec(t);
  if (portMatch) {
    const n = Number.parseInt(portMatch[1], 10);
    if (n >= 1024 && n <= 65535) requestedPort = n;
  }
  return { wantsRun: requestedPort != null || RUN_REQUEST_RE.test(t), requestedPort };
}

/** Runner-side project id for a chat-triggered clone (PROJECT_ID_RE-safe). */
function runnerProjectIdFor(runId) {
  const cleaned = String(runId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56);
  return `run-${cleaned || crypto.randomUUID()}`;
}

// ── Dependencias lazy: el orquestador debe seguir cargando en tests y en
// despliegues sin el sidecar del runner. Todo fallo de estas piezas se
// traduce a un evento con código estable, nunca a un crash del require.
function defaultRunnerClient() {
  // Mismo cliente que usan las rutas /api/codex/* (respeta el provider).
  // eslint-disable-next-line global-require
  const { createSandboxClient } = require('./sandbox-provider');
  return createSandboxClient();
}

function defaultPreviewTokenFor() {
  // eslint-disable-next-line global-require
  const { previewTokenFor } = require('../code/preview-proxy');
  return previewTokenFor;
}

async function defaultGithubAccessToken(userId) {
  try {
    // eslint-disable-next-line global-require
    const { accessToken } = await require('../github/github-api.service').resolveUserToken(userId);
    const token = String(accessToken || '').trim();
    return token || null;
  } catch {
    return null; // sin GitHub conectado → path público, como la ruta /projects/clone
  }
}

async function defaultGithubRepoMeta(userId, owner, repo) {
  try {
    // eslint-disable-next-line global-require
    return await require('../github/github-api.service').getRepository(userId, owner, repo);
  } catch {
    return null; // sin metadatos → rama por defecto 'main', fetch falla ruidoso si no existe
  }
}

/** Código de error estable (AGENTS.md §16) para fallos de la cadena preview. */
function previewErrorCode(err) {
  const bodyError = err && err.body && typeof err.body === 'object' ? String(err.body.error || '') : '';
  if (bodyError === 'dev_pool_exhausted' || err?.status === 429) return 'dev_pool_exhausted';
  if (bodyError === 'invalid_requested_port') return 'invalid_requested_port';
  if (err && typeof err.code === 'string' && err.code) return err.code;
  if (err && err.status === 0) return 'runner_unreachable';
  if (bodyError) return bodyError.slice(0, 64);
  return 'preview_failed';
}

const PREVIEW_READY_TIMEOUT_MS = 6 * 60 * 1000;
const PREVIEW_POLL_INTERVAL_MS = 2_500;

/**
 * Cadena "clona y sírvelo": clona el repo en el workspace CloudAgent del
 * runner (nunca en máquina de usuario, AGENTS.md §6), arranca install+dev
 * (con el puerto pedido si lo hay) y emite la URL de preview tokenizada que
 * ya proxifica /api/codex/projects/:id/preview/:token/app/.
 */
async function runCloneAndPreview({
  runId,
  userId,
  repoUrl,
  branch = 'main',
  requestedPort = null,
  emit,
  setPhase,
}, deps = {}) {
  const runner = deps.runner || defaultRunnerClient();
  const previewTokenFor = deps.previewTokenFor || defaultPreviewTokenFor();
  const githubAccessTokenFor = deps.githubAccessTokenFor || defaultGithubAccessToken;
  const githubRepoMetaFor = deps.githubRepoMetaFor || defaultGithubRepoMeta;
  // eslint-disable-next-line global-require
  const harness = deps.harness || require('./opencode-harness');
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

  const repository = harness.parsePublicGithubRepo(/^https?:\/\//i.test(repoUrl) ? repoUrl : `https://${repoUrl}`);
  const accessToken = await githubAccessTokenFor(userId);
  const meta = accessToken ? await githubRepoMetaFor(userId, repository.owner, repository.repo) : null;
  const baseBranch = (meta && meta.defaultBranch) || branch || 'main';

  const projectId = runnerProjectIdFor(runId);
  emit({ type: 'clone_start', url: repository.webUrl, target: 'runner' });
  const cloned = await harness.clonePublicRepo({
    runner,
    projectId,
    repoUrl: repository.cloneUrl,
    branch: baseBranch,
    accessToken,
    fetchTimeoutMs: 300_000,
  });
  codexRunStore.updateRun(runId, { clonePath: cloned.workspacePath });
  emit({
    type: 'clone_success',
    path: cloned.workspacePath,
    commitSha: cloned.commitSha,
    branch: cloned.sourceBranch,
    authenticated: cloned.authenticated === true,
  });

  await setPhase('execute', 55, { subphase: 'installing' });
  emit({ type: 'preview_installing', projectId });

  let token;
  try {
    token = previewTokenFor({ projectId, userId });
  } catch (err) {
    const e = new Error('preview token unavailable: falta el secreto de preview en el servidor');
    e.code = 'preview_token_unavailable';
    e.cause = err;
    throw e;
  }
  const previewUrl = `/api/codex/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(token)}/app/`;

  const start = await runner.startDev(projectId, {
    basePath: previewUrl,
    ...(requestedPort != null ? { requestedPort } : {}),
  });
  const port = Number.isInteger(start?.port) ? start.port : requestedPort;
  emit({ type: 'preview_starting', projectId, port });

  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
  for (;;) {
    const st = await runner.devStatus(projectId).catch(() => null);
    if (st && st.ready === true) break;
    if (st && st.state === 'error') {
      const e = new Error(`preview start failed: ${String(st.error || 'error del dev server').slice(0, 300)}`);
      e.code = 'preview_start_failed';
      throw e;
    }
    if (!st || st.state === 'stopped') {
      const e = new Error('preview evicted: el runner liberó el slot antes de estar listo');
      e.code = 'preview_evicted';
      throw e;
    }
    if (Date.now() > deadline) {
      const e = new Error('preview timeout: install+arranque superó el límite; reintenta o usa un repo más ligero');
      e.code = 'preview_timeout';
      throw e;
    }
    await sleep(PREVIEW_POLL_INTERVAL_MS);
  }

  codexRunStore.updateRun(runId, { previewUrl, previewPort: port, previewProjectId: projectId });
  emit({ type: 'preview_ready', url: previewUrl, port, projectId });
  return { projectId, port, previewUrl };
}

function createRunRecord(params = {}) {
  const runId = params.runId || crypto.randomUUID();
  return codexRunStore.writeRun({
    runId,
    userId: params.userId,
    chatId: params.chatId || null,
    goal: params.goal,
    repository: params.repository || null,
    branch: params.branch || 'main',
    status: 'queued',
    phase: 'plan',
    percent: 0,
    taskId: params.taskId || null,
    events: [{ type: 'run_created', goal: params.goal }],
  });
}

async function touchStreamProgress(userId, chatId, progress) {
  if (!userId || !chatId) return;
  try {
    await streamCache.updateAgentProgress(userId, chatId, progress);
  } catch {
    /* best-effort */
  }
}

async function runCodexPipeline(params = {}, deps = {}) {
  const {
    runId,
    userId,
    chatId,
    goal,
    repository = null,
    branch = 'main',
    taskId = null,
    onEvent = null,
  } = params;

  const emit = (event) => {
    codexRunStore.appendEvent(runId, event);
    if (typeof onEvent === 'function') onEvent(event);
  };

  const setPhase = async (phase, percent, extra = {}) => {
    codexRunStore.updateRun(runId, { phase, percent, status: 'running', ...extra });
    await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase, percent });
    emit({ type: 'phase', phase, percent, ...extra });
  };

  try {
    await setPhase('plan', 5);

    // Detect if this is a clone request — if so, execute it directly
    const intent = detectCodeTaskIntent(goal || '');
    const repoUrl = extractRepoUrl(goal || '');

    if (intent.subtype === 'clone_repo' && repoUrl) {
      // "Clona y dame la web (en local 5000)": además del clon, el usuario
      // pide la app corriendo. Solo con acceso CloudAgent (misma puerta que
      // /api/codex/*): el clon ocurre en el workspace del runner, se arranca
      // install+dev con el puerto pedido y se entrega la URL de preview.
      const runRequest = detectRunRequest(goal);
      if (runRequest.wantsRun) {
        if (params.allowRun === true) {
          await setPhase('execute', 35, { subphase: 'cloning' });
          try {
            const preview = await runCloneAndPreview({
              runId,
              userId,
              repoUrl,
              branch,
              requestedPort: runRequest.requestedPort,
              emit,
              setPhase,
            }, deps);
            await setPhase('verify', 75);
            emit({ type: 'verify', ok: true, detail: `Web lista en el puerto ${preview.port ?? 'asignado'}` });
            await setPhase('ship', 90);
            codexRunStore.updateRun(runId, { status: 'completed', phase: 'done', percent: 100 });
            await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase: 'done', percent: 100, previewUrl: preview.previewUrl });
            emit({ type: 'done', runId, previewUrl: preview.previewUrl, port: preview.port, projectId: preview.projectId });
            return codexRunStore.readRun(runId);
          } catch (err) {
            const code = previewErrorCode(err);
            const message = String(err?.details?.detail || err?.message || err || 'preview failed').slice(0, 300);
            emit({ type: 'preview_failed', code, message });
            codexRunStore.updateRun(runId, { status: 'failed', error: message, errorCode: code, percent: 100 });
            await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase: 'error', percent: 100 });
            emit({ type: 'error', code, message });
            return codexRunStore.readRun(runId);
          }
        }
        // Sin acceso CloudAgent el no-resultado queda registrado (AGENTS.md
        // §16) y se entrega el clon clásico, como hasta ahora.
        emit({ type: 'run_skipped', reason: 'codex_access_required' });
      }

      await setPhase('execute', 35, { subphase: 'cloning' });
      emit({ type: 'clone_start', url: repoUrl });

      const cloneArgs = params.branch ? { url: repoUrl, branch } : { url: repoUrl };
      const cloner = typeof deps.cloneProject === 'function' ? deps.cloneProject : cloneProject;
      const cloneResult = await cloner(cloneArgs, { onEvent: emit });

      if (cloneResult.ok) {
        codexRunStore.updateRun(runId, { clonePath: cloneResult.path });
        emit({ type: 'clone_success', path: cloneResult.path });

        // After clone, list the top-level structure
        await setPhase('verify', 65);
        emit({ type: 'verify', ok: true, detail: `Repositorio clonado en ${cloneResult.path}` });

        await setPhase('ship', 85);
        codexRunStore.updateRun(runId, { status: 'completed', phase: 'done', percent: 100 });
        await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase: 'done', percent: 100 });
        emit({ type: 'done', runId, path: cloneResult.path });
        return codexRunStore.readRun(runId);
      }

      // Clone failed — still report but mark as failed
      emit({ type: 'clone_error', error: cloneResult.error });
      codexRunStore.updateRun(runId, { status: 'failed', error: cloneResult.error, percent: 100 });
      emit({ type: 'error', message: cloneResult.error });
      return codexRunStore.readRun(runId);
    }

    // Non-clone code task: use previous pipeline logic
    const executionProfile = buildExecutionProfile({ goal, fileIds: [] });
    const intentAlignmentProfile = buildUserIntentAlignmentProfile({ goal, executionProfile });
    const plan = buildAgentTaskPlan({
      goal,
      executionProfile,
      intentAlignmentProfile,
      fileIds: [],
      maxRuntimeMs: params.maxRuntimeMs || 2 * 60 * 60 * 1000,
    });
    emit({ type: 'plan', plan });

    await setPhase('execute', 35);
    const runner = deps.runAgentTaskJob || null;
    if (typeof runner === 'function' && taskId) {
      await runner({
        taskId,
        user: { id: userId },
        goal,
        chatId,
        model: params.model || 'gpt-4o',
      });
    } else {
      emit({ type: 'execute_skipped', reason: 'no_task_runner' });
    }

    await setPhase('verify', 65);
    const sandbox = deps.runVerification || null;
    if (typeof sandbox === 'function') {
      const verify = await sandbox({ goal });
      emit({ type: 'verify', ok: verify?.ok !== false, detail: verify });
    } else {
      emit({ type: 'verify_skipped', reason: 'no_sandbox' });
    }

    await setPhase('ship', 85);
    const github = deps.githubConnector || null;
    if (repository && typeof github === 'object') {
      if (typeof github.createBranch === 'function') {
        const branchName = `codex/${runId.slice(0, 8)}`;
        await github.createBranch({ repository, baseBranch: branch, branchName });
        emit({ type: 'branch', branch: branchName });
      }
      if (typeof github.openPullRequest === 'function') {
        const pr = await github.openPullRequest({
          repository,
          title: `Codex: ${goal.slice(0, 72)}`,
          body: `Automated Codex run ${runId}`,
          head: `codex/${runId.slice(0, 8)}`,
          base: branch,
        });
        codexRunStore.updateRun(runId, { prUrl: pr?.url || null });
        emit({ type: 'pr_url', url: pr?.url || null });
      }
      if (typeof github.watchWorkflowRun === 'function') {
        const ci = await github.watchWorkflowRun({ repository, branch, timeoutMs: 120_000 });
        codexRunStore.updateRun(runId, { ciRunId: ci?.runId || null });
        emit({ type: 'ci_status', status: ci?.status || 'unknown', conclusion: ci?.conclusion || null });
      }
    } else {
      emit({ type: 'ship_skipped', reason: repository ? 'no_github_connector' : 'no_repository' });
    }

    codexRunStore.updateRun(runId, { status: 'completed', phase: 'done', percent: 100 });
    await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase: 'done', percent: 100 });
    emit({ type: 'done', runId });
    return codexRunStore.readRun(runId);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    codexRunStore.updateRun(runId, { status: 'failed', error: message, percent: 100 });
    emit({ type: 'error', message });
    throw err;
  }
}

function enqueueCodexRun(params = {}, deps = {}) {
  const record = createRunRecord(params);
  setImmediate(() => {
    runCodexPipeline({ ...params, runId: record.runId }, deps).catch(() => {});
  });
  return record;
}

module.exports = {
  PHASES,
  detectCodeTaskIntent,
  detectRunRequest,
  extractRepoUrl,
  runnerProjectIdFor,
  createRunRecord,
  runCodexPipeline,
  enqueueCodexRun,
};
