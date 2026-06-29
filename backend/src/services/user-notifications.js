'use strict';

/**
 * user-notifications — Ratchet 45, Task 1.
 *
 * Centralised helper for creating in-app `Notification` rows from
 * trigger-registry events. Keeps the mapping between an event name
 * and (title / message / severity / type) in one place so the FE
 * inbox stays consistent regardless of which route publishes the
 * event.
 *
 * Public API:
 *   createNotification(prisma, { userId, orgId?, type, title, message,
 *                                 severity, metadata })  → Promise<Notification>
 *   handleTriggerEvent(prisma, event, payload, userId)  → Promise<void>
 *   listNotifications(prisma, userId, opts)             → Promise<{ items, total, unreadCount }>
 *   markRead(prisma, userId, notificationId)            → Promise<boolean>
 *   markAllRead(prisma, userId)                          → Promise<number>
 *   broadcastOrgNotification(prisma, { orgId, title, message,
 *                                       severity?, type?, roleFilter?,
 *                                       metadata?, createdById? })
 *     → Promise<{ orgId, created, skipped, recipients, total,
 *                 notifications }>
 *
 * The handler is best-effort: any DB error is swallowed + logged so
 * the surrounding event publish never breaks because of an inbox-row
 * failure.
 */

const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

// Ratchet 44 — org-broadcast role gate. Mirrors `isValidRole` from
// `orgs-service` but kept local so the service does not pull in the
// org-service barrel (which loads prisma + email helpers).
const VALID_BROADCAST_ROLES = new Set(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);

// Hard cap on the per-broadcast fan-out so a misconfigured request
// against a huge org (or a typo in `roleFilter`) can't produce tens
// of thousands of writes in a single tick. The endpoint will still
// succeed but additional members are skipped + counted in the
// `skipped` tally so callers can paginate / re-issue if needed.
const BROADCAST_FAN_OUT_LIMIT = 5000;

