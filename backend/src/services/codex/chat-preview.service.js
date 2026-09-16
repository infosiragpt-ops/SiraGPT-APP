'use strict';

/**
 * chat-preview.service — clone a GitHub repo into the Codex project bound to
 * an /agentes chat and run it in the runner sidecar with a tokenized preview
 * URL. Same contract as POST /api/codex/projects/clone and
 * POST /api/codex/projects/:id/preview/start, exposed as plain functions so
 * the chat agent tools (project_clone_repo / project_preview_*) can drive the
 * flow the user asked for in prose ("dame la web en local").
 *
 * Every function is fail-open for expected problems: it returns
 * `{ ok:false, code, message }` instead of throwing, so the agent loop can
 * self-correct. Codes: codex_forbidden | invalid_repository_url |
 * repository_not_found | chat_already_bound | project_not_found |
 * dev_pool_exhausted | runner_unreachable | preview_not_ready.
 */

const { canUseCodexAgent } = require('./access-control');
const projectChatBinding = require('./project-chat-binding');
const opencodeHarness = require('./opencode-harness');
const { previewTokenFor, verifyPreviewToken } = require('../code/preview-proxy');

const PUBLIC_URL_KEYS = ['PUBLIC_FRONTEND_URL', 'NEXT_PUBLIC_URL', 'FRONTEND_URL'];

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function publicOrigin(env = process.env) {
  for (const key of PUBLIC_URL_KEYS) {
    const raw = String((env && env[key]) || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw.split(',')[0].trim());
      return u.origin;
    } catch { /* next key */ }
  }
  return '';
}

function previewBasePath(projectId, token) {
  return `/api/codex/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(token)}/app/`;
}

function absolutePreviewUrl(basePath, env = process.env) {
  const origin = publicOrigin(env);
  return origin ? `${origin}${basePath}` : basePath;
}

function defaultDeps() {
  // Lazy: keep the module cheap to require from the chat loop.
  // eslint-disable-next-line global-require
  const db = require('../../config/database');
  // eslint-disable-next-line global-require
  const projectService = require('./project-service');
  // eslint-disable-next-line global-require
  const { createSandboxClient } = require('./sandbox-provider');
  let githubApi = null;
  try {
    // eslint-disable-next-line global-require
    githubApi = require('../github/github-api.service');
  } catch { githubApi = null; }
  return { db, projectService, runner: createSandboxClient(), githubApi };
}

function resolveDeps(deps = {}) {
  const base = deps && (deps.db || deps.runner || deps.projectService) ? {} : defaultDeps();
  return {
    db: deps.db || base.db,
    projectService: deps.projectService || base.projectService,
    runner: deps.runner || base.runner,
    githubApi: deps.githubApi !== undefined ? deps.githubApi : base.githubApi,
    env: deps.env || process.env,
    binding: deps.binding || projectChatBinding,
    harness: deps.harness || opencodeHarness,
    now: deps.now || Date.now,
  };
}

/**
 * The gate the codex routes apply (`requireCodexAgentAccess`), evaluated for
 * a userId instead of req.user. Missing user → forbidden.
 */
async function assertCodexAccess({ userId, db, env }) {
  if (!userId) return fail('codex_forbidden', 'Sesión sin usuario.');
  let user = null;
  try {
    user = await db.user.findUnique({
      where: { id: String(userId) },
      select: { id: true, isAdmin: true, isSuperAdmin: true, deletedAt: true },
    });
  } catch (err) {
    return fail('runner_unreachable', `No se pudo comprobar el acceso: ${String(err?.message || err)}`);
  }
  if (!canUseCodexAgent(user, env)) {
    return fail('codex_forbidden', 'Esta cuenta no tiene habilitada la ejecución de proyectos en el servidor (gate del agente de código). Un administrador debe añadirla a CODEX_AGENT_ALLOWED_USER_IDS.');
  }
  return { ok: true, user };
}

async function storedGithubToken(githubApi, userId) {
  if (!githubApi || typeof githubApi.resolveUserToken !== 'function') return null;
  try {
    const { accessToken } = await githubApi.resolveUserToken(userId);
    const token = String(accessToken || '').trim();
    return token ? { accessToken: token } : null;
  } catch {
    return null;
  }
}

/**
 * Clone `repoUrl` into a Codex project bound to `chatId` (one project per
 * chat). If the chat already has a project, nothing is cloned and the bound
 * project is returned with `reused: true`.
 */
