'use strict';

/**
 * codex_cloud — build and run real apps in the SiraGPT cloud runner from the
 * /agentes chat, with zero new UI: the model calls this skill through the
 * existing `run_skill` tool and pastes the returned preview link into its
 * answer. No downloads, no local app, no /code revival.
 *
 * Safety contract (AGENTS.md §9.2 / §16 / F7.4):
 * - Preflights on every call: CODEX_AGENT_V2 flag, user identity, the
 *   canUseCodexAgent gate (admin / allowlist), runner reachability.
 * - Builds run plan-first: `plan` never mutates the workspace; `build`
 *   needs an approvable planRunId (the user's chat confirmation).
 * - Everything is bounded: waits poll with a deadline, exec/read/cmd are
 *   validated and truncated, the runner enforces its own binary allowlist.
 * - Abort (Stop button) cancels the in-flight run best-effort, then aborts.
 * - Failures carry stable `code: ...` prefixes (§16 style) so the model can
 *   explain what to do next instead of dying silently.
 *
 * All Codex collaborators are resolved through `ctx.codex` first so unit
 * tests inject fakes without touching Docker/Prisma/Redis.
 */

const ACTIVE_STATUSES = ['queued', 'running', 'waiting_approval'];
const TERMINAL_STATUSES = ['done', 'error', 'cancelled'];

const POLL_MS = 2000;
const WAIT_DEADLINE_MS = 100_000;
const PREVIEW_DEADLINE_MS = 100_000;
const MAX_EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_READ_CHARS = 40_000;
const MAX_SUMMARY_CHARS = 4000;

function codexError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function truncate(value, max = MAX_OUTPUT_CHARS) {
  const text = value == null ? '' : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function clampTimeoutMs(value, fallback, max = MAX_EXEC_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(String(status || ''));
}

function validateCmd(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0) return 'cmd must be a non-empty argv array';
  if (cmd.length > 12) return 'cmd has too many argv entries (max 12)';
  for (const part of cmd) {
    if (typeof part !== 'string' || !part.trim()) return 'cmd argv entries must be non-empty strings';
    if (part.length > 500) return 'cmd argv entry too long (max 500 chars)';
  }
  return null;
}

function validateReadPath(path) {
  const raw = String(path || '').trim();
  if (!raw) return 'path is required';
  if (raw.length > 300) return 'path too long (max 300 chars)';
  if (raw.startsWith('/') || raw.includes('..') || raw.includes('\0')) {
    return 'path must be workspace-relative without .. segments';
  }
  return null;
}

/** Same shape as routes/codex.js codexPreviewBasePath (canonical source). */
function previewBasePath(projectId, token) {
  return `/api/codex/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(token)}/app/`;
}

