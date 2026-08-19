'use strict';

/**
 * Ratchet 44 — org-scoped notifications inbox tests.
 *
 * Covers:
 *  - broadcastOrgNotification fans out one row per member (no filter).
 *  - roleFilter restricts the fan-out to members of that role.
 *  - Missing title/message returns counters with `created:0`.
 *  - Invalid role filter returns an `error` marker.
 *  - createNotification accepts an optional `orgId` and persists it.
 *  - BROADCAST_FAN_OUT_LIMIT caps large orgs and surfaces the skip count.
 *  - POST /api/orgs/:id/notifications integration: ADMIN+ gate, 400 on
 *    bad payloads, 201 with fan-out counters on success, audit row.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const svc = require('../src/services/user-notifications');

// ── prisma double for service-level unit tests ─────────────────────
function makePrisma({ members = [], notifFails = false } = {}) {
  const rows = [];
  let seq = 0;
  return {
    _rows: rows,
    notification: {
      create: async ({ data }) => {
        if (notifFails) throw new Error('boom');
        seq += 1;
        const row = {
          id: `n${seq}`,
          read: false,
          readAt: null,
          createdAt: new Date(Date.now() + seq),
          orgId: null,
          ...data,
        };
        rows.push(row);
        return row;
      },
    },
    orgMembership: {
      findMany: async ({ where = {}, select } = {}) => {
        void select;
        return members.filter((m) => {
          if (where.orgId && m.orgId !== where.orgId) return false;
          if (where.role && m.role !== where.role) return false;
          return true;
        });
      },
    },
  };
}

describe('user-notifications.broadcastOrgNotification', () => {
  test('fans out one row per matching member (no roleFilter)', async () => {
    const prisma = makePrisma({
      members: [
        { orgId: 'org-1', userId: 'u1', role: 'ADMIN' },
        { orgId: 'org-1', userId: 'u2', role: 'MEMBER' },
        { orgId: 'org-1', userId: 'u3', role: 'VIEWER' },
        { orgId: 'org-2', userId: 'x1', role: 'ADMIN' }, // other org
      ],
    });
    const result = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1',
      title: 'Maintenance Tonight',
      message: 'Expect 5min of downtime at 22:00 UTC.',
      severity: 'warning',
      createdById: 'admin-x',
    });
    assert.equal(result.orgId, 'org-1');
    assert.equal(result.total, 3);
    assert.equal(result.recipients, 3);
    assert.equal(result.created, 3);
    assert.equal(result.skipped, 0);
    assert.equal(result.notifications.length, 3);
    for (const row of result.notifications) {
      assert.equal(row.orgId, 'org-1');
      assert.equal(row.severity, 'warning');
      assert.equal(row.type, 'org_broadcast');
      assert.equal(row.metadata.broadcast, true);
      assert.equal(row.metadata.orgId, 'org-1');
      assert.equal(row.metadata.createdById, 'admin-x');
    }
  });

  test('roleFilter restricts to matching role', async () => {
    const prisma = makePrisma({
      members: [
        { orgId: 'org-1', userId: 'u1', role: 'ADMIN' },
        { orgId: 'org-1', userId: 'u2', role: 'MEMBER' },
        { orgId: 'org-1', userId: 'u3', role: 'MEMBER' },
        { orgId: 'org-1', userId: 'u4', role: 'VIEWER' },
      ],
    });
    const result = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1',
      title: 'Members-only',
      message: 'For MEMBER role.',
      roleFilter: 'MEMBER',
    });
    assert.equal(result.total, 2);
    assert.equal(result.created, 2);
    for (const row of result.notifications) {
      assert.equal(row.metadata.roleFilter, 'MEMBER');
      assert.equal(row.metadata.recipientRole, 'MEMBER');
    }
  });

  test('missing title or message yields zero-created result', async () => {
    const prisma = makePrisma({ members: [{ orgId: 'org-1', userId: 'u1', role: 'ADMIN' }] });
    const noTitle = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1', title: '   ', message: 'hi',
    });
    assert.equal(noTitle.created, 0);
    const noMsg = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1', title: 'hi', message: '',
    });
    assert.equal(noMsg.created, 0);
  });

  test('invalid roleFilter is rejected with marker', async () => {
    const prisma = makePrisma({ members: [{ orgId: 'org-1', userId: 'u1', role: 'ADMIN' }] });
    const result = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1', title: 't', message: 'm', roleFilter: 'WIZARD',
    });
    assert.equal(result.created, 0);
    assert.equal(result.error, 'invalid_role_filter');
  });

  test('createNotification stamps orgId when provided', async () => {
    const prisma = makePrisma({});
    const row = await svc.createNotification(prisma, {
      userId: 'u1', orgId: 'org-7', title: 't', message: 'm', severity: 'info',
    });
    assert.equal(row.orgId, 'org-7');
  });

  test('fan-out is capped at BROADCAST_FAN_OUT_LIMIT', async () => {
    const cap = svc.BROADCAST_FAN_OUT_LIMIT;
    const total = cap + 5;
    const members = [];
    for (let i = 0; i < total; i += 1) {
      members.push({ orgId: 'org-1', userId: `u${i}`, role: 'MEMBER' });
    }
    const prisma = makePrisma({ members });
    const result = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1', title: 'mass', message: 'mass',
    });
    assert.equal(result.total, total);
    assert.equal(result.recipients, cap);
    assert.equal(result.created, cap);
    assert.equal(result.skipped, 5);
  });

  test('per-row create failure does not abort the rest', async () => {
    const prisma = makePrisma({
      members: [
        { orgId: 'org-1', userId: 'u1', role: 'ADMIN' },
        { orgId: 'org-1', userId: 'u2', role: 'MEMBER' },
      ],
    });
    let calls = 0;
    const origCreate = prisma.notification.create;
    prisma.notification.create = async (args) => {
      calls += 1;
      if (calls === 1) {
        // swallowed inside createNotification
        throw new Error('first row blew up');
      }
      return origCreate(args);
    };
    const result = await svc.broadcastOrgNotification(prisma, {
      orgId: 'org-1', title: 't', message: 'm',
    });
    assert.equal(result.recipients, 2);
    assert.equal(result.created, 1);
  });
});

// ── route-level integration tests via module-cache substitution ────
describe('POST /api/orgs/:id/notifications', () => {
  const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
  const dbPath = path.resolve(__dirname, '../src/config/database.js');
  const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
  const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
  const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

  const authMock = {
    _user: { id: 'u-admin', email: 'admin@example.com' },
    authenticateToken: (req, _res, next) => { req.user = authMock._user; next(); },
  };

  let prismaState;
  let prismaMock;
  let auditCalls;
  let app;

  beforeEach(() => {
    prismaState = {
      membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
      members: [
        { orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
        { orgId: 'org-1', userId: 'u2', role: 'MEMBER' },
        { orgId: 'org-1', userId: 'u3', role: 'MEMBER' },
        { orgId: 'org-1', userId: 'u4', role: 'VIEWER' },
      ],
      notifications: [],
    };
    auditCalls = [];

    prismaMock = {
      orgMembership: {
        findUnique: async ({ where }) => {
          const { orgId, userId } = where.orgId_userId;
          if (orgId !== prismaState.membership.orgId) return null;
          if (userId !== prismaState.membership.userId) return null;
          return { ...prismaState.membership, organization: { id: orgId } };
        },
        findMany: async ({ where = {} } = {}) => prismaState.members.filter((m) => {
          if (where.orgId && m.orgId !== where.orgId) return false;
          if (where.role && m.role !== where.role) return false;
          return true;
        }),
      },
      notification: {
        create: async ({ data }) => {
          const row = {
            id: `n${prismaState.notifications.length + 1}`,
            read: false,
            readAt: null,
            createdAt: new Date(),
            orgId: null,
            ...data,
          };
          prismaState.notifications.push(row);
          return row;
        },
      },
    };

    // clear & inject mocks into the require cache
    for (const p of [authPath, dbPath, auditPath, triggersPath, orgsRoutePath]) {
      delete require.cache[p];
    }
    require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
    require.cache[auditPath] = {
      id: auditPath, filename: auditPath, loaded: true,
      exports: {
        writeAuditLog: (_p, args) => { auditCalls.push(args); return Promise.resolve(); },
      },
    };
    require.cache[triggersPath] = {
      id: triggersPath, filename: triggersPath, loaded: true,
      exports: { publish: async () => {} },
    };

    const orgsRouter = require(orgsRoutePath);
    app = express();
    app.use(express.json());
    app.use('/api/orgs', orgsRouter);
  });

  function postJson(server, body) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request({
        method: 'POST',
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/orgs/org-1/notifications',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      }, (resp) => {
        let buf = '';
        resp.on('data', (c) => { buf += c; });
        resp.on('end', () => resolve({ status: resp.statusCode, body: buf ? JSON.parse(buf) : null }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  test('ADMIN can broadcast to all members and gets fan-out counters', async () => {
    const server = app.listen(0);
    try {
      const res = await postJson(server, {
        title: 'Heads up',
        message: 'New SSO config is live.',
        severity: 'info',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.orgId, 'org-1');
      assert.equal(res.body.recipients, 4);
      assert.equal(res.body.created, 4);
      assert.equal(prismaState.notifications.length, 4);
      // every row got the orgId stamp + broadcast metadata
      for (const row of prismaState.notifications) {
        assert.equal(row.orgId, 'org-1');
        assert.equal(row.metadata.broadcast, true);
      }
      // audit row written
      assert.equal(auditCalls.length, 1);
      assert.equal(auditCalls[0].action, 'org_notification_broadcast');
    } finally {
      server.close();
    }
  });

  test('roleFilter restricts fan-out to that role', async () => {
    const server = app.listen(0);
    try {
      const res = await postJson(server, {
        title: 'Members only',
        message: 'Read-only viewers excluded.',
        severity: 'warning',
        role: 'MEMBER',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.created, 2);
      assert.equal(res.body.recipients, 2);
      assert.equal(res.body.roleFilter, 'MEMBER');
      assert.equal(prismaState.notifications.length, 2);
    } finally {
      server.close();
    }
  });

  test('rejects empty title with 400', async () => {
    const server = app.listen(0);
    try {
      const res = await postJson(server, { title: '', message: 'x', severity: 'info' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid title');
    } finally {
      server.close();
    }
  });

  test('rejects unknown severity with 400', async () => {
    const server = app.listen(0);
    try {
      const res = await postJson(server, { title: 't', message: 'm', severity: 'fatal' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid severity');
    } finally {
      server.close();
    }
  });

  test('rejects invalid role with 400', async () => {
    const server = app.listen(0);
    try {
      const res = await postJson(server, {
        title: 't', message: 'm', severity: 'info', role: 'WIZARD',
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid role');
    } finally {
      server.close();
    }
  });

  test('non-ADMIN gets 403', async () => {
    prismaState.membership.role = 'MEMBER';
    const server = app.listen(0);
    try {
      const res = await postJson(server, { title: 't', message: 'm', severity: 'info' });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });
});