async function cloneRepoForChat({ userId, chatId, repoUrl, branch = '', name = '' } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const cleanChat = d.binding.cleanChatId(chatId);
  if (!cleanChat) return fail('no_chat_context', 'No hay chat de /agentes en este turno.');
  const access = await assertCodexAccess({ userId, db: d.db, env: d.env });
  if (!access.ok) return access;

  let repository;
  try {
    repository = d.harness.parsePublicGithubRepo(repoUrl);
  } catch (err) {
    return fail(String(err?.code || 'invalid_repository_url'), String(err?.message || 'URL de repositorio inválida.'));
  }

  let bound = null;
  try {
    bound = await d.binding.findProjectForChat({ userId, chatId: cleanChat, db: d.db, projects: d.projectService });
  } catch (err) {
    return fail('runner_unreachable', String(err?.message || err));
  }
  if (bound && bound.id) {
    return {
      ok: true,
      reused: true,
      project: { id: bound.id, name: bound.name || null, status: bound.status || null },
      repository: { fullName: `${repository.owner}/${repository.repo}`, webUrl: repository.webUrl },
      message: 'Este chat ya tiene un proyecto vinculado; no se clona de nuevo.',
    };
  }

  const stored = await storedGithubToken(d.githubApi, userId);
  let meta = null;
  if (stored && d.githubApi && typeof d.githubApi.getRepository === 'function') {
    try {
      meta = await d.githubApi.getRepository(userId, repository.owner, repository.repo);
    } catch (err) {
      if (Number(err?.status) === 404) {
        return fail('repository_not_found', 'El repositorio no existe o tu cuenta de GitHub no tiene acceso a él.');
      }
      meta = null;
    }
  }
  const sourceBranch = String(branch || '').trim() || (meta && meta.defaultBranch) || 'main';
  const isPrivate = Boolean(meta && meta.private);
  const label = String(name || '').trim().slice(0, 80) || repository.repo;

  let row;
  try {
    row = await d.db.codexProject.create({
      data: {
        userId: String(userId),
        organizationId: null,
        name: label,
        brief: {
          kind: isPrivate ? 'repo-private' : 'repo-public',
          repository: {
            url: repository.cloneUrl,
            webUrl: repository.webUrl,
            fullName: `${repository.owner}/${repository.repo}`,
            private: isPrivate,
            defaultBranch: (meta && meta.defaultBranch) || null,
          },
          sourceBranch,
          authenticated: Boolean(stored),
          chatId: cleanChat,
          source: 'agentes-chat-tool',
        },
        status: 'provisioning',
      },
    });
  } catch (err) {
    return fail('runner_unreachable', `No se pudo crear el proyecto: ${String(err?.message || err)}`);
  }

  try {
    const cloned = await d.harness.clonePublicRepo({
      runner: d.runner,
      projectId: row.id,
      repoUrl: repository.cloneUrl,
      branch: sourceBranch,
      accessToken: stored ? stored.accessToken : null,
    });
    await d.db.codexProject.update({
      where: { id: row.id },
      data: { status: 'ready', workspacePath: cloned.workspacePath, previewUrl: null, error: null },
    });
    return {
      ok: true,
      reused: false,
      project: { id: row.id, name: label, status: 'ready' },
      repository: { fullName: `${repository.owner}/${repository.repo}`, webUrl: repository.webUrl, private: isPrivate },
      branch: cloned.sourceBranch || sourceBranch,
      commitSha: cloned.commitSha || null,
      authenticated: Boolean(stored),
    };
  } catch (err) {
    const message = String(err?.message || err);
    try {
      await d.db.codexProject.update({ where: { id: row.id }, data: { status: 'error', error: message.slice(0, 2000) } });
    } catch { /* best effort */ }
    const needsAuth = /could not read Username|Authentication failed|permission denied|403|401|repository not found/i.test(message)
      || (String(err?.code || '') === 'repository_bootstrap_failed' && !stored);
    if (needsAuth) {
      return fail('github_auth_required', `GitHub no dejó leer ${repository.owner}/${repository.repo}: el repositorio es privado o no existe, y esta cuenta no tiene GitHub conectado. Pide al usuario que conecte su GitHub en Apps → GitHub (o que haga público el repo) y reintenta.`, { projectId: row.id, authenticated: Boolean(stored) });
    }
    return fail('clone_failed', `No se pudo clonar ${repository.owner}/${repository.repo}@${sourceBranch}: ${message}`, { projectId: row.id });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPreviewReady(runner, projectId, env = process.env, sleeper = sleep) {
  const timeoutMs = Math.max(1000, Number(env.CODEX_PREVIEW_START_TIMEOUT_MS) || 90_000);
  const intervalMs = Math.max(250, Number(env.CODEX_PREVIEW_START_POLL_MS) || 1000);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await runner.devStatus(projectId);
    const sameProject = !last?.project || last.project === projectId;
    if (last?.ready && sameProject) return { ready: true, status: last };
    if (last?.error && last.running === false) return { ready: false, status: last, error: String(last.error) };
    await sleeper(intervalMs);
  }
  const tail = Array.isArray(last?.tail) ? last.tail.slice(-3).join(' | ') : '';
  return { ready: false, status: last, error: last?.error || tail || 'El preview no quedó listo a tiempo.' };
}

function compactStatus(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    state: status.state || null,
    running: Boolean(status.running),
    ready: Boolean(status.ready),
    port: Number.isInteger(status.port) ? status.port : null,
    framework: status.framework || null,
    error: status.error || null,
    tail: Array.isArray(status.tail) ? status.tail.slice(-8) : [],
  };
}

