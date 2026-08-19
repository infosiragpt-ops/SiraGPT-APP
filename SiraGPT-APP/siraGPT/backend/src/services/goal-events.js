'use strict';

/**
 * goal-events — persistence façade for /goal event log.
 *
 * The research-agent emits typed events as it runs (phase / paper /
 * page / finding / decision / report / error / info). We persist
 * every event in `goal_run_events` with a monotonic per-run `seq` so
 * the chat composer can re-attach mid-run by streaming `seq > lastSeq`.
 *
 * The parent `goal_runs` row carries denormalised counters (papers /
 * findings / pages) + the current `phase` so the chat composer can
 * render a meaningful summary without replaying the full event log.
 *
 * Persistence failures NEVER throw out of these helpers — the worker
 * is best-effort: a transient DB blip should not crash the run, the
 * row is the eventually-consistent source of truth.
 */

const prisma = (() => {
  try { return require('../config/database'); } catch { return null; }
})();

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function hasModel(name) {
  return Boolean(prisma && prisma[name]);
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return fallback;
  }
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || ''));
}

function counterDeltaForType(type) {
  const t = String(type || '');
  if (t === 'paper') return { papersCount: { increment: 1 } };
  if (t === 'finding') return { findingsCount: { increment: 1 } };
  if (t === 'page') return { pagesCount: { increment: 1 } };
  return null;
}

function phaseFromEvent(event = {}) {
  if (!event || event.type !== 'phase') return null;
  const phase = String(event.phase || '').slice(0, 64);
  return phase || null;
}

/**
 * Append a single event to the run's log. Best-effort: on persistence
 * failure we log a warning (outside tests) and return `{ ok:false }`.
 *
 * Retries up to 3x on P2002 (unique seq conflict) by re-reading the
 * current event count and bumping seq — covers the rare case where
 * two concurrent appends race on the same run.
 */
async function appendEvent({ goalRunId, type, payload } = {}) {
  if (!hasModel('goalRunEvent') || !hasModel('goalRun')) {
    return { ok: false, reason: 'model_missing' };
  }
  if (!goalRunId || !type) return { ok: false, reason: 'invalid_input' };

  const safePayload = safeJson(payload, { type });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const existing = await prisma.goalRunEvent.count({ where: { goalRunId: String(goalRunId) } });
      const seq = existing + 1;
      const created = await prisma.goalRunEvent.create({
        data: {
          goalRunId: String(goalRunId),
          seq,
          type: String(type),
          payload: safePayload,
        },
      });

      // Roll up counters + phase + updatedAt on the parent row. Use
      // updateMany (no throw on missing) so a deleted row doesn't
      // crash the append path.
      const counterDelta = counterDeltaForType(type);
      const phase = phaseFromEvent({ type, ...safePayload });
      const updateData = {
        updatedAt: new Date(),
        ...(counterDelta || {}),
        ...(phase ? { phase } : {}),
      };
      await prisma.goalRun.updateMany({
        where: { id: String(goalRunId) },
        data: updateData,
      });

      return { ok: true, seq, eventId: created.id };
    } catch (err) {
      if (err?.code === 'P2002' && attempt < 2) {
        // Concurrent append picked the same seq — retry with the next
        // count() snapshot.
        continue;
      }
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[goal-events] append failed:', err?.message || err);
      }
      return { ok: false, error: err?.message || String(err) };
    }
  }
  return { ok: false, error: 'append_exhausted_retries' };
}

/**
 * List events after `lastSeq` along with the latest parent run snapshot.
 * Returns `{ ok, events, run }`. Events are ordered by seq ascending.
 */
async function listEventsSince({ goalRunId, lastSeq = -1, limit = 1000 } = {}) {
  if (!hasModel('goalRunEvent') || !hasModel('goalRun')) {
    return { ok: false, events: [], run: null, reason: 'model_missing' };
  }
  if (!goalRunId) return { ok: false, events: [], run: null, reason: 'invalid_input' };

  const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000));
  const safeLastSeq = Number.isFinite(Number(lastSeq)) ? Number(lastSeq) : -1;
  try {
    const [events, run] = await Promise.all([
      prisma.goalRunEvent.findMany({
        where: { goalRunId: String(goalRunId), seq: { gt: safeLastSeq } },
        orderBy: { seq: 'asc' },
        take: safeLimit,
      }),
      prisma.goalRun.findUnique({ where: { id: String(goalRunId) } }),
    ]);
    return { ok: true, events, run };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[goal-events] list failed:', err?.message || err);
    }
    return { ok: false, events: [], run: null, error: err?.message || String(err) };
  }
}

/**
 * Mark a run as user-cancelled. Worker polls the row every ~1.5s
 * and throws a sentinel error inside onEvent when status flips, so
 * the in-flight `research-agent.run` loop bails on the next event.
 *
 * Rejects if the row is already in a terminal status — completed /
 * failed runs can't be retroactively cancelled.
 */
async function markCancelRequested({ goalRunId, reason } = {}) {
  if (!hasModel('goalRun')) return { ok: false, reason: 'model_missing' };
  if (!goalRunId) return { ok: false, reason: 'invalid_input' };

  try {
    const row = await prisma.goalRun.findUnique({ where: { id: String(goalRunId) } });
    if (!row) return { ok: false, reason: 'not_found' };
    if (isTerminalStatus(row.status)) {
      return { ok: false, reason: 'terminal_status', status: row.status };
    }

    const now = new Date();
    const cancelReason = reason ? String(reason).slice(0, 200) : 'user_requested';
    await prisma.goalRun.update({
      where: { id: String(goalRunId) },
      data: {
        status: 'cancelled',
        cancelledAt: now,
        updatedAt: now,
        cancelReason,
      },
    });

    // Append an info event documenting the cancellation so the SSE
    // replay surface always carries a trail (best-effort).
    await appendEvent({
      goalRunId,
      type: 'info',
      payload: { type: 'info', message: 'cancellation_requested', reason: cancelReason, at: now.toISOString() },
    });

    return { ok: true, status: 'cancelled', cancelReason };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[goal-events] cancel failed:', err?.message || err);
    }
    return { ok: false, error: err?.message || String(err) };
  }
}

module.exports = {
  appendEvent,
  listEventsSince,
  markCancelRequested,
  _internal: {
    counterDeltaForType,
    isTerminalStatus,
    phaseFromEvent,
    safeJson,
  },
};
