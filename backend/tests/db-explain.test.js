'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  explain,
  isReadOnlyQuery,
  stripLeadingComments,
  ExplainNotAllowedError,
  ExplainInvalidQueryError,
} = require('../src/db/explain');

function makePrismaStub({ rows, onCall }) {
  return {
    async $queryRawUnsafe(sql, ...params) {
      if (onCall) onCall(sql, params);
      return rows;
    },
  };
}

test('isReadOnlyQuery accepts SELECT/WITH/VALUES, rejects writes', () => {
  assert.equal(isReadOnlyQuery('select 1'), true);
  assert.equal(isReadOnlyQuery('  SELECT id FROM "User"'), true);
  assert.equal(isReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x'), true);
  assert.equal(isReadOnlyQuery('VALUES (1),(2)'), true);
  assert.equal(isReadOnlyQuery('UPDATE "User" SET name=$1'), false);
  assert.equal(isReadOnlyQuery('DELETE FROM "User"'), false);
  assert.equal(isReadOnlyQuery('INSERT INTO x VALUES (1)'), false);
  assert.equal(isReadOnlyQuery('DROP TABLE x'), false);
});

test('stripLeadingComments unwraps -- and /* */ comments', () => {
  assert.equal(stripLeadingComments('-- hello\nselect 1'), 'select 1');
  assert.equal(stripLeadingComments('/* a */ /* b */ SELECT 1'), 'SELECT 1');
  assert.equal(stripLeadingComments('   \n  -- c\n SELECT 2 '), 'SELECT 2');
});

test('explain refuses non-read-only SQL', async () => {
  const prisma = makePrismaStub({ rows: [] });
  await assert.rejects(
    () => explain(prisma, 'UPDATE "User" SET name=$1', ['x']),
    (err) => err instanceof ExplainInvalidQueryError && err.code === 'EXPLAIN_INVALID_QUERY',
  );
});

test('explain refuses empty SQL', async () => {
  const prisma = makePrismaStub({ rows: [] });
  await assert.rejects(
    () => explain(prisma, '   '),
    (err) => err instanceof ExplainInvalidQueryError,
  );
});

test('explain refuses without prisma client', async () => {
  await assert.rejects(
    () => explain(null, 'SELECT 1'),
    (err) => err instanceof ExplainInvalidQueryError,
  );
});

test('explain blocked in production unless EXPLAIN_ALLOW_PROD=1', async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevFlag = process.env.EXPLAIN_ALLOW_PROD;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.EXPLAIN_ALLOW_PROD;
    const prisma = makePrismaStub({ rows: [] });
    await assert.rejects(
      () => explain(prisma, 'SELECT 1'),
      (err) => err instanceof ExplainNotAllowedError && err.code === 'EXPLAIN_NOT_ALLOWED',
    );

    process.env.EXPLAIN_ALLOW_PROD = '1';
    let captured = null;
    const ok = makePrismaStub({
      rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result' } }] }],
      onCall: (sql) => { captured = sql; },
    });
    const result = await explain(ok, 'SELECT 1');
    assert.ok(result.plan);
    assert.match(captured, /^EXPLAIN \(/);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevFlag === undefined) delete process.env.EXPLAIN_ALLOW_PROD; else process.env.EXPLAIN_ALLOW_PROD = prevFlag;
  }
});

test('explain wraps query in EXPLAIN ANALYZE FORMAT JSON and forwards params', async () => {
  let capturedSql = null;
  let capturedParams = null;
  const prisma = makePrismaStub({
    rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan', 'Actual Total Time': 0.42 } }] }],
    onCall: (sql, params) => { capturedSql = sql; capturedParams = params; },
  });
  const result = await explain(prisma, 'SELECT id FROM "User" WHERE id = $1', [123]);
  assert.match(capturedSql, /^EXPLAIN \(ANALYZE TRUE, FORMAT JSON\) SELECT id FROM "User" WHERE id = \$1$/);
  assert.deepEqual(capturedParams, [123]);
  assert.deepEqual(result.plan, [{ Plan: { 'Node Type': 'Index Scan', 'Actual Total Time': 0.42 } }]);
});

test('explain honors analyze:false / buffers / verbose flags', async () => {
  let capturedSql = null;
  const prisma = makePrismaStub({
    rows: [{ 'QUERY PLAN': [] }],
    onCall: (sql) => { capturedSql = sql; },
  });
  await explain(prisma, 'SELECT 1', [], { analyze: false, buffers: true, verbose: true });
  assert.match(capturedSql, /ANALYZE FALSE/);
  assert.match(capturedSql, /BUFFERS TRUE/);
  assert.match(capturedSql, /VERBOSE TRUE/);
  assert.match(capturedSql, /FORMAT JSON/);
});

test('explain falls back to first column when QUERY PLAN key absent', async () => {
  const prisma = makePrismaStub({ rows: [{ plan: [{ Plan: { 'Node Type': 'Seq Scan' } }] }] });
  const result = await explain(prisma, 'SELECT 1');
  assert.deepEqual(result.plan, [{ Plan: { 'Node Type': 'Seq Scan' } }]);
});
