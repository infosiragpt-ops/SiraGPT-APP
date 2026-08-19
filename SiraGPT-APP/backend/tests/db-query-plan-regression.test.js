'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizePlan,
  fingerprint,
  detectRegressions,
  assertPlanMatches,
  collectNodeTypes,
  collectIndexes,
  collectRelations,
  collectScansOnRelation,
  unwrapPlan,
  PlanRegressionError,
} = require('../src/db/query-plan-regression');

const {
  CRITICAL_QUERIES,
  listCriticalQueries,
  findCriticalQuery,
  runCriticalQueryRegression,
} = require('../src/db/critical-queries');

// ──────────────────────────────────────────────────────────────
// Synthetic plans shaped like Postgres `EXPLAIN (FORMAT JSON)`.
// ──────────────────────────────────────────────────────────────

function indexScanPlan() {
  return [
    {
      Plan: {
        'Node Type': 'Index Scan',
        'Relation Name': 'User',
        'Index Name': 'User_email_key',
        'Scan Direction': 'Forward',
        'Total Cost': 8.45,
        'Actual Rows': 1,
        'Actual Total Time': 0.041,
      },
      'Planning Time': 0.12,
      'Execution Time': 0.08,
    },
  ];
}

function seqScanPlan() {
  return [
    {
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'User',
        'Total Cost': 1452.0,
        'Actual Rows': 50000,
      },
    },
  ];
}

function nestedJoinPlan() {
  return [
    {
      Plan: {
        'Node Type': 'Nested Loop',
        'Join Type': 'Inner',
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'Task',
            'Index Name': 'Task_userId_createdAt_idx',
          },
          {
            'Node Type': 'Index Only Scan',
            'Relation Name': 'User',
            'Index Name': 'User_pkey',
          },
        ],
      },
    },
  ];
}

function bitmapPlan() {
  return [
    {
      Plan: {
        'Node Type': 'Bitmap Heap Scan',
        'Relation Name': 'Task',
        Plans: [
          {
            'Node Type': 'Bitmap Index Scan',
            'Index Name': 'Task_userId_idx',
          },
        ],
      },
    },
  ];
}

// ──────────────────────────────────────────────────────────────
// summarizePlan / unwrapPlan
// ──────────────────────────────────────────────────────────────

test('unwrapPlan handles array, wrapped object, and inner plan', () => {
  const wrapped = indexScanPlan();
  const inner = wrapped[0].Plan;
  assert.equal(unwrapPlan(wrapped)['Node Type'], 'Index Scan');
  assert.equal(unwrapPlan(wrapped[0])['Node Type'], 'Index Scan');
  assert.equal(unwrapPlan(inner)['Node Type'], 'Index Scan');
  assert.equal(unwrapPlan(null), null);
  assert.equal(unwrapPlan([]), null);
  assert.equal(unwrapPlan('not a plan'), null);
});

test('summarizePlan strips costs/timing and keeps structural shape', () => {
  const summary = summarizePlan(indexScanPlan());
  assert.deepEqual(summary, {
    nodeType: 'Index Scan',
    relation: 'User',
    index: 'User_email_key',
    scanDirection: 'Forward',
  });
  // No timing, cost, or actual-rows leak into the summary.
  assert.equal('Total Cost' in summary, false);
  assert.equal('Actual Rows' in summary, false);
});

test('summarizePlan recurses into Plans children', () => {
  const summary = summarizePlan(nestedJoinPlan());
  assert.equal(summary.nodeType, 'Nested Loop');
  assert.equal(summary.joinType, 'Inner');
  assert.equal(summary.children.length, 2);
  assert.equal(summary.children[0].nodeType, 'Index Scan');
  assert.equal(summary.children[0].index, 'Task_userId_createdAt_idx');
  assert.equal(summary.children[1].index, 'User_pkey');
});

test('summarizePlan returns null for empty / malformed plans', () => {
  assert.equal(summarizePlan(null), null);
  assert.equal(summarizePlan([]), null);
  assert.equal(summarizePlan({}).nodeType, 'Unknown');
});

// ──────────────────────────────────────────────────────────────
// fingerprint
// ──────────────────────────────────────────────────────────────

test('fingerprint is deterministic and ignores costs', () => {
  const a = fingerprint(indexScanPlan());
  const variant = indexScanPlan();
  variant[0].Plan['Total Cost'] = 9999.99;
  variant[0].Plan['Actual Total Time'] = 12.5;
  variant[0]['Execution Time'] = 999;
  const b = fingerprint(variant);
  assert.equal(a, b);
  assert.equal(a, 'IndexScan:User@User_email_key');
});

