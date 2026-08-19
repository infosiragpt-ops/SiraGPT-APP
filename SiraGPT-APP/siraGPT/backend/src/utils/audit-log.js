/**
 * audit-log — thin wrapper around the existing `AuditLog` Prisma model
 * (see backend/prisma/schema.prisma).
 *
 * Goal of this helper: give every state-changing route ONE call site
 * (`writeAuditLog(prisma, { ... })`) that:
 *   1. Never throws — audit writes must not break the wrapping request.
 *   2. Pulls request context (ip, ua, requestId) when a req is passed.
 *   3. Maps the cycle-14 task vocabulary (`userId`, `resource`,
 *      `resourceId`, `ip`, `ua`) onto the richer existing schema
 *      (`actorType`, `actorId`, `resourceType`, `resourceId`,
 *      `metadata.ip`, `metadata.ua`).
 *
 * Designed for fire-and-forget usage: the caller does
 * `void writeAuditLog(...)` and never awaits unless they care about
 * ordering relative to a response.
 */

'use strict';

const { AuditLogRepository } = require('../repositories/AuditLogRepository');
const { withAccelerateRetry } = require('./prisma-accelerate-retry');

// Memoise repository instances keyed by the passed-in prisma client.
// Tests pass narrow mocks (sometimes a fresh one per call) so we
// can't assume identity across the process — but for the real client
// from ../config/database this cache hits on every call after the
// first, avoiding a per-write allocation.
const _repoCache = new WeakMap();
function _repoFor(prisma) {
  if (!prisma || typeof prisma !== 'object') return null;
  let repo = _repoCache.get(prisma);
  if (!repo) {
    repo = new AuditLogRepository({ prisma, withRetry: withAccelerateRetry });
    _repoCache.set(prisma, repo);
  }
  return repo;
}

/**
 * @typedef {object} AuditEntry
 * @property {string} action — imperative verb ('login', 'login_failed',
 *   'impersonate', 'payment_instant', 'user_delete', 'user_export', …)
 * @property {string} [userId] — actor user id (mapped to actorId/actorType=user)
 * @property {string} [actorName] — optional human label (email)
 * @property {string} [resource] — domain noun ('user', 'payment', 'chat')
 * @property {string} [resourceId]
 * @property {object} [before] — pre-state snapshot
 * @property {object} [after] — post-state snapshot
 * @property {object} [metadata] — free-form context (merged with ip/ua)
 * @property {string[]} [tags] — short keyword tags (e.g. ['security','login'])
 *   to categorise the audit row. Normalised (lowercased, deduped, trimmed,
 *   non-empty strings only) and stored under `metadata.tags` so existing
 *   queries / DSL filters can grep them without a schema change.
 * @property {string} [ip] — falls back to req.ip
 * @property {string} [ua] — falls back to req.headers['user-agent']
 * @property {string} [actorType] — defaults to 'user' if userId, else 'system'
 * @property {import('express').Request} [req] — optional Express req for ip/ua/requestId
 */

/**
 * Persist an audit-log row. Never throws — errors are logged to
 * stderr with an [AUDIT] tag so they remain greppable.
 *
 * @param {{ auditLog: { create: Function } }} prisma
 * @param {AuditEntry} entry
 */
async function writeAuditLog(prisma, entry) {
  const repo = _repoFor(prisma);
  if (!repo || !repo._modelAvailable()) {
    // Prisma client without AuditLog model — silently ignore so the
    // caller doesn't blow up in tests that mock prisma narrowly.
    return null;
  }
  if (!entry || typeof entry !== 'object' || typeof entry.action !== 'string') {
    console.warn('[AUDIT] skip: invalid entry (action required)');
    return null;
  }

  const req = entry.req;
  const ip = entry.ip
    ?? (req && (req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress))
    ?? null;
  const ua = entry.ua
    ?? (req && req.headers?.['user-agent'])
    ?? null;
  const requestId = req && (req.requestId || req.headers?.['x-request-id']);

  const userId = entry.userId ?? (req && req.user && req.user.id) ?? null;
  const actorType = entry.actorType || (userId ? 'user' : 'system');
  const actorName = entry.actorName ?? (req && req.user && req.user.email) ?? null;

  const metadata = {
    ...(entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}),
  };
  if (ip != null) metadata.ip = String(ip);
  if (ua != null) metadata.ua = String(ua);
  if (requestId != null) metadata.requestId = String(requestId);

  // Tags — normalise (string, trim, lowercase, dedupe, drop empties) and
  // fold into metadata.tags so consumers can filter without a schema
  // migration. Invalid `tags` payloads are silently dropped: audit
  // writers must never fail because a caller passed junk.
  if (Array.isArray(entry.tags)) {
    const seen = new Set();
    const cleaned = [];
    for (const raw of entry.tags) {
      if (typeof raw !== 'string') continue;
      const t = raw.trim().toLowerCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      cleaned.push(t);
    }
    if (cleaned.length) metadata.tags = cleaned;
  }

  // Repository handles its own try/catch and logs failures with the
  // same `[AUDIT] write failed` prefix the previous inline path used,
  // so ops greps continue to work unchanged.
  return repo.safeCreate({
    actorType,
    actorId: userId,
    actorName,
    resourceType: entry.resource || actorType, // fallback so the NOT NULL column always has a value
    resourceId: entry.resourceId ?? null,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
    diff: null,
    metadata: Object.keys(metadata).length ? metadata : null,
  });
}

module.exports = { writeAuditLog };
