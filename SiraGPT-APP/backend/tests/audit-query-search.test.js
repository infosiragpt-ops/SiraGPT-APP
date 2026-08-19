/**
 * audit-query.search — Ratchet 44 free-text search helper.
 *
 * Covers parameter clamping, ILIKE-metachar escaping, SQL parameter
 * passthrough, total/pages math, and graceful degradation when prisma
 * is missing or `$queryRawUnsafe` throws.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  search,
  escapeLikePattern,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} = require('../src/services/audit-query');

function makePrisma({ items = [], total = null, throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    prisma: {
      async $queryRawUnsafe(sql, ...params) {
        calls.push({ sql, params });
        if (throwOn && throwOn(sql)) throw new Error('boom');
        if (/COUNT\(\*\)/i.test(sql)) {
          return [{ count: total === null ? items.length : total }];
        }
        return items;
      },
    },
  };
}

describe('audit-query.search — input handling', () => {
  test('returns empty result when prisma is null', async () => {
    const r = await search(null, 'hello');
    assert.deepEqual(r.items, []);
    assert.equal(r.total, 0);
    assert.equal(r.limit, SEARCH_LIMIT_DEFAULT);
  });

  test('returns empty result when q is empty/whitespace', async () => {
    const { prisma, calls } = makePrisma();
    const r1 = await search(prisma, '');
    const r2 = await search(prisma, '   ');
    assert.deepEqual(r1.items, []);
    assert.deepEqual(r2.items, []);
    assert.equal(calls.length, 0, 'should not hit the DB on empty q');
  });

  test('returns empty result when $queryRawUnsafe is unavailable', async () => {
    const r = await search({}, 'foo');
    assert.deepEqual(r.items, []);
  });
});

describe('audit-query.search — limit + page clamping', () => {
  test('default limit is 50, max is 200', () => {
    assert.equal(SEARCH_LIMIT_DEFAULT, 50);
    assert.equal(SEARCH_LIMIT_MAX, 200);
  });

  test('limit clamps to MAX when over', async () => {
    const { prisma, calls } = makePrisma({ items: [] });
    const r = await search(prisma, 'x', { limit: 9999 });
    assert.equal(r.limit, 200);
    // Second positional param to itemsSql is the limit.
    const itemsCall = calls.find((c) => /LIMIT \$2/.test(c.sql));
    assert.equal(itemsCall.params[1], 200);
  });

  test('limit falls back to default on garbage input', async () => {
    const { prisma } = makePrisma();
    const r = await search(prisma, 'x', { limit: 'abc' });
    assert.equal(r.limit, 50);
  });

  test('limit honoured when valid', async () => {
    const { prisma } = makePrisma();
    const r = await search(prisma, 'x', { limit: 75 });
    assert.equal(r.limit, 75);
  });

  test('page floors to 1 on bad input', async () => {
    const { prisma, calls } = makePrisma();
    const r = await search(prisma, 'x', { page: 0 });
    assert.equal(r.page, 1);
    const itemsCall = calls.find((c) => /OFFSET \$3/.test(c.sql));
    assert.equal(itemsCall.params[2], 0);
  });

  test('page > 1 produces correct OFFSET', async () => {
    const { prisma, calls } = makePrisma();
    await search(prisma, 'x', { limit: 25, page: 3 });
    const itemsCall = calls.find((c) => /OFFSET \$3/.test(c.sql));
    assert.equal(itemsCall.params[2], 50); // (3-1)*25
  });
});

describe('audit-query.search — ILIKE escaping', () => {
  test('escapes %, _, and backslash', () => {
    assert.equal(escapeLikePattern('a%b'), 'a\\%b');
    assert.equal(escapeLikePattern('a_b'), 'a\\_b');
    assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
  });

  test('passes literal text through unchanged', () => {
    assert.equal(escapeLikePattern('hello world'), 'hello world');
    assert.equal(escapeLikePattern('user@example.com'), 'user@example.com');
  });

  test('search wraps pattern with %…% and uses ILIKE on action + metadata::text', async () => {
    const { prisma, calls } = makePrisma();
    await search(prisma, 'alice');
    const itemsCall = calls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    assert.ok(itemsCall, 'items query was executed');
    assert.match(itemsCall.sql, /"action" ILIKE \$1/);
    assert.match(itemsCall.sql, /\("metadata"\)::text ILIKE \$1/);
    assert.equal(itemsCall.params[0], '%alice%');
  });

  test('user-supplied % is escaped so it cannot widen the match', async () => {
    const { prisma, calls } = makePrisma();
    await search(prisma, '50%');
    const itemsCall = calls.find((c) => /SELECT \* FROM "AuditLog"/.test(c.sql));
    assert.equal(itemsCall.params[0], '%50\\%%');
  });
});

describe('audit-query.search — result shape', () => {
  test('returns items + total + pages from count query', async () => {
    const rows = [
      { id: '1', action: 'login', metadata: { email: 'a@x' } },
      { id: '2', action: 'logout', metadata: { email: 'a@x' } },
    ];
    const { prisma } = makePrisma({ items: rows, total: 137 });
    const r = await search(prisma, 'a@x', { limit: 50 });
    assert.equal(r.items.length, 2);
    assert.equal(r.total, 137);
    assert.equal(r.pages, Math.ceil(137 / 50));
    assert.equal(r.limit, 50);
    assert.equal(r.page, 1);
  });

  test('falls back to items.length when count row is malformed', async () => {
    const rows = [{ id: '1' }];
    const prisma = {
      async $queryRawUnsafe(sql) {
        if (/COUNT/i.test(sql)) return [{}]; // missing `count`
        return rows;
      },
    };
    const r = await search(prisma, 'x');
    assert.equal(r.total, 1);
  });

  test('degrades to empty result on query failure', async () => {
    const { prisma } = makePrisma({ throwOn: () => true });
    const r = await search(prisma, 'x');
    assert.deepEqual(r.items, []);
    assert.equal(r.total, 0);
    assert.equal(r.error, 'search_failed');
  });
});
