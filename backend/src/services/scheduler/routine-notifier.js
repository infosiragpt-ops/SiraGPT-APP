'use strict';

/**
 * routine-notifier — notify the user when a scheduled routine fires.
 *
 * Mirrors codex-run-notifier: same notification content shape
 * (`codex_run_completed` / `codex_run_failed` types so the FE inbox
 * keeps one icon family for background jobs). Prisma + transport are
 * required lazily so merely loading this module never opens the DB.
 * Best-effort by design —
 * notifier errors are logged and swallowed; they never flip the run
 * outcome recorded in lastRuns. Injectable transport via deps for tests.
 */

const { createNotification } = require('../user-notifications');

const MAX_GOAL_CHARS = 80;

function clampGoal(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return '';
  return text.length > MAX_GOAL_CHARS ? `${text.slice(0, MAX_GOAL_CHARS)}…` : text;
}

function buildNotificationContent({ ok, prompt }) {
  const goalText = clampGoal(prompt);
  const suffix = goalText ? `: ${goalText}` : '';
  if (ok) {
    return {
      type: 'codex_run_completed',
      title: 'Tu rutina terminó',
      message: `La rutina programada se ejecutó${suffix}.`,
      severity: 'info',
    };
  }
  return {
    type: 'codex_run_failed',
    title: 'Tu rutina falló',
    message: `La rutina programada no pudo ejecutarse${suffix}. Revisa el detalle en el panel.`,
    severity: 'critical',
  };
}

/**
 * createRoutineNotifier({ prisma = null, createNotification = null })
 * Same DI shape as createCodexRunNotifier: inject prisma + transport in
 * tests; resolve lazily otherwise so requiring this module never opens
 * the DB connection eagerly.
 */
function createRoutineNotifier({ prisma = null, createNotification: injectedCreate = null } = {}) {
  let resolvedPrisma = prisma;
  let resolvedCreate = injectedCreate;

  function resolveDeps() {
    if (resolvedCreate) return resolvedCreate;
    if (!resolvedPrisma) resolvedPrisma = require('../../config/database');
    // Lazy require so unit tests can load this module with no DB layer.
    // eslint-disable-next-line global-require
    resolvedCreate = injectedCreate
      || require('../user-notifications').createNotification;
    return resolvedCreate;
  }

  async function notifyRoutineFinished({
    userId,
    jobId,
    runAt,
    ok,
    prompt = '',
  } = {}) {
    if (!userId || typeof ok !== 'boolean') {
      return { delivered: false, reason: 'invalid_args' };
    }
    let fn;
    let client;
    try {
      fn = resolveDeps();
      client = resolvedPrisma;
    } catch (_) {
      return { delivered: false, reason: 'deps_unavailable' };
    }
    const content = buildNotificationContent({ ok, prompt });
    try {
      await fn(client, {
        userId: String(userId),
        type: content.type,
        title: content.title,
        message: content.message,
        severity: content.severity,
        metadata: { jobId, runAt: runAt || null, source: 'routine' },
        orgId: undefined,
      });
      return { delivered: true };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[routine-notifier] notify failed:', err?.message || err);
      return { delivered: false, reason: 'error' };
    }
  }

  return { notifyRoutineFinished };
}

const defaultNotifier = createRoutineNotifier({});

module.exports = {
  MAX_GOAL_CHARS,
  clampGoal,
  buildNotificationContent,
  createRoutineNotifier,
  notifyRoutineFinished: defaultNotifier.notifyRoutineFinished,
};
