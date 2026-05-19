/**
 * audit-query — composable read-side DSL over AuditLog (cycle 45).
 * Verifies builder purity, where-clause construction, fallback when
 * prisma is unavailable, and graceful failure on findMany errors.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { query, AuditQuery } = require('../src/services/audit-query');

function makePrismaCapture(rows = []) {
  const capture = {};
  return {
    capture,
    prisma: {
      auditLog: {
        async findMany(arg) {
          capture.findMany = arg;
          return rows;
        },
        async count(arg) {
          capture.count = arg;
          return rows.length;
        },
      },
    },
  };
}

describe('AuditQuery — builder purity', () => {
  test('chain methods do not mutate the source query', () => {
    const a = query(null);
    const b = a.byUser('u1');
    const c = b.byAction('login');
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.equal(a.toJSON().userId, null);
    assert.equal(b.toJSON().userId, 'u1');
    assert.equal(b.toJSON().action, null);
    assert.equal(c.toJSON().action, 'login');
  });

  test('rejects bogus inputs as no-ops', () => {
    const q = query(null).byUser('').byAction(null).byResource(123).byDate(null, null);
    const s = q.toJSON();
    assert.equal(s.userId, null);
    assert.equal(s.action, null);
    assert.equal(s.resourceType, null);
    assert.equal(s.from, null);
    assert.equal(s.to, null);
  });

  test('limit() clamps to MAX and falls back on bad input', () => {
    assert.equal(query(null).limit(9999).toJSON().limit, 500);
    assert.equal(query(null).limit('abc').toJSON().limit, 100);
    assert.equal(query(null).limit(-5).toJSON().limit, 100);
    assert.equal(query(null).limit(50).toJSON().limit, 50);
  });

  test('page() floors to 1', () => {
    assert.equal(query(null).page(0).toJSON().page, 1);
    assert.equal(query(null).page(3).toJSON().page, 3);
  });
});

describe('AuditQuery — toWhere() mapping', () => {
  test('builds where from each chain segment', () => {
    const where = query(null)
      .byUser('u1')
      .byAction('grant_credits')
      .byResource('user', 'u1')
      .byDate('2026-01-01', '2026-12-31')
      .toWhere();
    assert.equal(where.actorId, 'u1');
    assert.equal(where.action, 'grant_credits');
    assert.equal(where.resourceType, 'user');
    assert.equal(where.resourceId, 'u1');
    assert.ok(where.createdAt.gte instanceof Date);
    assert.ok(where.createdAt.lte instanceof Date);
  });

  test('omits createdAt when no dates supplied', () => {
    const where = query(null).byUser('u1').toWhere();
    assert.equal(where.createdAt, undefined);
  });

  test('ignores invalid dates silently', () => {
    const where = query(null).byDate('not-a-date', 'nope').toWhere();
    assert.equal(where.createdAt, undefined);
  });
});

describe('AuditQuery — run()', () => {
  test('returns empty result when prisma is null/missing', async () => {
    const r1 = await query(null).run();
    assert.deepEqual(r1.items, []);
    assert.equal(r1.total, 0);

    const r2 = await query({}).run();
    assert.deepEqual(r2.items, []);
  });

  test('passes built where + paging to prisma', async () => {
    const { prisma, capture } = makePrismaCapture([{ id: 'a1' }, { id: 'a2' }]);
    const r = await query(prisma).byUser('u1').limit(10).page(2).run();
    assert.equal(capture.findMany.where.actorId, 'u1');
    assert.equal(capture.findMany.take, 10);
    assert.equal(capture.findMany.skip, 10);
    assert.equal(r.items.length, 2);
    assert.equal(r.total, 2);
  });

  test('swallows findMany errors and returns empty + error tag', async () => {
    const prisma = {
      auditLog: {
        async findMany() { throw new Error('db down'); },
        async count() { return 0; },
      },
    };
    const r = await query(prisma).byUser('u1').run();
    assert.deepEqual(r.items, []);
    assert.equal(r.error, 'query_failed');
  });

  test('AuditQuery class is exported', () => {
    assert.equal(typeof AuditQuery, 'function');
    assert.ok(new AuditQuery(null) instanceof AuditQuery);
  });
});

describe('AuditQuery — byOrg() org scoping', () => {
  test('byOrg sets metadata JSON path filter', () => {
    const where = query(null).byOrg('org_42').toWhere();
    assert.deepEqual(where.metadata, { path: ['orgId'], equals: 'org_42' });
  });

  test('byOrg is a no-op for empty / non-string input', () => {
    assert.equal(query(null).byOrg('').toWhere().metadata, undefined);
    assert.equal(query(null).byOrg(null).toWhere().metadata, undefined);
    assert.equal(query(null).byOrg(123).toWhere().metadata, undefined);
  });

  test('byOrg composes with other filters', () => {
    const where = query(null)
      .byUser('u1')
      .byAction('grant_credits')
      .byOrg('org_42')
      .toWhere();
    assert.equal(where.actorId, 'u1');
    assert.equal(where.action, 'grant_credits');
    assert.deepEqual(where.metadata, { path: ['orgId'], equals: 'org_42' });
  });

  test('byOrg flows into prisma findMany where clause', async () => {
    const { prisma, capture } = makePrismaCapture([{ id: 'a1' }]);
    await query(prisma).byOrg('org_42').run();
    assert.deepEqual(capture.findMany.where.metadata, {
      path: ['orgId'],
      equals: 'org_42',
    });
  });

  test('builder purity holds for byOrg', () => {
    const a = query(null);
    const b = a.byOrg('org_42');
    assert.notEqual(a, b);
    assert.equal(a.toJSON().orgId, null);
    assert.equal(b.toJSON().orgId, 'org_42');
  });
});