/**
 * Start (or reuse) the dev server of the chat's bound project and return the
 * tokenized preview URL. Waits for readiness up to CODEX_PREVIEW_START_TIMEOUT_MS.
 */
async function startPreviewForChat({ userId, chatId } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const access = await assertCodexAccess({ userId, db: d.db, env: d.env });
  if (!access.ok) return access;
  const project = await d.binding.findProjectForChat({ userId, chatId, db: d.db, projects: d.projectService }).catch(() => null);
  if (!project || !project.id) {
    return fail('no_project', 'Este chat aún no tiene proyecto vinculado. Clona primero el repositorio con project_clone_repo.');
  }
  const runner = d.runner;
  try {
    const live = await runner.devStatus(project.id).catch(() => null);
    const liveBase = String(live?.basePath || '');
    const liveToken = /\/preview\/([^/]+)\/app\/$/.exec(liveBase)?.[1];
    const livePayload = liveToken ? verifyPreviewToken(decodeURIComponent(liveToken), d.env) : null;
    const fresh = Number(livePayload?.exp || 0) - d.now() > 10 * 60 * 1000;
    if (live?.running && livePayload && livePayload.projectId === project.id && fresh) {
      const wait = live.ready ? { ready: true, status: live } : await waitForPreviewReady(runner, project.id, d.env, deps.sleep);
      if (wait.ready) {
        return {
          ok: true,
          reused: true,
          project: { id: project.id, name: project.name || null },
          previewUrl: absolutePreviewUrl(liveBase, d.env),
          basePath: liveBase,
          port: Number.isInteger(live.port) ? live.port : null,
          status: compactStatus(wait.status),
        };
      }
    }
    const token = previewTokenFor({ projectId: project.id, userId: String(userId) }, d.env);
    const basePath = previewBasePath(project.id, token);
    const out = await runner.startDev(project.id, { basePath });
    const wait = await waitForPreviewReady(runner, project.id, d.env, deps.sleep);
    if (!wait.ready) {
      return fail('preview_not_ready', `El servidor de desarrollo no quedó listo: ${wait.error}`, {
        project: { id: project.id, name: project.name || null },
        status: compactStatus(wait.status),
      });
    }
    return {
      ok: true,
      reused: Boolean(out?.reused),
      project: { id: project.id, name: project.name || null },
      previewUrl: absolutePreviewUrl(basePath, d.env),
      basePath,
      port: Number.isInteger(out?.port) ? out.port : null,
      status: compactStatus(wait.status),
    };
  } catch (err) {
    if (err && (err.status === 429 || err.body?.error === 'dev_pool_exhausted' || err.code === 'dev_pool_exhausted')) {
      return fail('dev_pool_exhausted', 'Todos los slots de preview están ocupados. Reintenta en unos segundos.');
    }
    return fail('runner_unreachable', String(err?.message || err));
  }
}

async function previewStatusForChat({ userId, chatId } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const project = await d.binding.findProjectForChat({ userId, chatId, db: d.db, projects: d.projectService }).catch(() => null);
  if (!project || !project.id) return fail('no_project', 'Este chat aún no tiene proyecto vinculado.');
  try {
    const status = await d.runner.devStatus(project.id);
    const basePath = String(status?.basePath || '');
    return {
      ok: true,
      project: { id: project.id, name: project.name || null },
      previewUrl: basePath ? absolutePreviewUrl(basePath, d.env) : null,
      status: compactStatus(status),
    };
  } catch (err) {
    return fail('runner_unreachable', String(err?.message || err));
  }
}

async function stopPreviewForChat({ userId, chatId } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const project = await d.binding.findProjectForChat({ userId, chatId, db: d.db, projects: d.projectService }).catch(() => null);
  if (!project || !project.id) return fail('no_project', 'Este chat aún no tiene proyecto vinculado.');
  try {
    await d.runner.stopDev(project.id);
    return { ok: true, project: { id: project.id, name: project.name || null }, stopped: true };
  } catch (err) {
    return fail('runner_unreachable', String(err?.message || err));
  }
}

module.exports = {
  cloneRepoForChat,
  startPreviewForChat,
  previewStatusForChat,
  stopPreviewForChat,
  assertCodexAccess,
  _internal: { publicOrigin, absolutePreviewUrl, previewBasePath, waitForPreviewReady, compactStatus, resolveDeps },
};
