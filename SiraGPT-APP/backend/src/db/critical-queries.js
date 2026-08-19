'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Critical Query Plan Registry
// ──────────────────────────────────────────────────────────────
// Each entry pins a query whose plan we expect to remain stable.
// CI fails if the planner deviates from the recorded shape (a new
// Seq Scan appears, an expected index is no longer used, the top
// node type changes, etc).
//
// To run against a real database:
//
//   const { runCriticalQueryRegression } =
//     require('./critical-queries');
//   const failures = await runCriticalQueryRegression(prisma);
//   if (failures.length) process.exit(1);
//
// To add a new query, capture its EXPLAIN plan once on a healthy
// database, derive the fingerprint with `fingerprint(plan)`, and
// commit the entry below.
// ──────────────────────────────────────────────────────────────

const { explain } = require('./explain');
const {
  detectRegressions,
  fingerprint,
  summarizePlan,
} = require('./query-plan-regression');

// Read-only baseline. Each entry is a snapshot — bump intentionally.
const CRITICAL_QUERIES = Object.freeze([
  Object.freeze({
    name: 'user_by_email',
    description: 'Auth lookup — must hit the unique email index, never Seq Scan User.',
    sql: 'SELECT id, email FROM "User" WHERE email = $1',
    params: ['user@example.com'],
    expected: Object.freeze({
      topNodeType: 'Index Scan',
      noSeqScan: Object.freeze(['User']),
      requireIndexes: Object.freeze(['User_email_key']),
      maxNodes: 4,
    }),
  }),
  Object.freeze({
    name: 'task_by_user_recent',
    description: 'Task listing for a user — must use the user_id index.',
    sql: 'SELECT id, status FROM "Task" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 50',
    params: ['user_123'],
    expected: Object.freeze({
      noSeqScan: Object.freeze(['Task']),
      requireIndexes: Object.freeze(['Task_userId_createdAt_idx']),
      maxNodes: 8,
    }),
  }),
  Object.freeze({
    name: 'idempotency_key_lookup',
    description: 'Idempotency middleware — must be a unique index lookup.',
    sql: 'SELECT response_body FROM "IdempotencyKey" WHERE key = $1',
    params: ['k_abc123'],
    expected: Object.freeze({
      topNodeType: 'Index Scan',
      noSeqScan: Object.freeze(['IdempotencyKey']),
      requireIndexes: Object.freeze(['IdempotencyKey_key_key']),
    }),
  }),
]);

function listCriticalQueries() {
  return CRITICAL_QUERIES.map((q) => ({ ...q, expected: { ...q.expected } }));
}

function findCriticalQuery(name) {
  return CRITICAL_QUERIES.find((q) => q.name === name) || null;
}

async function runCriticalQueryRegression(prisma, opts = {}) {
  const queries = Array.isArray(opts.queries) && opts.queries.length > 0
    ? opts.queries
    : CRITICAL_QUERIES;
  const failures = [];
  for (const q of queries) {
    let plan;
    try {
      const res = await explain(prisma, q.sql, q.params || [], {
        analyze: opts.analyze !== false,
      });
      plan = res.plan;
    } catch (err) {
      failures.push({
        name: q.name,
        issues: [`explain() failed: ${err && err.message ? err.message : String(err)}`],
        plan: null,
      });
      continue;
    }
    const issues = detectRegressions(plan, q.expected || {});
    if (issues.length > 0) {
      failures.push({
        name: q.name,
        issues,
        plan: summarizePlan(plan),
        fingerprint: fingerprint(plan),
      });
    }
  }
  return failures;
}

module.exports = {
  CRITICAL_QUERIES,
  listCriticalQueries,
  findCriticalQuery,
  runCriticalQueryRegression,
};