function clampStr(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

async function createNotification(prisma, args) {
  if (!prisma || !prisma.notification) return null;
  const userId = typeof args?.userId === 'string' ? args.userId : '';
  if (!userId) return null;
  const type = clampStr(args?.type || 'generic', 64) || 'generic';
  const title = clampStr(args?.title || '', 200) || 'Notification';
  const message = clampStr(args?.message || '', 4000) || '';
  const severity = VALID_SEVERITIES.has(args?.severity) ? args.severity : 'info';
  const metadata = args?.metadata && typeof args.metadata === 'object' ? args.metadata : null;
  // Ratchet 44 — optional org-scope stamp (cycle 165). Always passed
  // through as a plain string column; when undefined we omit the key
  // entirely so older prisma clients without the field still work.
  const orgId = typeof args?.orgId === 'string' && args.orgId ? args.orgId : null;
  const data = { userId, type, title, message, severity, metadata };
  if (orgId) data.orgId = orgId;
  let row;
  try {
    row = await prisma.notification.create({ data });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[user-notifications] create failed:', err?.message || err);
    return null;
  }

  // Ratchet 45, Task 2 — fan critical notifications out to the user's
  // web-push subscriptions (cycle 22). Best-effort: any failure here
  // must not affect the inbox-row that we just persisted.
  if (row && severity === 'critical') {
    try {
      // eslint-disable-next-line global-require
      const webpush = require('./webpush-delivery');
      // Fire-and-forget — do NOT await, the row is what the caller cares
      // about. Errors are swallowed inside maybeDeliver.
      Promise.resolve(webpush.maybeDeliver(prisma, row)).catch(() => { /* noop */ });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[user-notifications] webpush dispatch failed:', err?.message || err);
    }

    // Ratchet 45 — also try SMS via Twilio when the user opted-in by
    // setting `User.phone` and Twilio env is configured. The bridge
    // short-circuits gracefully when twilio isn't installed or env is
    // missing, so this is a true no-op in dev environments.
    try {
      // eslint-disable-next-line global-require
      const sms = require('./sms-delivery');
      Promise.resolve(sms.maybeDeliver(prisma, row)).catch(() => { /* noop */ });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[user-notifications] sms dispatch failed:', err?.message || err);
    }
  }

  return row;
}

/**
 * Map a trigger event + payload into 0..N notification rows.
 *
 * - `org.invitation.created` → notify the invited user (lookup by email).
 * - `org.announcement.created` → notify EVERY org member, but only when
 *    `severity === 'critical'` so we don't spam the inbox for minor news.
 * - `org.member.role_changed` → notify the target user.
 * - `payment.failed` → notify the paying user (`userId` argument).
 *
 * Returns the array of created rows (may be empty).
 */
async function handleTriggerEvent(prisma, event, payload, userId) {
  if (!prisma) return [];
  const p = payload && typeof payload === 'object' ? payload : {};
  try {
    if (event === 'payment.failed') {
      // payments.js already creates a notification inline for the
      // Stripe webhook path; create here ONLY when called from a code
      // path that didn't already do so (marker on the payload).
      if (p.skipInbox === true) return [];
      const row = await createNotification(prisma, {
        userId,
        type: 'payment_failed',
        title: 'Payment Failed',
        message: p.message
          || (p.amount != null
            ? `Your payment of ${p.amount} ${p.currency || ''}`.trim() + ' could not be processed.'
            : 'A recent payment could not be processed.'),
        severity: 'warning',
        metadata: {
          invoiceId: p.invoiceId || null,
          amount: p.amount ?? null,
          currency: p.currency || null,
        },
      });
      return row ? [row] : [];
    }

    if (event === 'org.invitation.created') {
      const email = typeof p.email === 'string' ? p.email.toLowerCase() : '';
      if (!email || !prisma.user) return [];
      const target = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      }).catch(() => null);
      if (!target?.id) return []; // invite to a non-registered email → no inbox row
      const orgName = clampStr(p.orgName || p.orgSlug || 'SiraGPT', 160) || 'SiraGPT';
      const inviter = clampStr(p.inviterName || p.inviterEmail || 'Un administrador', 160)
        || 'Un administrador';
      const projectName = clampStr(p.projectName || '', 160);
      const message = projectName
        ? `${inviter} te invitó a colaborar en ${projectName} dentro de ${orgName}.`
        : `${inviter} te invitó a unirte al equipo ${orgName} en SiraGPT.`;
      const row = await createNotification(prisma, {
        userId: target.id,
        type: 'org_invitation',
        orgId: typeof p.orgId === 'string' ? p.orgId : undefined,
        title: `Invitación a ${orgName}`,
        message,
        severity: 'info',
        metadata: {
          orgId: p.orgId || null,
          orgName,
          orgSlug: p.orgSlug || null,
          invitationId: p.invitationId || null,
          role: p.role || null,
          projectName: projectName || null,
          workspaceUrl: p.workspaceUrl || null,
          magicLink: p.magicLink || null,
          actionUrl: p.magicLink || null,
          invitedByUserId: p.invitedByUserId || null,
          inviterName: p.inviterName || null,
          inviterEmail: p.inviterEmail || null,
          expiresAt: p.expiresAt || null,
        },
      });
      return row ? [row] : [];
    }

    if (event === 'org.member.role_changed') {
      const targetUserId = typeof p.targetUserId === 'string' ? p.targetUserId : '';
      if (!targetUserId) return [];
      const row = await createNotification(prisma, {
        userId: targetUserId,
        type: 'role_changed',
        title: 'Your role was updated',
        message: `Your role in the organization changed from ${p.previousRole || 'previous'} to ${p.newRole || 'new'}.`,
        severity: 'info',
        metadata: {
          orgId: p.orgId || null,
          previousRole: p.previousRole || null,
          newRole: p.newRole || null,
        },
      });
      return row ? [row] : [];
    }

    if (event === 'org.announcement.created') {
      // Only critical announcements broadcast into the inbox.
      if (p.severity !== 'critical') return [];
      const orgId = typeof p.orgId === 'string' ? p.orgId : '';
      if (!orgId || !prisma.orgMembership) return [];
      const members = await prisma.orgMembership.findMany({
        where: { orgId },
        select: { userId: true },
      }).catch(() => []);
      const created = [];
      for (const m of members) {
        if (!m?.userId) continue;
        const row = await createNotification(prisma, {
          userId: m.userId,
          type: 'announcement',
          title: clampStr(p.title || 'Important announcement', 200),
          message: clampStr(p.body || p.message || 'A critical announcement was posted.', 4000),
          severity: 'critical',
          metadata: {
            orgId,
            announcementId: p.announcementId || null,
            createdById: p.createdById || null,
          },
        });
        if (row) created.push(row);
      }
      return created;
    }

    return [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[user-notifications] handle failed:', event, err?.message || err);
    return [];
  }
}

/**
 * List notifications with cursor-style pagination + optional unread
 * filter. `cursor` is the previous page's last `id`; ordering is by
 * `createdAt DESC, id DESC` so duplicate timestamps don't collide.
 */
