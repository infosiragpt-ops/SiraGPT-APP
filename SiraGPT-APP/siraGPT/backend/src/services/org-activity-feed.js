'use strict';

/**
 * org-activity-feed — Ratchet 44.
 *
 * Builds a unified, paginated activity feed for an organisation by
 * aggregating events from several internal sources. Used by
 * `GET /api/orgs/:id/activity` (MEMBER+).
 *
 * Sources merged today:
 *   1. AuditLog rows tagged with `metadata.orgId` (membership changes,
 *      billing upgrades, invitations, webhooks, settings updates, …).
 *      A safe-list controls which `action`s a non-admin member is
 *      allowed to see; sensitive payloads (`before`, `after`, `diff`)
 *      are never echoed in the unified feed.
 *   2. OrgAnnouncement rows — surface the creation event so members can
 *      see "Alice posted an announcement: Maintenance window" in the
 *      same timeline.
 *
 * Output shape per item:
 *   {
 *     type:    'audit' | 'announcement',
 *     ts:      ISO-8601 string,
 *     actor:   { id?: string, name?: string, kind?: string },
 *     summary: string,        // human-readable, no PII / no secrets
 *     refId:   string|null,   // resourceId / announcementId — for deep-links
 *     source:  string,        // origin tag (e.g. 'audit_log', 'announcement')
 *     action?: string,        // raw audit action when type === 'audit'
 *     severity?: string,      // announcement severity when applicable
 *   }
 *
 * Cursor pagination:
 *   - `cursor` is an opaque base64-url-encoded JSON `{ts,id}` pair.
 *   - The handler sorts the merged feed strictly DESC by ts (id as
 *     tie-breaker) and returns `nextCursor` pointing one past the last
 *     item, or `null` when the page is the tail.
 *
 * Design notes:
 *   - Pure function: no Prisma client construction here; the caller
 *     passes in a prisma instance so tests can fake narrowly.
 *   - Defensive: missing models / failed queries degrade to an empty
 *     contribution from that source instead of throwing.
 *   - No PII / no secrets: summaries are derived from `action` codes;
 *     `before` / `after` are deliberately dropped.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// Overscan factor — fetch a bit more than `limit` from each source so the
// post-merge trim doesn't leave gaps when one source dominates a window.
const SOURCE_OVERSCAN = 2;

// Audit actions that are safe to surface to MEMBER+ in the feed. Keep
// this list conservative: anything carrying secrets (api-keys, webhook
// rotations, SSO config, billing details) is admin-only and excluded.
const MEMBER_SAFE_AUDIT_ACTIONS = new Set([
  'org_create',
  'org_invite_create',
  'org_invite_accept',
  'org_invite_revoke',
  'org_member_role_change',
  'org_member_leave',
  'org_member_remove',
  'org_ownership_transfer',
  'org_announcement_create',
  'org_announcement_update',
  'org_announcement_delete',
  'org_billing_upgrade',
  'chat_share_to_org',
]);

// Human summaries for known audit actions. Falls back to a generic
// "<action>" rendering when not listed — that keeps newly-added actions
// visible without code changes, just less polished.
const AUDIT_ACTION_SUMMARIES = Object.freeze({
  org_create: 'Created the organization',
  org_invite_create: 'Invited a new member',
  org_invite_accept: 'Joined the organization',
  org_invite_revoke: 'Revoked a pending invitation',
  org_member_role_change: 'Changed a member role',
  org_member_leave: 'Left the organization',
  org_member_remove: 'Removed a member',
  org_ownership_transfer: 'Transferred ownership',
  org_announcement_create: 'Posted an announcement',
  org_announcement_update: 'Updated an announcement',
  org_announcement_delete: 'Deleted an announcement',
  org_billing_upgrade: 'Upgraded the billing plan',
  chat_share_to_org: 'Shared a chat with the org',
});

function clampLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function encodeCursor(ts, id) {
  if (!ts) return null;
  const ms = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const raw = JSON.stringify({ t: ms, i: id || '' });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.t !== 'number') return null;
    if (!Number.isFinite(obj.t)) return null;
    return { ts: new Date(obj.t), id: typeof obj.i === 'string' ? obj.i : '' };
  } catch (_) {
    return null;
  }
}

function summarizeAudit(row) {
  const known = AUDIT_ACTION_SUMMARIES[row.action];
  if (known) return known;
  // Generic fallback — humanise snake_case.
  return String(row.action || 'activity').replace(/_/g, ' ');
}

function normalizeAudit(row) {
  if (!row || !row.createdAt) return null;
  return {
    type: 'audit',
    ts: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString(),
    actor: {
      id: row.actorId || null,
      name: row.actorName || null,
      kind: row.actorType || null,
    },
    summary: summarizeAudit(row),
    refId: row.resourceId || null,
    source: 'audit_log',
    action: row.action,
    // Sort key — preserved internally; stripped before JSON response.
    _id: row.id,
    _ts: row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime(),
  };
}

function normalizeAnnouncement(row) {
  if (!row || !row.createdAt) return null;
  return {
    type: 'announcement',
    ts: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString(),
    actor: {
      id: row.createdById || null,
      name: null,
      kind: 'user',
    },
    summary: row.title ? `Announcement: ${String(row.title).slice(0, 140)}` : 'Posted an announcement',
    refId: row.id,
    source: 'announcement',
    severity: row.severity || 'info',
    _id: row.id,
    _ts: row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime(),
  };
}

/**
 * Compare two normalized items for DESC ordering (newest first), with
 * the synthetic id as tie-breaker so cursors are deterministic.
 */
