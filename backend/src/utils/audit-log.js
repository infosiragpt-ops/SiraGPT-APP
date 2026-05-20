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
  if (!prisma || !prisma.auditLog || typeof prisma.auditLog.create !== 'function') {
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

  try {
    return await prisma.auditLog.create({
      data: {
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
      },
    });
  } catch (err) {
    // Audit failures must never break the wrapping request.
    console.error('[AUDIT] write failed:', err?.message || err, 'action=', entry.action);
    return null;
  }
}

module.exports = { writeAuditLog };
