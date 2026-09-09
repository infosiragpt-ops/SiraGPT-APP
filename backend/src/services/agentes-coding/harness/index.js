'use strict';

/**
 * agentes-coding/harness — TypeScript/Node tool loop inside a session.
 *
 * Flag: AGENTES_CODING_V2 (default OFF). API-only. See
 * docs/agentes-coding-harness.md
 */

const { isAgentesCodingV2Enabled } = require('../flags');
const { fail } = require('../coding-sandbox/errors');
const { runHarness } = require('./runner');
const { getStore, findRun, publicRun, forget, appendStep, finishRun, publicError } = require('./store');

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

async function runSession(sandbox, sessionId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  return runHarness(sandbox, sessionId, raw, opts);
}

async function listRuns(sandbox, sessionId) {
  const raw = await requireSession(sandbox, sessionId);
  return {
    ok: true,
    runs: getStore(raw).items.map((row) => publicRun(row)),
  };
}

async function getRun(sandbox, sessionId, runId) {
  const raw = await requireSession(sandbox, sessionId);
  return { ok: true, run: publicRun(findRun(raw, runId)) };
}

async function cancelRun(sandbox, sessionId, runId) {
  const raw = await requireSession(sandbox, sessionId);
  const row = findRun(raw, runId);
  if (row.status !== 'running') {
    fail('E_PARAMS', 'La ejecución ya no está en curso.');
  }
  try { row.abort.abort(); } catch (_) { /* ignore */ }
  finishRun(row, 'cancelled', publicError('E_CANCELLED'));
  if (!row.steps.some((s) => s.kind === 'cancelled')) {
    appendStep(row, 'cancelled', { label: 'Cancelado', code: 'E_CANCELLED' });
  }
  return { ok: true, run: publicRun(row) };
}

async function runForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return {
    ok: true,
    run: await runSession(sandbox, sessionId, {
      ...opts,
      env,
      llmTurn: extras.llmTurn || extras.complete || (opts && opts.llmTurn),
    }),
  };
}

async function listForRequest(sandbox, sessionId, env) {
  requireEnabled(env);
  return listRuns(sandbox, sessionId);
}

async function getForRequest(sandbox, sessionId, runId, env) {
  requireEnabled(env);
  return getRun(sandbox, sessionId, runId);
}

async function cancelForRequest(sandbox, sessionId, runId, env) {
  requireEnabled(env);
  return cancelRun(sandbox, sessionId, runId);
}

module.exports = {
  requireEnabled,
  runSession,
  listRuns,
  getRun,
  cancelRun,
  forget,
  runForRequest,
  listForRequest,
  getForRequest,
  cancelForRequest,
};
