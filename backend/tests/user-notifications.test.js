'use strict';

/**
 * Ratchet 45 — user-notifications service tests.
 *
 * Covers:
 *  - handleTriggerEvent maps known events to inbox rows.
 *  - org.announcement.created only fires for severity=critical.
 *  - payment.failed with skipInbox flag is a no-op.
 *  - org.invitation.created looks up the user by email and no-ops when
 *    the email isn't registered yet.
 *  - listNotifications returns unread/read filters + cursor pagination.
 *  - markRead / markAllRead update the right rows.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/user-notifications');

function makePrisma(initialRows = [], users = []) {
  const rows = initialRows.map((r) => ({ ...r }));
  const state = { rows, autoId: rows.length };
  const prisma = {
    _rows: rows,
    notification: {
      create: async ({ data }) => {
        const row = {
          id: `n${++state.autoId}`,
          read: false,
          readAt: null,
          createdAt: new Date(Date.now() + state.autoId),
          ...data,
        };
        rows.push(row);
        return row;
      },
      findMany: async ({ where = {}, orderBy, take, cursor, skip }) => {
        let out = rows.filter((r) => {
          for (const k of Object.keys(where)) {
            if (r[k] !== where[k]) return false;
          }
          return true;
        });
        // orderBy [{createdAt:'desc'},{id:'desc'}]
        out.sort((a, b) => {
          if (a.createdAt < b.createdAt) return 1;
          if (a.createdAt > b.createdAt) return -1;
          return a.id < b.id ? 1 : -1;
        });
        if (cursor?.id) {
          const idx = out.findIndex((r) => r.id === cursor.id);
          if (idx >= 0) out = out.slice(idx + (skip || 0));
        }
        if (take) out = out.slice(0, take);
        return out;
      },
      count: async ({ where = {} }) => {
        return rows.filter((r) => {
          for (const k of Object.keys(where)) {
            if (r[k] !== where[k]) return false;
          }
          return true;
        }).length;
      },
      updateMany: async ({ where = {}, data }) => {
        let count = 0;
        for (const r of rows) {
          let match = true;
          for (const k of Object.keys(where)) {
            if (r[k] !== where[k]) { match = false; break; }
          }
          if (match) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    user: {
      findUnique: async ({ where }) => users.find((u) => u.email === where.email) || null,
    },
    orgMembership: {
      findMany: async ({ where }) => {
        return (prisma._members || []).filter((m) => m.orgId === where.orgId);
      },
    },
    _members: [],
  };
  return prisma;
}

describe('user-notifications.createNotification', () => {
  test('creates row with sane defaults', async () => {
    const prisma = makePrisma();
    const row = await svc.createNotification(prisma, {
      userId: 'u1',
      type: 'test',
      title: 'Hi',
      message: 'Body',
    });
    assert.ok(row);
    assert.equal(row.userId, 'u1');
    assert.equal(row.severity, 'info');
    assert.equal(row.read, false);
  });

  test('returns null without userId', async () => {
    const prisma = makePrisma();
    const row = await svc.createNotification(prisma, { title: 'x' });
    assert.equal(row, null);
  });

  test('clamps invalid severity', async () => {
    const prisma = makePrisma();
    const row = await svc.createNotification(prisma, {
      userId: 'u1', severity: 'nuclear', title: 't', message: 'm',
    });
    assert.equal(row.severity, 'info');
  });
});

describe('user-notifications.handleTriggerEvent', () => {
  test('payment.failed → creates row for paying user', async () => {
    const prisma = makePrisma();
    const rows = await svc.handleTriggerEvent(prisma, 'payment.failed', {
      invoiceId: 'inv_1', amount: 12.5, currency: 'usd',
    }, 'u1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'u1');
    assert.equal(rows[0].type, 'payment_failed');
    assert.equal(rows[0].severity, 'warning');
  });

  test('payment.failed with skipInbox=true is a no-op', async () => {
    const prisma = makePrisma();
    const rows = await svc.handleTriggerEvent(prisma, 'payment.failed', {
      invoiceId: 'inv_1', skipInbox: true,
    }, 'u1');
    assert.equal(rows.length, 0);
    assert.equal(prisma._rows.length, 0);
  });

  test('org.invitation.created → notifies user when email is registered', async () => {
    const prisma = makePrisma([], [{ id: 'u2', email: 'invited@x.com' }]);
    const rows = await svc.handleTriggerEvent(prisma, 'org.invitation.created', {
      orgId: 'o1', invitationId: 'inv1', email: 'invited@x.com', role: 'MEMBER',
    }, 'u1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'u2');
    assert.equal(rows[0].type, 'org_invitation');
  });

  test('org.invitation.created → no-op when email not registered', async () => {
    const prisma = makePrisma([], []);
    const rows = await svc.handleTriggerEvent(prisma, 'org.invitation.created', {
      orgId: 'o1', invitationId: 'inv1', email: 'unknown@x.com', role: 'MEMBER',
    }, 'u1');
    assert.equal(rows.length, 0);
  });

  test('org.member.role_changed → notifies target user', async () => {
    const prisma = makePrisma();
    const rows = await svc.handleTriggerEvent(prisma, 'org.member.role_changed', {
      orgId: 'o1', targetUserId: 'u9', previousRole: 'MEMBER', newRole: 'ADMIN',
    }, 'u1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'u9');
    assert.equal(rows[0].type, 'role_changed');
  });

  test('org.announcement.created (critical) → notifies every member', async () => {
    const prisma = makePrisma();
    prisma._members = [
      { orgId: 'o1', userId: 'm1' },
      { orgId: 'o1', userId: 'm2' },
      { orgId: 'o1', userId: 'm3' },
    ];
    const rows = await svc.handleTriggerEvent(prisma, 'org.announcement.created', {
      orgId: 'o1', announcementId: 'a1', title: 'Outage', body: 'down 5m',
      severity: 'critical',
    }, 'admin');
    assert.equal(rows.length, 3);
    assert.equal(rows.every((r) => r.severity === 'critical'), true);
    assert.deepEqual(rows.map((r) => r.userId).sort(), ['m1', 'm2', 'm3']);
  });

  test('org.announcement.created (info) → no-op', async () => {
    const prisma = makePrisma();
    prisma._members = [{ orgId: 'o1', userId: 'm1' }];
    const rows = await svc.handleTriggerEvent(prisma, 'org.announcement.created', {
      orgId: 'o1', announcementId: 'a1', title: 'FYI', severity: 'info',
    }, 'admin');
    assert.equal(rows.length, 0);
  });

  test('unknown event → no-op', async () => {
    const prisma = makePrisma();
    const rows = await svc.handleTriggerEvent(prisma, 'something.else', {}, 'u1');
    assert.equal(rows.length, 0);
  });
});

describe('user-notifications.list/mark', () => {
  let prisma;
  beforeEach(async () => {
    prisma = makePrisma();
    // Seed 3 notifications for u1 (1 read, 2 unread) + 1 for u2.
    await prisma.notification.create({ data: { userId: 'u1', type: 't', title: 'a', message: '', severity: 'info' } });
    await prisma.notification.create({ data: { userId: 'u1', type: 't', title: 'b', message: '', severity: 'info', read: true } });
    await prisma.notification.create({ data: { userId: 'u1', type: 't', title: 'c', message: '', severity: 'info' } });
    await prisma.notification.create({ data: { userId: 'u2', type: 't', title: 'd', message: '', severity: 'info' } });
  });

  test('list returns own rows only with counts', async () => {
    const res = await svc.listNotifications(prisma, 'u1', { limit: 10 });
    assert.equal(res.items.length, 3);
    assert.equal(res.total, 3);
    assert.equal(res.unreadCount, 2);
  });

  test('unread filter excludes read rows', async () => {
    const res = await svc.listNotifications(prisma, 'u1', { filter: 'unread' });
    assert.equal(res.items.length, 2);
    assert.equal(res.items.every((r) => r.read === false), true);
  });

  test('read filter only includes read rows', async () => {
    const res = await svc.listNotifications(prisma, 'u1', { filter: 'read' });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].title, 'b');
  });

  test('pagination via cursor returns nextCursor', async () => {
    const page1 = await svc.listNotifications(prisma, 'u1', { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await svc.listNotifications(prisma, 'u1', { limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);
  });

  test('markRead marks one row + ignores other user', async () => {
    const targetId = prisma._rows.find((r) => r.userId === 'u1' && r.read === false).id;
    const ok = await svc.markRead(prisma, 'u1', targetId);
    assert.equal(ok, true);
    const row = prisma._rows.find((r) => r.id === targetId);
    assert.equal(row.read, true);
    assert.ok(row.readAt);
    // Other user cannot read it
    const otherId = prisma._rows.find((r) => r.userId === 'u2').id;
    const ok2 = await svc.markRead(prisma, 'u1', otherId);
    assert.equal(ok2, false);
  });

  test('markAllRead clears every unread row for the user', async () => {
    const updated = await svc.markAllRead(prisma, 'u1');
    assert.equal(updated, 2);
    const remaining = await svc.listNotifications(prisma, 'u1', { filter: 'unread' });
    assert.equal(remaining.items.length, 0);
    // u2 untouched
    const u2 = await svc.listNotifications(prisma, 'u2', { filter: 'unread' });
    assert.equal(u2.items.length, 1);
  });
});

describe('agent.task.* → inbox row (tarea de /agentes terminada)', () => {
  test('completed: fila info con actionUrl al chat y metadatos de la tarea', async () => {
    const prisma = makePrisma();
    const rows = await svc.handleTriggerEvent(prisma, 'agent.task.completed', {
      taskId: 't-1', chatId: 'chat-9', status: 'completed', goal: 'Genera el informe de ventas', model: 'deepseek-v4-flash', durationMs: 4200,
    }, 'u1');
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.userId, 'u1');
    assert.equal(row.type, 'agent_task_completed');
    assert.equal(row.title, 'Tarea terminada');
    assert.match(row.message, /Genera el informe de ventas/);
    assert.equal(row.severity, 'info');
    assert.equal(row.metadata.actionUrl, '/agentes/chat-9');
    assert.equal(row.metadata.taskId, 't-1');
    assert.equal(row.metadata.durationMs, 4200);
    assert.equal(row.metadata.model, 'deepseek-v4-flash');
  });

  test('failed: severidad warning; sin chatId el enlace cae a /agentes; sin goal usa texto genérico', async () => {
    const prisma = makePrisma();
    const rows = await svc.handleTriggerEvent(prisma, 'agent.task.failed', { taskId: 't-2', status: 'failed' }, 'u1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'agent_task_failed');
    assert.equal(rows[0].severity, 'warning');
    assert.equal(rows[0].metadata.actionUrl, '/agentes');
    assert.match(rows[0].message, /La tarea del agente se detuvo con un error/);
    assert.equal(rows[0].metadata.goal, null);
  });

  test('cancelled: fila info; sin userId no crea nada; chatId raro se codifica en la URL', async () => {
    const prisma = makePrisma();
    const none = await svc.handleTriggerEvent(prisma, 'agent.task.cancelled', { taskId: 't-3' }, '');
    assert.deepEqual(none, []);
    const rows = await svc.handleTriggerEvent(prisma, 'agent.task.cancelled', { taskId: 't-3', chatId: 'a b/c' }, 'u2');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'agent_task_cancelled');
    assert.equal(rows[0].title, 'Tarea cancelada');
    assert.equal(rows[0].metadata.actionUrl, '/agentes/a%20b%2Fc');
  });
});