test('fingerprint differs when plan shape changes', () => {
  assert.notEqual(fingerprint(indexScanPlan()), fingerprint(seqScanPlan()));
  assert.notEqual(fingerprint(indexScanPlan()), fingerprint(nestedJoinPlan()));
});

test('fingerprint walks children in order', () => {
  const fp = fingerprint(nestedJoinPlan());
  assert.equal(
    fp,
    'NestedLoop|IndexScan:Task@Task_userId_createdAt_idx|IndexOnlyScan:User@User_pkey',
  );
});

test('fingerprint of empty plan is empty string', () => {
  assert.equal(fingerprint(null), '');
  assert.equal(fingerprint([]), '');
});

// ──────────────────────────────────────────────────────────────
// collectors
// ──────────────────────────────────────────────────────────────

test('collectNodeTypes / collectIndexes / collectRelations walk the tree', () => {
  const summary = summarizePlan(nestedJoinPlan());
  assert.deepEqual(collectNodeTypes(summary), ['Nested Loop', 'Index Scan', 'Index Only Scan']);
  assert.deepEqual(collectIndexes(summary), ['Task_userId_createdAt_idx', 'User_pkey']);
  assert.deepEqual(collectRelations(summary), ['Task', 'User']);
});

test('collectScansOnRelation finds scans of a specific table', () => {
  const summary = summarizePlan(seqScanPlan());
  assert.deepEqual(collectScansOnRelation(summary, 'User'), ['Seq Scan']);
  assert.deepEqual(collectScansOnRelation(summary, 'Task'), []);
});

// ──────────────────────────────────────────────────────────────
// detectRegressions
// ──────────────────────────────────────────────────────────────

test('detectRegressions returns no issues for matching plan', () => {
  const issues = detectRegressions(indexScanPlan(), {
    fingerprint: 'IndexScan:User@User_email_key',
    topNodeType: 'Index Scan',
    noSeqScan: ['User'],
    requireIndexes: ['User_email_key'],
    maxNodes: 4,
  });
  assert.deepEqual(issues, []);
});

test('detectRegressions flags Seq Scan on a forbidden relation', () => {
  const issues = detectRegressions(seqScanPlan(), { noSeqScan: ['User'] });
  assert.ok(issues.some((i) => /Seq Scan on User/.test(i)), `got ${JSON.stringify(issues)}`);
});

test('detectRegressions flags missing required index', () => {
  const issues = detectRegressions(seqScanPlan(), { requireIndexes: ['User_email_key'] });
  assert.ok(issues.some((i) => /User_email_key/.test(i)));
});

test('detectRegressions flags forbidden index that was used', () => {
  const issues = detectRegressions(indexScanPlan(), { forbidIndexes: ['User_email_key'] });
  assert.ok(issues.some((i) => /forbidden index User_email_key/.test(i)));
});

test('detectRegressions flags top node type mismatch', () => {
  const issues = detectRegressions(seqScanPlan(), { topNodeType: 'Index Scan' });
  assert.ok(issues.some((i) => /top node type/.test(i)));
});

test('detectRegressions flags fingerprint mismatch (the canonical regression signal)', () => {
  const issues = detectRegressions(seqScanPlan(), {
    fingerprint: 'IndexScan:User@User_email_key',
  });
  assert.ok(issues.some((i) => /fingerprint mismatch/.test(i)));
});

test('detectRegressions flags disallowed node types', () => {
  const issues = detectRegressions(seqScanPlan(), { allowedNodeTypes: ['Index Scan'] });
  assert.ok(issues.some((i) => /disallowed node type Seq Scan/.test(i)));
});

test('detectRegressions flags maxNodes overflow', () => {
  const issues = detectRegressions(nestedJoinPlan(), { maxNodes: 2 });
  assert.ok(issues.some((i) => /maxNodes/.test(i)));
});

test('detectRegressions flags empty plans', () => {
  const issues = detectRegressions(null, {});
  assert.deepEqual(issues, ['plan is empty or unparseable']);
});

test('detectRegressions accepts bitmap index plans', () => {
  const issues = detectRegressions(bitmapPlan(), {
    noSeqScan: ['Task'],
    requireIndexes: ['Task_userId_idx'],
  });
  assert.deepEqual(issues, []);
});