async function listNotifications(prisma, userId, opts = {}) {
  if (!prisma || !prisma.notification || !userId) {
    return { items: [], total: 0, unreadCount: 0, nextCursor: null };
  }
  const take = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  const filter = String(opts.filter || 'all').toLowerCase();
  const where = { userId };
  if (filter === 'unread') where.read = false;
  else if (filter === 'read') where.read = true;
  const cursorObj = opts.cursor ? { id: String(opts.cursor) } : undefined;
  const items = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursorObj ? { cursor: cursorObj, skip: 1 } : {}),
  });
  const hasMore = items.length > take;
  const page = hasMore ? items.slice(0, take) : items;
  const [total, unreadCount] = await Promise.all([
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);
  return {
    items: page,
    total,
    unreadCount,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

async function markRead(prisma, userId, notificationId) {
  if (!prisma?.notification || !userId || !notificationId) return false;
  const result = await prisma.notification.updateMany({
    where: { id: String(notificationId), userId },
    data: { read: true, readAt: new Date() },
  });
  return (result?.count || 0) > 0;
}

async function markAllRead(prisma, userId) {
  if (!prisma?.notification || !userId) return 0;
  const result = await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true, readAt: new Date() },
  });
  return result?.count || 0;
}

/**
 * Ratchet 44 — broadcast a notification to every member of an org
 * (optionally filtered to a single role). Returns counters + the list
 * of created rows so the caller can include them in its response /
 * audit log.
 *
 * Args:
 *   orgId        — required org identifier
 *   title        — required, clamped to 200 chars
 *   message      — required, clamped to 4000 chars
 *   severity     — optional, one of VALID_SEVERITIES (default 'info')
 *   type         — optional, defaults to 'org_broadcast'
 *   roleFilter   — optional, when set restricts recipients to members
 *                  holding that role (must be in VALID_BROADCAST_ROLES)
 *   metadata     — optional opaque JSON
 *   createdById  — optional id of the admin who issued the broadcast;
 *                  stamped into metadata so the FE can render "from X"
 *
 * Behaviour:
 *  - Silently no-ops (returns counters with `created:0`) when the org
 *    has no matching members; the route layer treats this as 200 OK.
 *  - Caps fan-out at BROADCAST_FAN_OUT_LIMIT recipients per call.
 *  - Best-effort per-row: a single create failure does not abort the
 *    rest of the fan-out (mirrors `handleTriggerEvent`).
 */
async function broadcastOrgNotification(prisma, args) {
  const empty = {
    orgId: typeof args?.orgId === 'string' ? args.orgId : '',
    created: 0,
    skipped: 0,
    recipients: 0,
    total: 0,
    notifications: [],
  };
  if (!prisma || !prisma.notification || !prisma.orgMembership) return empty;
  const orgId = empty.orgId;
  if (!orgId) return empty;

  const title = clampStr(args?.title || '', 200).trim();
  const message = clampStr(args?.message || '', 4000).trim();
  if (!title || !message) return empty;

  const severity = VALID_SEVERITIES.has(args?.severity) ? args.severity : 'info';
  const type = clampStr(args?.type || 'org_broadcast', 64) || 'org_broadcast';
  const metadataIn = args?.metadata && typeof args.metadata === 'object' ? args.metadata : null;
  const createdById = typeof args?.createdById === 'string' ? args.createdById : null;

  const roleFilter = typeof args?.roleFilter === 'string' && args.roleFilter
    ? args.roleFilter.toUpperCase()
    : null;
  if (roleFilter && !VALID_BROADCAST_ROLES.has(roleFilter)) {
    // Caller asked for a role we don't recognise → no recipients,
    // surfaces as `created:0` so the route can decide whether to 400.
    return { ...empty, error: 'invalid_role_filter' };
  }

  const where = { orgId };
  if (roleFilter) where.role = roleFilter;

  let members;
  try {
    members = await prisma.orgMembership.findMany({
      where,
      select: { userId: true, role: true },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[user-notifications] broadcast lookup failed:', err?.message || err);
    return empty;
  }
  if (!Array.isArray(members)) members = [];

  const total = members.length;
  const slice = members.slice(0, BROADCAST_FAN_OUT_LIMIT);
  const skipped = total - slice.length;

  const notifications = [];
  let created = 0;
  for (const m of slice) {
    if (!m?.userId) continue;
    const metadata = {
      ...(metadataIn || {}),
      orgId,
      broadcast: true,
      recipientRole: m.role || null,
      createdById,
      roleFilter: roleFilter || null,
    };
    // eslint-disable-next-line no-await-in-loop
    const row = await createNotification(prisma, {
      userId: m.userId,
      orgId,
      type,
      title,
      message,
      severity,
      metadata,
    });
    if (row) {
      created += 1;
      notifications.push(row);
    }
  }

  return {
    orgId,
    created,
    skipped,
    recipients: slice.length,
    total,
    notifications,
  };
}

module.exports = {
  createNotification,
  handleTriggerEvent,
  listNotifications,
  markRead,
  markAllRead,
  broadcastOrgNotification,
  VALID_SEVERITIES,
  VALID_BROADCAST_ROLES,
  BROADCAST_FAN_OUT_LIMIT,
};
