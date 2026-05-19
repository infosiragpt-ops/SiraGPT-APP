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
 *   createNotification(prisma, { userId, type, title, message,
 *                                 severity, metadata })  → Promise<Notification>
 *   handleTriggerEvent(prisma, event, payload, userId)  → Promise<void>
 *   listNotifications(prisma, userId, opts)             → Promise<{ items, total, unreadCount }>
 *   markRead(prisma, userId, notificationId)            → Promise<boolean>
 *   markAllRead(prisma, userId)                          → Promise<number>
 *
 * The handler is best-effort: any DB error is swallowed + logged so
 * the surrounding event publish never breaks because of an inbox-row
 * failure.
 */

const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

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
  try {
    return await prisma.notification.create({
      data: { userId, type, title, message, severity, metadata },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[user-notifications] create failed:', err?.message || err);
    return null;
  }
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
      const row = await createNotification(prisma, {
        userId: target.id,
        type: 'org_invitation',
        title: 'New organization invitation',
        message: `You have been invited to join an organization as ${String(p.role || 'MEMBER')}.`,
        severity: 'info',
        metadata: {
          orgId: p.orgId || null,
          invitationId: p.invitationId || null,
          role: p.role || null,
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

module.exports = {
  createNotification,
  handleTriggerEvent,
  listNotifications,
  markRead,
  markAllRead,
  VALID_SEVERITIES,
};
