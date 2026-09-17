'use strict';

/**
 * agent-approvals — persistent approval inbox for agent permission requests.
 *
 * Roadmap E23 (docs/chat/cowork-pro-roadmap.md, "Bandeja de aprobaciones"):
 * today a `permission_request` card lives inline in the stream and expires
 * after ~2 minutes if the user is not watching. This service makes those
 * requests durable and resolvable later, so detached/unattended runs can be
 * approved from a global inbox (default TTL 24 h).
 *
 * Design notes:
 *   - Store is injectable (`createMemoryStore()` provided) so a Prisma-backed
 *     store can be swapped in without touching the service logic.
 *   - Clock is injectable (`now`) for deterministic TTL tests.
 *   - NO method throws on weird input: every result is a typed object and
 *     failures come back as `{ ok: false, error }`.
 *   - `resolve` is idempotent: the second resolution returns the first one
 *     (flagged `alreadyResolved: true`); a different user gets `forbidden`.
 *   - `onResolved` subscribers fire exactly once per approval, on the first
 *     effective resolution only. Subscriber errors never break the flow.
 */

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const MIN_TTL_MS = 1_000;

const STATUS = Object.freeze({
  PENDING: 'pending',
  ALLOWED: 'allowed',
  DENIED: 'denied',
  EXPIRED: 'expired',
});

const DECISIONS = Object.freeze(['allow', 'deny']);

// ── helpers ─────────────────────────────────────────────────────────

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asOptionalString(value, maxLen = 4_000) {
  if (typeof value !== 'string') return '';
  return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
}

function cloneRecord(record) {
  return record ? { ...record } : null;
}

// ── memory store (default, injectable contract) ─────────────────────

/**
 * In-memory reference implementation of the store contract:
 *   insert(record)          → void
 *   get(id)                 → record | null (copy)
 *   update(id, patch)       → record | null (copy of the merged record)
 *   list()                  → record[] (copies)
 */
function createMemoryStore() {
  const records = new Map();
  return {
    insert(record) {
      records.set(record.id, { ...record });
    },
    get(id) {
      return cloneRecord(records.get(id));
    },
    update(id, patch) {
      const existing = records.get(id);
      if (!existing) return null;
      Object.assign(existing, patch);
      return { ...existing };
    },
    list() {
      return Array.from(records.values(), (record) => ({ ...record }));
    },
  };
}

// ── service ─────────────────────────────────────────────────────────