test('assertPlanMatches throws PlanRegressionError aggregating issues', () => {
  try {
    assertPlanMatches(seqScanPlan(), {
      noSeqScan: ['User'],
      requireIndexes: ['User_email_key'],
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PlanRegressionError);
    assert.equal(err.code, 'PLAN_REGRESSION');
    assert.ok(err.issues.length >= 2);
    assert.match(err.message, /query plan regression/);
  }
});

test('assertPlanMatches is a no-op when plan matches expectations', () => {
  assert.doesNotThrow(() =>
    assertPlanMatches(indexScanPlan(), {
      fingerprint: 'IndexScan:User@User_email_key',
      noSeqScan: ['User'],
    }),
  );
});

// ──────────────────────────────────────────────────────────────
// Critical query registry
// ──────────────────────────────────────────────────────────────

test('CRITICAL_QUERIES registry is non-empty and well-formed', () => {
  assert.ok(CRITICAL_QUERIES.length >= 3);
  for (const q of CRITICAL_QUERIES) {
    assert.equal(typeof q.name, 'string');
    assert.equal(typeof q.sql, 'string');
    assert.ok(q.sql.toLowerCase().trim().startsWith('select'));
    assert.ok(Array.isArray(q.params));
    assert.equal(typeof q.expected, 'object');
  }
  // names are unique
  const names = CRITICAL_QUERIES.map((q) => q.name);
  assert.equal(new Set(names).size, names.length);
});

test('listCriticalQueries returns a deep-ish copy', () => {
  const list = listCriticalQueries();
  assert.equal(list.length, CRITICAL_QUERIES.length);
  list[0].name = 'mutated';
  assert.notEqual(CRITICAL_QUERIES[0].name, 'mutated');
});

test('findCriticalQuery looks up by name', () => {
  assert.equal(findCriticalQuery('user_by_email').name, 'user_by_email');
  assert.equal(findCriticalQuery('does_not_exist'), null);
});

// ──────────────────────────────────────────────────────────────
// runCriticalQueryRegression — orchestration with stub Prisma
// ──────────────────────────────────────────────────────────────

function makePrismaStubFor(planByQuery) {
  return {
    async $queryRawUnsafe(sql /* , ...params */) {
      for (const [needle, plan] of Object.entries(planByQuery)) {
        if (sql.includes(needle)) {
          return [{ 'QUERY PLAN': plan }];
        }
      }
      return [{ 'QUERY PLAN': seqScanPlan() }];
    },
  };
}

test('runCriticalQueryRegression returns no failures when all plans match', async () => {
  const prisma = makePrismaStubFor({
    'FROM "User" WHERE email': indexScanPlan(),
    'FROM "Task" WHERE "userId"': [
      {
        Plan: {
          'Node Type': 'Limit',
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'Task',
              'Index Name': 'Task_userId_createdAt_idx',
              'Scan Direction': 'Backward',
            },
          ],
        },
      },
    ],
    'FROM "IdempotencyKey" WHERE key': [
      {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'IdempotencyKey',
          'Index Name': 'IdempotencyKey_key_key',
        },
      },
    ],
  });
  const failures = await runCriticalQueryRegression(prisma);
  assert.deepEqual(failures, [], `unexpected failures: ${JSON.stringify(failures, null, 2)}`);
});

test('runCriticalQueryRegression reports failures with summarized plan + fingerprint', async () => {
  // Force every query to come back as Seq Scan on User → trips noSeqScan.
  const prisma = makePrismaStubFor({});
  const failures = await runCriticalQueryRegression(prisma, {
    queries: [findCriticalQuery('user_by_email')],
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, 'user_by_email');
  assert.ok(failures[0].issues.some((i) => /Seq Scan on User/.test(i)));
  assert.equal(failures[0].fingerprint, 'SeqScan:User');
  assert.equal(failures[0].plan.nodeType, 'Seq Scan');
});

test('runCriticalQueryRegression captures explain() errors as failures, not throws', async () => {
  const prisma = {
    async $queryRawUnsafe() {
      throw new Error('connection refused');
    },
  };
  const failures = await runCriticalQueryRegression(prisma, {
    queries: [findCriticalQuery('user_by_email')],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0].issues[0], /explain\(\) failed: connection refused/);
});

test('runCriticalQueryRegression respects opts.queries override', async () => {
  const prisma = makePrismaStubFor({
    custom_marker: indexScanPlan(),
  });
  const failures = await runCriticalQueryRegression(prisma, {
    queries: [
      {
        name: 'custom',
        sql: 'SELECT 1 /* custom_marker */',
        params: [],
        expected: { fingerprint: 'IndexScan:User@User_email_key' },
      },
    ],
  });
  assert.deepEqual(failures, []);
});
