'use strict';

/**
 * agentes-coding/harness — TypeScript/Node tool loop inside a session.
 *
 * Flag: AGENTES_CODING_V2 (default OFF). API-only. See
 * docs/agentes-coding-harness.md, docs/agentes-coding-permissions.md,
 * docs/agentes-coding-jobs.md and docs/agentes-coding-todo-smoke.md
 */

const { isAgentesCodingV2Enabled } = require('../flags');
const { fail } = require('../coding-sandbox/errors');
const { runHarness, resumeHarness, cancelActiveRun } = require('./runner');
const { getStore, findRun, publicRun, forget } = require('./store');
const { listPending, findPending } = require('./permissions');
const {
  resolveJobs,
  startDurable,
  readDurable,
  listDurable,
  cancelDurable,
  resolveDurable,
  loadRowForRequest,
  forgetDurable,
} = require('./jobs');

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

async function requireSession(sandbox, sessionId) {
  if (!sandbox || typeof sandbox.listFiles !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  await sandbox.listFiles(sessionId, '.');
  const raw = typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) fail('E_SESSION_NOT_FOUND');
  return raw;
}

function jobsFrom(opts = {}, extras = {}) {
  return extras.jobs || opts.jobs || null;
}

async function runSession(sandbox, sessionId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  if (opts.jobs) {
    return startDurable(sandbox, sessionId, raw, opts);
  }
  return runHarness(sandbox, sessionId, raw, opts);
}

async function listRuns(sandbox, sessionId, opts = {}) {
  await requireSession(sandbox, sessionId);
  if (opts.jobs) return listDurable(sandbox, sessionId, opts.jobs);
  const raw = sandbox._unsafeGetRaw(sessionId);
  return {
    ok: true,
    runs: getStore(raw).items.map((row) => publicRun(row)),
  };
}

async function getRun(sandbox, sessionId, runId, opts = {}) {
  await requireSession(sandbox, sessionId);
  if (opts.jobs) return readDurable(sandbox, sessionId, runId, opts.jobs);
  const raw = sandbox._unsafeGetRaw(sessionId);
  return { ok: true, run: publicRun(findRun(raw, runId)) };
}

async function cancelRun(sandbox, sessionId, runId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  if (opts.jobs) {
    const loaded = await loadRowForRequest(sandbox, sessionId, runId, opts.jobs);
    return cancelDurable(sandbox, sessionId, loaded.raw, loaded.row, opts.jobs);
  }
  const row = findRun(raw, runId);
  return { ok: true, run: cancelActiveRun(row) };
}

async function listPermissions(sandbox, sessionId, runId, opts = {}) {
  await requireSession(sandbox, sessionId);
  if (opts.jobs) {
    const loaded = await loadRowForRequest(sandbox, sessionId, runId, opts.jobs);
    return { ok: true, permissions: listPending(loaded.row) };
  }
  const raw = sandbox._unsafeGetRaw(sessionId);
  const row = findRun(raw, runId);
  return { ok: true, permissions: listPending(row) };
}

async function resolvePermission(sandbox, sessionId, runId, permissionId, decision, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  if (opts.jobs) {
    const loaded = await loadRowForRequest(sandbox, sessionId, runId, opts.jobs);
    if (opts.permissionPolicy) loaded.row.permissionPolicy = opts.permissionPolicy;
    return resolveDurable(sandbox, sessionId, loaded.raw, loaded.row, permissionId, decision, opts);
  }
  const row = findRun(raw, runId);
  findPending(row, permissionId);
  if (opts.permissionPolicy) row.permissionPolicy = opts.permissionPolicy;
  return resumeHarness(sandbox, sessionId, raw, row, permissionId, decision, {
    llmTurn: opts.llmTurn,
  });
}

async function runForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  const jobs = resolveJobs(env, extras) || jobsFrom(opts, extras);
  return {
    ok: true,
    run: await runSession(sandbox, sessionId, {
      ...opts,
      env,
      llmTurn: extras.llmTurn || extras.complete || (opts && opts.llmTurn),
      providerComplete: extras.providerComplete || extras.chatComplete || (opts && opts.providerComplete),
      createClient: extras.createClient || (opts && opts.createClient),
      modelAlias: extras.modelAlias || (opts && (opts.modelAlias || opts.alias)),
      permissionPolicy: extras.permissionPolicy || (opts && opts.permissionPolicy),
      jobs,
    }),
  };
}

async function listForRequest(sandbox, sessionId, env, extras = {}) {
  requireEnabled(env);
  return listRuns(sandbox, sessionId, { jobs: resolveJobs(env, extras) || extras.jobs });
}

async function getForRequest(sandbox, sessionId, runId, env, extras = {}) {
  requireEnabled(env);
  return getRun(sandbox, sessionId, runId, { jobs: resolveJobs(env, extras) || extras.jobs });
}

async function cancelForRequest(sandbox, sessionId, runId, env, extras = {}) {
  requireEnabled(env);
  return cancelRun(sandbox, sessionId, runId, { jobs: resolveJobs(env, extras) || extras.jobs });
}

async function listPermissionsForRequest(sandbox, sessionId, runId, env, extras = {}) {
  requireEnabled(env);
  return listPermissions(sandbox, sessionId, runId, {
    jobs: resolveJobs(env, extras) || extras.jobs,
  });
}

async function resolveForRequest(sandbox, sessionId, runId, permissionId, decision, env, extras = {}) {
  requireEnabled(env);
  return resolvePermission(sandbox, sessionId, runId, permissionId, decision, {
    permissionPolicy: extras.permissionPolicy,
    llmTurn: extras.llmTurn || extras.complete,
    providerComplete: extras.providerComplete || extras.chatComplete,
    createClient: extras.createClient,
    modelAlias: extras.modelAlias,
    env,
    jobs: resolveJobs(env, extras) || extras.jobs,
  });
}

async function forgetSession(sandbox, sessionId, jobs) {
  forget(sandbox, sessionId);
  if (jobs) await forgetDurable(sandbox, sessionId, jobs);
}

module.exports = {
  requireEnabled,
  runSession,
  listRuns,
  getRun,
  cancelRun,
  listPermissions,
  resolvePermission,
  forget,
  forgetSession,
  runForRequest,
  listForRequest,
  getForRequest,
  cancelForRequest,
  listPermissionsForRequest,
  resolveForRequest,
};
