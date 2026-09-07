'use strict';

/**
 * codex-run-notifier — background-jobs completion notifications.
 *
 * When a codex run finishes (completed or failed) the user may have long
 * since closed the tab that started it: the run keeps going in the
 * backend, so its end must be visible. This module writes an in-app
 * `Notification` row (the inbox already renders unknown types with a
 * default icon) and, for failures, fans out to web-push/SMS through the
 * critical-severity path in user-notifications.
 *
 * Best-effort by design: a notification failure must never flip a run's
 * outcome. Every dependency is injectable so tests can run offline
 * without Redis, Prisma or a real database.
 */

const VALID_OUTCOMES = new Set(['completed', 'failed']);

function clampGoal(goal, max = 80) {
  const text = String(goal || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildNotificationContent({ outcome, goal }) {
  const goalText = clampGoal(goal);
  const suffix = goalText ? `: ${goalText}` : '';
  if (outcome === 'completed') {
    return {
      type: 'codex_run_completed',
      title: 'Tu tarea en segundo plano terminó',
      message: `El agente completó la tarea${suffix}.`,
      severity: 'info',
    };
  }
  return {
    type: 'codex_run_failed',
    title: 'Tu tarea en segundo plano falló',
    message: `El agente no pudo completar la tarea${suffix}. Revisa el detalle en el chat.`,
    severity: 'critical',
  };
}

function createCodexRunNotifier({
  prisma = null,
  createNotification = null,
} = {}) {
  let resolvedCreate = createNotification;
  function resolveDeps() {
    if (resolvedCreate) return resolvedCreate;
    // Lazy require so unit tests can require this module with no DB layer.
    // eslint-disable-next-line global-require
    if (!prisma) {
      // eslint-disable-next-line global-require
      prisma = require('../../config/database');
    }
    // eslint-disable-next-line global-require
    resolvedCreate = createNotification
      || require('../user-notifications').createNotification;
    return resolvedCreate;
  }

  async function notifyRunFinished({ userId, chatId = null, runId, outcome, goal = '' }) {
    if (!userId || !VALID_OUTCOMES.has(outcome)) {
      return { delivered: false, reason: !userId ? 'missing_user' : 'invalid_outcome' };
    }
    let fn;
    try {
      fn = resolveDeps();
    } catch {
      return { delivered: false, reason: 'deps_unavailable' };
    }
    const content = buildNotificationContent({ outcome, goal });
    try {
      await fn(prisma, {
        userId,
        type: content.type,
        title: content.title,
        message: content.message,
        severity: content.severity,
        metadata: { runId, chatId },
      });
      return { delivered: true };
    } catch (err) {
      console.warn('[codex-run-notifier] notify failed:', err?.message || err);
      return { delivered: false, reason: 'error' };
    }
  }

  return { notifyRunFinished };
}

const defaultNotifier = createCodexRunNotifier({});

module.exports = {
  VALID_OUTCOMES,
  buildNotificationContent,
  createCodexRunNotifier,
  notifyRunFinished: defaultNotifier.notifyRunFinished,
};
