'use strict';

/**
 * project-preview-tools — project_clone_repo / project_preview_start /
 * project_preview_status / project_preview_stop.
 *
 * "Dame la web en local": the chat agent clones the repo the user named into
 * the Codex project bound to this chat, installs and starts its dev server in
 * the runner sidecar and answers with the tokenized preview URL. This replaces
 * the manual IDE buttons (repo picker + "Vista previa"), which never mount in
 * production. The dev server port is assigned by the runner; a port the user
 * asked for (e.g. 5000) cannot be honoured, the preview URL is the local run.
 *
 * Contract: never throw for expected failures — `{ ok:false, code, message }`.
 */

const REPO_URL_MAX = 500;
const BRANCH_MAX = 128;

function serviceFromCtx(ctx) {
  const override = ctx && ctx.projectTools && ctx.projectTools.previewService;
  if (override) return override;
  // eslint-disable-next-line global-require
  return require('../codex/chat-preview.service');
}

function depsFromCtx(ctx) {
  const override = (ctx && ctx.projectTools) || {};
  const deps = {};
  if (override.db) deps.db = override.db;
  if (override.runner) deps.runner = override.runner;
  if (override.binding) deps.binding = override.binding;
  if (override.projectService) deps.projectService = override.projectService;
  if (override.githubApi !== undefined) deps.githubApi = override.githubApi;
  if (override.env) deps.env = override.env;
  if (override.sleep) deps.sleep = override.sleep;
  return deps;
}

function chatScope(ctx) {
  const userId = ctx && ctx.userId != null ? String(ctx.userId) : '';
  const chatId = ctx && ctx.chatId != null ? String(ctx.chatId) : '';
  if (!userId || !chatId) {
    return {
      error: {
        ok: false,
        code: 'no_chat_context',
        message: 'No hay chat vinculado en este turno; las herramientas de proyecto necesitan el chat de /agentes.',
      },
    };
  }
  return { userId, chatId };
}

/**
 * RLCD: a preview that came up is a positive implicit outcome for this turn's
 * decisions (execution lane, model…); a hard failure is negative. `pending`
 * and access errors are not evidence either way.
 */
function recordRlcdOutcome(ctx, result) {
  try {
    const chatId = ctx && ctx.chatId != null ? String(ctx.chatId) : '';
    if (!chatId || !result) return;
    let outcome = null;
    if (result.ok && (!result.status || result.status.ready !== false)) outcome = 'tool_success';
    else if (!result.ok && ['preview_not_ready', 'clone_failed', 'runner_unreachable', 'dev_pool_exhausted'].includes(String(result.code))) outcome = 'failure';
    if (!outcome) return;
    // eslint-disable-next-line global-require
    require('../rlcd').recordOutcome({ chatId, outcome, source: 'preview_tool' });
  } catch (_) { /* advisory */ }
}

function withPreviewHint(result) {
  if (!result || !result.ok || !result.previewUrl) return result;
  return {
    ...result,
    hint: 'Comparte previewUrl con el usuario como enlace; es su "web en local" servida desde el runner (el puerto lo asigna el runner, no se puede fijar 5000). La sesión de preview expira; si el enlace deja de responder vuelve a llamar project_preview_start.',
  };
}

async function cloneRepo(args, ctx) {
  const scope = chatScope(ctx);
  if (scope.error) return scope.error;
  const repoUrl = String((args && args.repoUrl) || '').trim();
  if (!repoUrl || repoUrl.length > REPO_URL_MAX) {
    return { ok: false, code: 'invalid_repository_url', message: 'repoUrl es obligatorio (https://github.com/owner/repo).' };
  }
  const branch = String((args && args.branch) || '').trim().slice(0, BRANCH_MAX);
  const name = String((args && args.name) || '').trim().slice(0, 80);
  const svc = serviceFromCtx(ctx);
  const out = await svc.cloneRepoForChat({ userId: scope.userId, chatId: scope.chatId, repoUrl, branch, name }, depsFromCtx(ctx));
  if (out && out.ok) {
    return {
      ...out,
      next: 'Llama project_preview_start para instalar dependencias y arrancar el servidor de desarrollo; devuelve previewUrl.',
    };
  }
  recordRlcdOutcome(ctx, out);
  return out;
}