function createApprovalService({
  store = createMemoryStore(),
  now = Date.now,
  defaultTtlMs = DEFAULT_TTL_MS,
} = {}) {
  const listeners = new Set();
  let seq = 0; // stable ordering even when the (fake) clock does not move

  const clock = typeof now === 'function' ? now : Date.now;
  const baseTtl = Number.isFinite(defaultTtlMs) && defaultTtlMs >= MIN_TTL_MS
    ? defaultTtlMs
    : DEFAULT_TTL_MS;

  function safeNow() {
    try {
      const t = Number(clock());
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  }

  function emitResolved(payload) {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // Subscriber errors must never affect the approval flow.
      }
    }
  }

  /** Lazily flip a stale pending record to `expired`. Returns the fresh copy. */
  function refreshExpiry(record, at) {
    if (!record || record.status !== STATUS.PENDING) return record;
    if (at < record.expiresAt) return record;
    return store.update(record.id, { status: STATUS.EXPIRED, expiredAt: at }) || record;
  }

  function request({ userId, chatId, tool, argsSummary, humanDescription, ttlMs } = {}) {
    try {
      if (!isNonEmptyString(userId)) return { ok: false, error: 'invalid_user' };
      if (!isNonEmptyString(chatId)) return { ok: false, error: 'invalid_chat' };
      if (!isNonEmptyString(tool)) return { ok: false, error: 'invalid_tool' };

      const effectiveTtl = Number.isFinite(ttlMs) && ttlMs >= MIN_TTL_MS ? ttlMs : baseTtl;
      const createdAt = safeNow();
      const record = {
        id: `appr_${crypto.randomUUID()}`,
        seq: seq += 1,
        userId,
        chatId,
        tool,
        argsSummary: asOptionalString(argsSummary),
        humanDescription: asOptionalString(humanDescription),
        status: STATUS.PENDING,
        createdAt,
        expiresAt: createdAt + effectiveTtl,
        decision: null,
        resolvedAt: null,
      };
      store.insert(record);
      return { ok: true, id: record.id, status: record.status, expiresAt: record.expiresAt };
    } catch {
      return { ok: false, error: 'store_error' };
    }
  }

  function resolve({ id, userId, decision } = {}) {
    try {
      if (!isNonEmptyString(id)) return { ok: false, error: 'not_found' };
      const record = store.get(id);
      if (!record) return { ok: false, error: 'not_found' };

      // Ownership first: another user must never learn or change the outcome.
      if (!isNonEmptyString(userId) || userId !== record.userId) {
        return { ok: false, error: 'forbidden' };
      }

      // Idempotency: the second resolution returns the first, whatever the
      // decision on the retry was.
      if (record.status === STATUS.ALLOWED || record.status === STATUS.DENIED) {
        return {
          ok: true,
          id: record.id,
          status: record.status,
          decision: record.decision,
          resolvedAt: record.resolvedAt,
          alreadyResolved: true,
        };
      }

      const at = safeNow();
      const fresh = refreshExpiry(record, at);
      if (fresh.status === STATUS.EXPIRED) return { ok: false, error: 'expired' };

      if (!DECISIONS.includes(decision)) return { ok: false, error: 'invalid_decision' };

      const status = decision === 'allow' ? STATUS.ALLOWED : STATUS.DENIED;
      const updated = store.update(id, { status, decision, resolvedAt: at });
      if (!updated) return { ok: false, error: 'not_found' };

      emitResolved({
        id: updated.id,
        userId: updated.userId,
        chatId: updated.chatId,
        tool: updated.tool,
        status: updated.status,
        decision: updated.decision,
        resolvedAt: updated.resolvedAt,
      });

      return {
        ok: true,
        id: updated.id,
        status: updated.status,
        decision: updated.decision,
        resolvedAt: updated.resolvedAt,
        alreadyResolved: false,
      };
    } catch {
      return { ok: false, error: 'store_error' };
    }
  }

  function get(id) {
    try {
      if (!isNonEmptyString(id)) return { ok: false, error: 'not_found' };
      const record = refreshExpiry(store.get(id), safeNow());
      if (!record) return { ok: false, error: 'not_found' };
      return { ok: true, approval: cloneRecord(record) };
    } catch {
      return { ok: false, error: 'store_error' };
    }
  }

  function listPending({ userId } = {}) {
    try {
      if (!isNonEmptyString(userId)) return { ok: false, error: 'invalid_user' };
      const at = safeNow();
      const approvals = store
        .list()
        .filter((record) => record.userId === userId)
        .map((record) => refreshExpiry(record, at))
        .filter((record) => record && record.status === STATUS.PENDING)
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
        .map(cloneRecord);
      return { ok: true, approvals };
    } catch {
      return { ok: false, error: 'store_error' };
    }
  }

  function sweepExpired() {
    try {
      const at = safeNow();
      let expired = 0;
      for (const record of store.list()) {
        if (record.status !== STATUS.PENDING) continue;
        if (at < record.expiresAt) continue;
        if (store.update(record.id, { status: STATUS.EXPIRED, expiredAt: at })) expired += 1;
      }
      return { ok: true, expired };
    } catch {
      return { ok: false, error: 'store_error' };
    }
  }

  function onResolved(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return { request, resolve, get, listPending, sweepExpired, onResolved };
}

module.exports = {
  createApprovalService,
  createMemoryStore,
  APPROVAL_STATUS: STATUS,
  APPROVAL_DECISIONS: DECISIONS,
  DEFAULT_APPROVAL_TTL_MS: DEFAULT_TTL_MS,
};