function cmpDesc(a, b) {
  if (a._ts !== b._ts) return b._ts - a._ts;
  return String(b._id || '').localeCompare(String(a._id || ''));
}

async function fetchAudit(prisma, orgId, before, take) {
  if (!prisma?.auditLog?.findMany) return [];
  const where = {
    metadata: { path: ['orgId'], equals: orgId },
    action: { in: Array.from(MEMBER_SAFE_AUDIT_ACTIONS) },
  };
  if (before) {
    where.createdAt = { lt: before };
  }
  try {
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    });
    return Array.isArray(rows) ? rows.map(normalizeAudit).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

async function fetchAnnouncements(prisma, orgId, before, take) {
  if (!prisma?.orgAnnouncement?.findMany) return [];
  const where = { orgId };
  if (before) {
    where.createdAt = { lt: before };
  }
  try {
    const rows = await prisma.orgAnnouncement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    });
    return Array.isArray(rows) ? rows.map(normalizeAnnouncement).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

/**
 * Build the activity feed for an org.
 *
 * @param {object}  prisma                       prisma client (or fake)
 * @param {string}  orgId
 * @param {object}  [opts]
 * @param {number}  [opts.limit]                 page size (1..100, default 25)
 * @param {string|null} [opts.cursor]            opaque cursor from previous page
 * @returns {Promise<{items: object[], nextCursor: string|null, limit: number}>}
 */
async function buildActivityFeed(prisma, orgId, opts = {}) {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const before = cursor && cursor.ts ? cursor.ts : null;
  const take = limit * SOURCE_OVERSCAN + 1;

  const [audit, announcements] = await Promise.all([
    fetchAudit(prisma, orgId, before, take),
    fetchAnnouncements(prisma, orgId, before, take),
  ]);

  // Merge + sort DESC.
  let merged = [...audit, ...announcements].sort(cmpDesc);

  // If a cursor was provided, drop items strictly newer than the cursor
  // and the cursor row itself (id match) to make pagination stable when
  // multiple events share the same `createdAt`.
  if (cursor) {
    merged = merged.filter((it) => {
      if (it._ts > cursor.ts.getTime()) return false;
      if (it._ts === cursor.ts.getTime() && String(it._id) >= String(cursor.id)) return false;
      return true;
    });
  }

  const page = merged.slice(0, limit);
  const nextCursor = page.length === limit && merged.length > limit
    ? encodeCursor(new Date(page[page.length - 1]._ts), page[page.length - 1]._id)
    : null;

  // Strip internal sort fields before returning.
  const items = page.map(({ _id, _ts, ...rest }) => rest);

  return { items, nextCursor, limit };
}

module.exports = {
  buildActivityFeed,
  // Exposed for tests / internal reuse.
  __internals: {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MEMBER_SAFE_AUDIT_ACTIONS,
    AUDIT_ACTION_SUMMARIES,
    clampLimit,
    encodeCursor,
    decodeCursor,
    normalizeAudit,
    normalizeAnnouncement,
    cmpDesc,
  },
};