const projectCloneRepoTool = {
  name: 'project_clone_repo',
  description: 'Clone a public or (with the user\'s connected GitHub) private github.com repository into this chat\'s project workspace on the server. Use when the user asks to work on / run / deploy a repo locally ("dame la web en local", "levanta el repo", "desplegar en local"). One project per chat: if the chat already has one, it is reused. Then call project_preview_start. Fails with codex_forbidden when the account is not allowed to run projects.',
  parameters: {
    type: 'object',
    properties: {
      repoUrl: { type: 'string', description: 'https://github.com/owner/repo' },
      branch: { type: 'string', description: 'Branch to check out. Default: the repo default branch.' },
      name: { type: 'string', description: 'Project label. Default: repo name.' },
    },
    required: ['repoUrl'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      return await cloneRepo(args || {}, ctx || {});
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectPreviewStartTool = {
  name: 'project_preview_start',
  description: 'Install dependencies (npm ci / bun by lockfile) and start the dev server of this chat\'s project in the sandboxed runner, then return previewUrl (the user\'s "web en local"). Reuses a running server. Waits up to waitMs (default 90 s, max 150 s). Result codes: ok → share previewUrl and port; preview_pending → the install/build is still running (big repos take minutes): tell the user it is installing and call project_preview_status later (or with waitMs) — do NOT treat it as an error; preview_not_ready → read status.tail, fix the project (project_read/project_write/project_exec) and retry; no_project → run project_clone_repo first. If the user asked for a port (e.g. "en el 5000") pass preferredPort. For full-stack repos whose frontend expects an API base, pass env such as {"NEXT_PUBLIC_API_URL":"/api"} (same-origin production API through the preview proxy); only NEXT_PUBLIC_*/VITE_*/PUBLIC_* keys are accepted.',
  parameters: {
    type: 'object',
    properties: {
      preferredPort: { type: 'integer', description: 'Puerto pedido por el usuario (p. ej. 5000). Se fija en el runner si está libre.' },
      env: { type: 'object', description: 'Variables públicas de build para el dev server, p. ej. {"NEXT_PUBLIC_API_URL":"/api"}. Solo NEXT_PUBLIC_*, VITE_*, PUBLIC_*, REACT_APP_*.', additionalProperties: { type: 'string' } },
      waitMs: { type: 'integer', minimum: 5000, maximum: 150000, description: 'Cuánto esperar a que quede listo antes de devolver preview_pending. Default 90000.' },
    },
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      const scope = chatScope(ctx);
      if (scope.error) return scope.error;
      const svc = serviceFromCtx(ctx);
      const preferredPort = Number(args && args.preferredPort);
      const out = withPreviewHint(await svc.startPreviewForChat({
        userId: scope.userId,
        chatId: scope.chatId,
        preferredPort: Number.isInteger(preferredPort) ? preferredPort : undefined,
        env: args && args.env && typeof args.env === 'object' ? args.env : undefined,
        waitMs: Number(args && args.waitMs) || undefined,
      }, depsFromCtx(ctx)));
      recordRlcdOutcome(ctx, out);
      return out;
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectPreviewStatusTool = {
  name: 'project_preview_status',
  description: 'Current state of this chat\'s project dev server (installing / building / starting / ready / error) with the last log lines and previewUrl when running. Pass waitMs (up to 150000) to wait for it to become ready after a preview_pending.',
  parameters: {
    type: 'object',
    properties: {
      waitMs: { type: 'integer', minimum: 5000, maximum: 150000, description: 'Esperar hasta este tiempo a que el servidor quede listo.' },
    },
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      const scope = chatScope(ctx);
      if (scope.error) return scope.error;
      const svc = serviceFromCtx(ctx);
      const out = withPreviewHint(await svc.previewStatusForChat({ userId: scope.userId, chatId: scope.chatId, waitMs: Number(args && args.waitMs) || undefined }, depsFromCtx(ctx)));
      if (out && out.ok && out.status && out.status.ready) recordRlcdOutcome(ctx, out);
      return out;
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectPreviewStopTool = {
  name: 'project_preview_stop',
  description: 'Stop the dev server of this chat\'s project. Use when the user asks to stop/close the local web.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_args, ctx) => {
    try {
      const scope = chatScope(ctx);
      if (scope.error) return scope.error;
      const svc = serviceFromCtx(ctx);
      return await svc.stopPreviewForChat({ userId: scope.userId, chatId: scope.chatId }, depsFromCtx(ctx));
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

module.exports = {
  projectCloneRepoTool,
  projectPreviewStartTool,
  projectPreviewStatusTool,
  projectPreviewStopTool,
  _internal: { chatScope, depsFromCtx, withPreviewHint, recordRlcdOutcome },
};