function checkAborted(ctx) {
  if (ctx?.signal?.aborted) {
    const error = new Error('agent run aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test hook: ctx.timeouts overrides the production wait budgets. */
function budgets(ctx = {}) {
  const t = ctx.timeouts || {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return {
    waitMs: num(t.waitMs, WAIT_DEADLINE_MS),
    previewMs: num(t.previewMs, PREVIEW_DEADLINE_MS),
    pollMs: num(t.pollMs, POLL_MS),
  };
}

function deps(ctx = {}) {
  if (ctx.codex) return ctx.codex;
  const lazy = (path) => {
    try { return require(path); } catch (_) { return null; }
  };
  return {
    flags: lazy('../../services/codex/flags'),
    access: lazy('../../services/codex/access-control'),
    projects: lazy('../../services/codex/project-service'),
    runs: lazy('../../services/codex/run-service'),
    runner: null, // built per call via sandbox provider (needs env)
    sandboxProvider: lazy('../../services/codex/sandbox-provider'),
    previewProxy: lazy('../../services/code/preview-proxy'),
    prisma: lazy('../../config/database'),
    userStore: null, // override { findUserById } in tests
  };
}

function resolvePrisma(ctx, d) {
  if (ctx.prisma) return ctx.prisma;
  if (d.prisma) return d.prisma;
  try { return require('../../config/database'); } catch (_) { return null; }
}

async function resolveUser(ctx, d, prisma, userId) {
  if (!userId) throw codexError('codex_no_user', 'Call without user identity. Re-authenticate and retry.');
  if (ctx.user && (ctx.user.id === userId || ctx.user.userId === userId)) return ctx.user;
  const store = ctx.userStore || d.userStore || null;
  if (store?.findUserById) {
    const found = await store.findUserById(String(userId));
    if (!found) throw codexError('codex_no_user', 'User not found. Re-authenticate and retry.');
    return found;
  }
  if (!prisma?.user?.findUnique) {
    // Without a user row we can only honor an explicit id for the gate;
    // admins/allowlist still resolve through the same check below.
    return { id: String(userId) };
  }
  const row = await prisma.user.findUnique({
    where: { id: String(userId) },
    select: { id: true, isAdmin: true, isSuperAdmin: true, deletedAt: true },
  });
  if (!row) throw codexError('codex_no_user', 'User not found. Re-authenticate and retry.');
  return row;
}

async function preflight(ctx, d, { needRunner = false } = {}) {
  if (!d.flags?.isCodexV2Enabled?.()) {
    throw codexError('codex_disabled', 'Cloud apps are disabled on this deployment (CODEX_AGENT_V2 off).');
  }
  const prisma = resolvePrisma(ctx, d);
  if (!prisma) throw codexError('codex_store_unavailable', 'Project store unavailable. Retry in a moment.');
  const userId = ctx.userId || ctx.toolAuthCtx?.userId || null;
  const user = await resolveUser(ctx, d, prisma, userId);
  if (!d.access?.canUseCodexAgent?.(user, process.env)) {
    throw codexError('codex_forbidden', 'Your account cannot run APPS in production.');
  }
  let runner = null;
  if (needRunner) {
    try {
      const provider = d.sandboxProvider;
      const client = provider?.createSandboxClient ? provider.createSandboxClient() : null;
      runner = client || (d.runner?.create ? d.runner.create() : d.runner) || null;
    } catch (_) { runner = null; }
    if (!runner) throw codexError('runner_unreachable', 'Cloud runner unavailable. Retry in a moment.');
  }
  return { prisma, user, userId: String(user.id || userId), runner };
}

async function resolveProject(ctx, d, prisma, userId, { projectId, chatId }) {
  if (projectId) {
    const project = await d.projects.getProject({ userId, id: String(projectId), db: prisma });
    if (!project) throw codexError('project_not_found', 'Project not found for this user.');
    return project;
  }
  const cleanChat = String(chatId || '').trim();
  if (cleanChat) {
    const projects = await d.projects.listProjects({ userId, db: prisma });
    const bound = (Array.isArray(projects) ? projects : []).find(
      (p) => p && p.brief && typeof p.brief === 'object' && p.brief.chatId === cleanChat,
    );
    if (bound) return { ...bound, __reused: true };
  }
  throw codexError('project_required', 'Pass projectId or the chatId of an existing app project.');
}

async function pollRunTerminal(ctx, d, { userId, prisma, runId, deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  const pollMs = budgets(ctx).pollMs;
  let last = null;
  for (;;) {
    checkAborted(ctx);
    last = await d.runs.getRun({ userId, runId, db: prisma });
    if (!last) throw codexError('run_not_found', 'Run disappeared. Start over with plan.');
    if (isTerminalStatus(last.status)) return last;
    if (Date.now() >= deadline) return { ...last, __pending: true };
    await sleep(pollMs);
  }
}

async function cancelBestEffort(ctx, d, prisma, userId, runId) {
  if (!runId) return;
  try {
    await d.runs.cancelRun({ userId, runId, db: prisma });
  } catch (_) { /* cancellation itself must never fail the abort path */ }
}

async function doEnsureProject(ctx, d, pre, args) {
  const chatId = String(args.chatId || '').trim() || null;
  if (chatId) {
    const projects = await d.projects.listProjects({ userId: pre.userId, db: pre.prisma });
    const bound = (Array.isArray(projects) ? projects : []).find(
      (p) => p && p.brief && typeof p.brief === 'object' && p.brief.chatId === chatId,
    );
    if (bound) return { ok: true, projectId: bound.id, name: bound.name, status: bound.status, reused: true };
  }
  const name = String(args.name || '').trim() || (chatId ? `App del chat ${chatId.slice(-6)}` : null);
  if (!name) throw codexError('name_required', 'Pass name (or chatId) to create the app project.');
  const created = await d.projects.createProject({
    userId: pre.userId,
    name: name.slice(0, 80),
    brief: { chatId, goal: String(args.goal || '').slice(0, 2000) || null, source: 'agentes-chat' },
    db: pre.prisma,
  });
  return { ok: true, projectId: created.id, name: created.name, status: created.status, reused: false };
}

async function doPlan(ctx, d, pre, args) {
  const goal = String(args.goal || '').trim();
  if (!goal) throw codexError('goal_required', 'Describe what the app should do (goal).');
  let project;
  try {
    project = await resolveProject(ctx, d, pre.prisma, pre.userId, args);
  } catch (err) {
    if (err?.code === 'project_required' && args.chatId) {
      const ensured = await doEnsureProject(ctx, d, pre, args);
      project = { id: ensured.projectId };
    } else throw err;
  }
  let run = null;
  try {
    run = await d.runs.createRun({
      userId: pre.userId, projectId: project.id, mode: 'plan', prompt: goal, db: pre.prisma,
    });
    const final = await pollRunTerminal(ctx, d, {
      userId: pre.userId, prisma: pre.prisma, runId: run.id, deadlineMs: budgets(ctx).waitMs,
    });
    if (final.__pending) {
      return { ok: true, pending: true, projectId: project.id, runId: run.id, status: final.status, next: 'Re-check with action=status, then build with action=build once the plan is done.' };
    }
    if (final.status !== 'done' && final.status !== 'waiting_approval') {
      throw codexError('plan_failed', `Plan finished as ${final.status}: ${truncate(final.error, 500) || 'no detail'}.`);
    }
    return {
      ok: true, projectId: project.id, runId: final.id, planRunId: final.id, status: final.status,
      next: 'Show the plan to the user and ask for confirmation (one line), then call action=build with this planRunId.',
    };
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      await cancelBestEffort(ctx, d, pre.prisma, pre.userId, run?.id);
    }
    throw err;
  }
}

async function doBuild(ctx, d, pre, args) {
  const planRunId = String(args.planRunId || '').trim();
  if (!planRunId) throw codexError('plan_required', 'Build needs the planRunId of a done plan. Run action=plan first.');
  const project = await resolveProject(ctx, d, pre.prisma, pre.userId, args);
  let run = null;
  try {
    run = await d.runs.createRun({
      userId: pre.userId, projectId: project.id, mode: 'build', planRunId,
      prompt: String(args.goal || '').trim() || undefined, db: pre.prisma,
    });
    const final = await pollRunTerminal(ctx, d, {
      userId: pre.userId, prisma: pre.prisma, runId: run.id, deadlineMs: budgets(ctx).waitMs,
    });
    if (final.__pending) {
      return { ok: true, pending: true, projectId: project.id, runId: run.id, status: final.status, next: 'Re-check with action=status, then action=preview when done.' };
    }
    if (final.status !== 'done') {
      throw codexError('build_failed', `Build finished as ${final.status}: ${truncate(final.error, 500) || 'no detail'}.`);
    }
    return { ok: true, projectId: project.id, runId: final.id, status: 'done', next: 'Call action=preview to get the live preview link.' };
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      await cancelBestEffort(ctx, d, pre.prisma, pre.userId, run?.id);
    }
    throw err;
  }
}

async function doStatus(ctx, d, pre, args) {
  const runId = String(args.runId || '').trim();
  if (!runId) throw codexError('run_required', 'Pass runId to check a run.');
  const run = await d.runs.getRun({ userId: pre.userId, runId, db: pre.prisma });
  if (!run) throw codexError('run_not_found', 'Run not found for this user.');
  return {
    ok: true, runId: run.id, projectId: run.projectId, mode: run.mode, status: run.status,
    active: ACTIVE_STATUSES.includes(String(run.status)), error: run.error ? truncate(run.error, 500) : null,
    finishedAt: run.finishedAt || null,
  };
}

async function doPreview(ctx, d, pre, args) {
  const project = await resolveProject(ctx, d, pre.prisma, pre.userId, args);
  const runner = pre.runner;
  let live = null;
  try {
    live = await runner.devStatus(project.id);
  } catch (err) {
    throw codexError('runner_unreachable', `Cloud runner unavailable: ${truncate(err?.message, 200) || 'no detail'}.`);
  }
  const finish = async (reused) => {
    const ready = await waitReady(ctx, runner, project.id, budgets(ctx).previewMs);
    return { ok: true, projectId: project.id, previewUrl: ready.basePath, reused, ready: ready.ready };
  };
  if (live?.running && !live?.error) {
    const basePath = String(live.basePath || '');
    const token = /\/preview\/([^/]+)\/app\/$/.exec(basePath)?.[1] || null;
    if (token && tokenFresh(token, d)) return finish(true);
  }
  let token;
  try {
    token = d.previewProxy.previewTokenFor({ projectId: project.id, userId: pre.userId });
  } catch (err) {
    throw codexError('preview_token_failed', `Cannot mint preview access: ${truncate(err?.message, 200) || 'no detail'}.`);
  }
  const basePath = previewBasePath(project.id, token);
  try {
    await runner.startDev(project.id, { basePath });
  } catch (err) {
    const msg = String(err?.message || '');
    if (err?.status === 429 || /dev_pool_exhausted/i.test(msg)) {
      throw codexError('preview_pool_exhausted', 'All preview slots are starting. Retry in a few seconds.');
    }
    throw codexError('runner_unreachable', `Preview failed to start: ${truncate(msg, 200) || 'no detail'}.`);
  }
  return finish(false);
}

function tokenFresh(token, d) {
  try {
    const payload = d.previewProxy.verifyPreviewToken(decodeURIComponent(token));
    return Boolean(payload) && Number(payload?.exp || 0) - Date.now() > 10 * 60 * 1000;
  } catch (_) { return false; }
}

async function waitReady(ctx, runner, projectId, deadlineMs = PREVIEW_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  const pollMs = budgets(ctx).pollMs;
  let last = null;
  for (;;) {
    checkAborted(ctx);
    try {
      last = await runner.devStatus(projectId);
    } catch (err) {
      throw codexError('runner_unreachable', `Cloud runner unavailable: ${truncate(err?.message, 200) || 'no detail'}.`);
    }
    const sameProject = !last?.project || last.project === projectId;
    if (last?.ready && sameProject) {
      return { ready: true, basePath: String(last.basePath || '') };
    }
    if (last?.error && last?.running === false) {
      throw codexError('preview_failed', truncate(last.error, 300) || 'Preview failed to start.');
    }
    if (Date.now() >= deadline) {
      throw codexError('preview_timeout', 'Preview is still starting. Call action=preview again to reuse it.');
    }
    await sleep(pollMs);
  }
}

async function doExec(ctx, d, pre, args) {
  const bad = validateCmd(args.cmd);
  if (bad) throw codexError('invalid_cmd', bad);
  const project = await resolveProject(ctx, d, pre.prisma, pre.userId, args);
  const timeoutMs = clampTimeoutMs(args.timeoutMs, 30_000);
  let out;
  try {
    out = await pre.runner.exec(project.id, args.cmd, { timeoutMs, signal: ctx.signal });
  } catch (err) {
    throw codexError('runner_unreachable', `Command failed to run: ${truncate(err?.message, 200) || 'no detail'}.`);
  }
  return {
    ok: true, projectId: project.id,
    exitCode: out?.exitCode ?? out?.code ?? null,
    stdout: truncate(out?.stdout, MAX_OUTPUT_CHARS),
    stderr: truncate(out?.stderr, MAX_OUTPUT_CHARS),
  };
}

async function doRead(ctx, d, pre, args) {
  const bad = validateReadPath(args.path);
  if (bad) throw codexError('invalid_path', bad);
  const project = await resolveProject(ctx, d, pre.prisma, pre.userId, args);
  let out;
  try {
    out = await pre.runner.readFile(project.id, String(args.path).trim());
  } catch (err) {
    throw codexError('runner_unreachable', `Cannot read file: ${truncate(err?.message, 200) || 'no detail'}.`);
  }
  const content = typeof out === 'string' ? out : (out?.content ?? out?.text ?? JSON.stringify(out));
  return { ok: true, projectId: project.id, path: String(args.path).trim(), content: truncate(content, MAX_READ_CHARS) };
}

async function doCancel(ctx, d, pre, args) {
  const runId = String(args.runId || '').trim();
  if (!runId) throw codexError('run_required', 'Pass runId to cancel a run.');
  await d.runs.cancelRun({ userId: pre.userId, runId, db: pre.prisma });
  return { ok: true, runId, status: 'cancelled' };
}

async function execute(args = {}, ctx = {}) {
  const d = deps(ctx);
  if (!d.projects || !d.runs || !d.flags || !d.access) {
    throw codexError('codex_unavailable', 'Cloud apps subsystem unavailable on this host.');
  }
  const action = String(args.action || '').trim();
  const needRunner = action === 'preview' || action === 'exec' || action === 'read';
  const pre = await preflight(ctx, d, { needRunner });
  switch (action) {
    case 'ensure_project': return doEnsureProject(ctx, d, pre, args);
    case 'plan': return doPlan(ctx, d, pre, args);
    case 'build': return doBuild(ctx, d, pre, args);
    case 'status': return doStatus(ctx, d, pre, args);
    case 'preview': return doPreview(ctx, d, pre, args);
    case 'exec': return doExec(ctx, d, pre, args);
    case 'read': return doRead(ctx, d, pre, args);
    case 'cancel': return doCancel(ctx, d, pre, args);
    default: throw codexError('invalid_action', 'action must be ensure_project|plan|build|status|preview|exec|read|cancel.');
  }
}

module.exports = {
  execute,
  _internal: {
    truncate, clampTimeoutMs, isTerminalStatus, validateCmd, validateReadPath,
    previewBasePath, ACTIVE_STATUSES, TERMINAL_STATUSES,
    WAIT_DEADLINE_MS, POLL_MS, MAX_OUTPUT_CHARS,
  },
};
