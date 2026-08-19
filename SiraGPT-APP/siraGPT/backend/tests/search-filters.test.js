// GET /api/search filter contract — cycle 23 extension.
//
// The route uses $queryRawUnsafe for the FTS path so we can't lean on
// Prisma's typed query builder for assertions. Instead we stub
// $queryRawUnsafe directly and inspect the (sql, ...params) tuple to
// prove the optional chatId / from / to / model filters actually
// translate into bound predicates with the right param indices.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('GET /api/search · optional filters', () => {
  let auth;
  let originalQueryRaw;
  let originalFindMany;

  beforeEach(() => {
    auth = installAuthSessionMock();
    originalQueryRaw = prisma.$queryRawUnsafe;
    originalFindMany = prisma.message.findMany;
    delete require.cache[require.resolve('../src/routes/search')];
  });

  afterEach(() => {
    auth.restore();
    prisma.$queryRawUnsafe = originalQueryRaw;
    prisma.message.findMany = originalFindMany;
    delete require.cache[require.resolve('../src/routes/search')];
  });

  function buildApp() {
    return buildRouteTestApp('/api/search', reloadModule('../src/routes/search'));
  }

  test('no filters → SQL has only the base predicates', async () => {
    let captured;
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      captured = { sql, params };
      return [];
    };

    const res = await request(buildApp())
      .get('/api/search?q=hello')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.ok(!/m\."chatId" = /.test(captured.sql), 'no chatId predicate expected');
    assert.ok(!/m\."timestamp" >= /.test(captured.sql), 'no from predicate expected');
    assert.ok(!/m\."timestamp" <= /.test(captured.sql), 'no to predicate expected');
    assert.ok(!/metadata.*model/.test(captured.sql), 'no model predicate expected');
    // 4 fixed params: lang, q, userId, limit
    assert.equal(captured.params.length, 4);
  });

  test('chatId filter binds a parameter and adds predicate', async () => {
    let captured;
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      captured = { sql, params };
      return [];
    };

    const res = await request(buildApp())
      .get('/api/search?q=hello&chatId=chat-7')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.match(captured.sql, /m\."chatId" = \$4/);
    assert.equal(captured.params[3], 'chat-7');
  });

  test('from + to filters bind Date params at correct indices', async () => {
    let captured;
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      captured = { sql, params };
      return [];
    };

    const res = await request(buildApp())
      .get('/api/search?q=hello&from=2026-01-01&to=2026-02-01')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.match(captured.sql, /m\."timestamp" >= \$4/);
    assert.match(captured.sql, /m\."timestamp" <= \$5/);
    assert.ok(captured.params[3] instanceof Date);
    assert.ok(captured.params[4] instanceof Date);
    assert.equal(captured.params[3].toISOString().slice(0, 10), '2026-01-01');
    assert.equal(captured.params[4].toISOString().slice(0, 10), '2026-02-01');
  });

  test('invalid date returns 400 without hitting the DB', async () => {
    let hit = false;
    prisma.$queryRawUnsafe = async () => { hit = true; return []; };

    const res = await request(buildApp())
      .get('/api/search?q=hello&from=not-a-date')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid from date/);
    assert.equal(hit, false);
  });

  test('model filter binds parameter and uses jsonb extraction', async () => {
    let captured;
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      captured = { sql, params };
      return [];
    };

    const res = await request(buildApp())
      .get('/api/search?q=hello&model=gpt-4o-mini')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.match(captured.sql, /\(m\."metadata"::jsonb\)->>'model' = \$4/);
    assert.equal(captured.params[3], 'gpt-4o-mini');
  });

  test('all filters combined are bound in stable order', async () => {
    let captured;
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      captured = { sql, params };
      return [];
    };

    const res = await request(buildApp())
      .get('/api/search?q=hi&chatId=chat-1&from=2026-01-01&to=2026-02-01&model=claude-3-7&limit=5')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    // lang, q, userId, chatId, from, to, model, limit  →  8 params
    assert.equal(captured.params.length, 8);
    assert.equal(captured.params[3], 'chat-1');
    assert.ok(captured.params[4] instanceof Date);
    assert.ok(captured.params[5] instanceof Date);
    assert.equal(captured.params[6], 'claude-3-7');
    assert.equal(captured.params[7], 5);
    // LIMIT must be the last bound param.
    assert.match(captured.sql, /LIMIT \$8/);
  });

  test('LIKE fallback honours filters when FTS path throws', async () => {
    prisma.$queryRawUnsafe = async () => { throw new Error('tsvector missing'); };
    let observed;
    prisma.message.findMany = async (args) => {
      observed = args;
      return [];
    };

    const res = await request(buildApp())
      .get('/api/search?q=hi&chatId=chat-1&from=2026-01-01&model=gpt-4o')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.fallback, 'like');
    assert.equal(observed.where.chatId, 'chat-1');
    assert.ok(observed.where.timestamp.gte instanceof Date);
    assert.deepEqual(observed.where.metadata, { path: ['model'], equals: 'gpt-4o' });
  });
});
