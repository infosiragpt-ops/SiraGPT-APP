'use strict';

/**
 * 3H-BE-010 — per-session gateway DLQ. Failed turns stay visible without compose down.
 */

const DEFAULT_MAX = 100;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const RETRYABLE = new Set(['turn_timeout', 'cron_timeout', 'cron_busy', 'session_queue_full', 'cron_dispatch_unavailable', 'remote_unreachable', 'sandbox_queue_timeout']);

function createSessionDlq({ max = DEFAULT_MAX } = {}) {
  const items = [];

  function push(entry) {
    const retries = Math.max(0, Number(entry && entry.retries) || 0);
    const rec = {
      sessionKey: String(entry && entry.sessionKey || ''),
      runId: String(entry && entry.runId || ''),
      surface: entry && entry.surface || null,
      userId: entry && entry.userId ? String(entry.userId) : null,
      error: String(entry && (entry.error || entry.message) || 'turn_failed').slice(0, 300),
      retries,
      exhausted: retries >= 3 || String(entry && (entry.error || entry.message) || '') === 'dlq_exhausted',
      at: Number(entry && entry.at) || Date.now(),
    };
    items.push(rec);
    prune(Date.now());
    while (items.length > max) items.shift();
    return rec;
  }

  function prune(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
    const cut = now - ttlMs;
    while (items.length && Number(items[0].at || 0) < cut) items.shift();
    return items.length;
  }

  function list({ sessionKey, userId, limit = 50 } = {}) {
    prune();
    const cap = Math.max(1, Math.min(Number(limit) || 50, max));
    const key = sessionKey != null && sessionKey !== '' ? String(sessionKey) : null;
    const uid = userId != null && userId !== '' ? String(userId) : null;
    let filtered = items.slice();
    if (key) filtered = filtered.filter((i) => i.sessionKey === key);
    if (uid) filtered = filtered.filter((i) => i.userId === uid);
    return filtered.slice(-cap);
  }

  function retryable({ sessionKey, userId, limit = 20 } = {}) {
    return list({ sessionKey, userId, limit }).filter((i) => RETRYABLE.has(String(i.error || '')));
  }

  function snapshot() {
    return { deadLetterCount: items.length, recent: list({ limit: 10 }) };
  }

  // 3H15 leftover: count-only snapshot never includes sessionKey/userId (health/public).
  function snapshotCount() {
    prune();
    let retryableCount = 0;
    for (const i of items) {
      if (RETRYABLE.has(String(i.error || ''))) retryableCount += 1;
    }
    return { deadLetterCount: items.length, retryableDeadLetterCount: retryableCount };
  }

  // 3H15 leftover: ack only the caller's own letters (never another user).
  function ack({ userId, runId } = {}) {
    const uid = String(userId || '').trim();
    if (!uid) return { acked: 0, error: 'user_required' };
    const rid = runId != null && runId !== '' ? String(runId) : null;
    let acked = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const rec = items[i];
      if (String(rec.userId || '') !== uid) continue;
      if (rid && String(rec.runId || '') !== rid) continue;
      items.splice(i, 1);
      acked += 1;
    }
    return { acked, userId: uid };
  }

  function clear() { items.length = 0; }

  function replayWithJitter(entry, opts = {}) {
    try {
      return require('../agent-runner/engine-ops').scheduleDlqReplayCapped(entry || {}, opts);
    } catch (_) {
      try {
        return require('../agent-runner/engine-layer').scheduleDlqReplay(entry || {}, opts);
      } catch (__) {
        return { ok: false, code: 'dlq_exhausted', delayMs: 0 };
      }
    }
  }

  return { push, list, prune, retryable, snapshot, snapshotCount, ack, clear, replayWithJitter, get length() { return items.length; } };
}

module.exports = { createSessionDlq };
