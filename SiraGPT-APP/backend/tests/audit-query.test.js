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

  test('run() returns {items,total,page,pages,limit} with pages computed', async () => {
    const prisma = {
      auditLog: {
        async findMany() { return [{ id: 'a1' }, { id: 'a2' }]; },
        async count() { return 47; },
      },
    };
    const r = await query(prisma).limit(10).page(2).run();
    assert.equal(r.total, 47);
    assert.equal(r.page, 2);
    assert.equal(r.limit, 10);
    assert.equal(r.pages, 5); // ceil(47/10)
  });

  test('run() returns pages=1 when prisma is missing', async () => {
    const r = await query(null).limit(20).page(3).run();
    assert.equal(r.pages, 1);
    assert.equal(r.page, 3);
    assert.equal(r.limit, 20);
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

// Ratchet 45 — byApiKey() composes the actorType='api_key' +
// resourceId=<keyId> convention that Cycle 66 introduced for API-key
// audit rows. Verify both fields land in the where clause, builder
// purity holds, and bad inputs are no-ops.
describe('AuditQuery — byApiKey() api-key activity filter', () => {
  test('byApiKey sets actorType and resourceId predicates', () => {
    const where = query(null).byApiKey('key_abc').toWhere();
    assert.equal(where.actorType, 'api_key');
    assert.equal(where.resourceId, 'key_abc');
  });

  test('byApiKey is a no-op for empty / non-string input', () => {
    assert.equal(query(null).byApiKey('').toWhere().actorType, undefined);
    assert.equal(query(null).byApiKey(null).toWhere().actorType, undefined);
    assert.equal(query(null).byApiKey(42).toWhere().actorType, undefined);
  });

  test('byApiKey composes with byUser/byAction', () => {
    const where = query(null)
      .byUser('u1')
      .byAction('api_key_used')
      .byApiKey('key_abc')
      .toWhere();
    assert.equal(where.actorId, 'u1');
    assert.equal(where.action, 'api_key_used');
    assert.equal(where.actorType, 'api_key');
    assert.equal(where.resourceId, 'key_abc');
  });

  test('byApiKey flows into prisma findMany where clause', async () => {
    const { prisma, capture } = makePrismaCapture([{ id: 'a1' }]);
    await query(prisma).byApiKey('key_xyz').run();
    assert.equal(capture.findMany.where.actorType, 'api_key');
    assert.equal(capture.findMany.where.resourceId, 'key_xyz');
  });

  test('builder purity holds for byApiKey', () => {
    const a = query(null);
    const b = a.byApiKey('key_abc');
    assert.notEqual(a, b);
    assert.equal(a.toJSON().actorType, null);
    assert.equal(a.toJSON().resourceId, null);
    assert.equal(b.toJSON().actorType, 'api_key');
    assert.equal(b.toJSON().resourceId, 'key_abc');
  });
});

// Ratchet 44 — byTags() emits a metadata.tags `array_contains` predicate
// (OR-joined when multiple tags are supplied) so operators can slice the
// audit feed by classification labels written into metadata.tags.
describe('AuditQuery — byTags() metadata.tags filter', () => {
  test('byTags with single tag emits flat metadata array_contains', () => {
    const where = query(null).byTags(['security']).toWhere();
    assert.deepEqual(where.metadata, {
      path: ['tags'],
      array_contains: ['security'],
    });
  });

  test('byTags with multiple tags emits OR of array_contains', () => {
    const where = query(null).byTags(['security', 'login']).toWhere();
    assert.ok(Array.isArray(where.AND));
    assert.equal(where.AND.length, 1);
    const or = where.AND[0].OR;
    assert.ok(Array.isArray(or));
    assert.equal(or.length, 2);
    assert.deepEqual(or[0], { metadata: { path: ['tags'], array_contains: ['security'] } });
    assert.deepEqual(or[1], { metadata: { path: ['tags'], array_contains: ['login'] } });
  });

  test('byTags trims, drops empties, dedupes, and rejects non-strings', () => {
    const where = query(null)
      .byTags(['  security  ', '', 'security', 42, null, 'login'])
      .toWhere();
    const or = where.AND[0].OR;
    assert.equal(or.length, 2);
    assert.deepEqual(or[0].metadata.array_contains, ['security']);
    assert.deepEqual(or[1].metadata.array_contains, ['login']);
  });

  test('byTags is a no-op for non-array / empty / all-invalid input', () => {
    assert.equal(query(null).byTags(null).toWhere().metadata, undefined);
    assert.equal(query(null).byTags('security').toWhere().metadata, undefined);
    assert.equal(query(null).byTags([]).toWhere().metadata, undefined);
    assert.equal(query(null).byTags(['', '  ', 42]).toWhere().metadata, undefined);
    assert.equal(query(null).byTags(['', '  ', 42]).toWhere().AND, undefined);
  });

  test('byTags composes with byOrg under AND', () => {
    const where = query(null).byOrg('org_42').byTags(['security', 'login']).toWhere();
    assert.ok(Array.isArray(where.AND));
    assert.equal(where.AND.length, 2);
    // orgId predicate first, then tags OR predicate.
    assert.deepEqual(where.AND[0], { metadata: { path: ['orgId'], equals: 'org_42' } });
    assert.ok(where.AND[1].OR);
    assert.equal(where.AND[1].OR.length, 2);
    // metadata should NOT be set at the top level in this combined case.
    assert.equal(where.metadata, undefined);
  });

  test('byTags composes with byOrg (single tag) under AND', () => {
    const where = query(null).byOrg('org_42').byTags(['security']).toWhere();
    assert.ok(Array.isArray(where.AND));
    assert.equal(where.AND.length, 2);
    assert.deepEqual(where.AND[0], { metadata: { path: ['orgId'], equals: 'org_42' } });
    assert.deepEqual(where.AND[1], {
      metadata: { path: ['tags'], array_contains: ['security'] },
    });
  });

  test('byTags flows into prisma findMany where clause', async () => {
    const { prisma, capture } = makePrismaCapture([{ id: 'a1' }]);
    await query(prisma).byTags(['security', 'login']).run();
    const w = capture.findMany.where;
    assert.ok(Array.isArray(w.AND));
    const or = w.AND[0].OR;
    assert.equal(or.length, 2);
    assert.deepEqual(or[0], { metadata: { path: ['tags'], array_contains: ['security'] } });
  });

  test('builder purity holds for byTags', () => {
    const a = query(null);
    const b = a.byTags(['security']);
    assert.notEqual(a, b);
    assert.equal(a.toJSON().tags, null);
    assert.deepEqual(b.toJSON().tags, ['security']);
  });
});
