'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Query Plan Analyzer (PostgreSQL EXPLAIN)
// ──────────────────────────────────────────────────────────────
// Runs EXPLAIN (ANALYZE, FORMAT JSON) for a parameterized query and
// returns the parsed plan. Refuses to execute in production unless
// EXPLAIN_ALLOW_PROD=1 is set, because EXPLAIN ANALYZE actually
// executes the query and may have side effects on writes.
//
// Usage:
//   const { explain } = require('./explain');
//   const plan = await explain(prisma, 'SELECT * FROM "User" WHERE id = $1', [id]);
//
// The function rejects any statement that does not start with
// SELECT/WITH (after trimming/comments) so a misuse cannot mutate
// data, even outside production.
// ──────────────────────────────────────────────────────────────

class ExplainNotAllowedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExplainNotAllowedError';
    this.code = 'EXPLAIN_NOT_ALLOWED';
  }
}

class ExplainInvalidQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExplainInvalidQueryError';
    this.code = 'EXPLAIN_INVALID_QUERY';
  }
}

function stripLeadingComments(sql) {
  let s = String(sql || '').trim();
  // Strip /* ... */ and -- line comments at the start, repeatedly.
  // Loop is bounded by string length to prevent pathological input.
  for (let i = 0; i < 32; i++) {
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end === -1) break;
      s = s.slice(end + 2).trim();
      continue;
    }
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1).trim();
      continue;
    }
    break;
  }
  return s;
}

function isReadOnlyQuery(sql) {
  const head = stripLeadingComments(sql).slice(0, 16).toLowerCase();
  return head.startsWith('select') || head.startsWith('with') || head.startsWith('table ') || head.startsWith('values');
}

function isProdEnvironment() {
  return process.env.NODE_ENV === 'production' && process.env.EXPLAIN_ALLOW_PROD !== '1';
}

async function explain(prisma, sql, params = [], opts = {}) {
  if (isProdEnvironment()) {
    throw new ExplainNotAllowedError('EXPLAIN is disabled in production (set EXPLAIN_ALLOW_PROD=1 to override).');
  }
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new ExplainInvalidQueryError('explain() requires a non-empty SQL string.');
  }
  if (!isReadOnlyQuery(sql)) {
    throw new ExplainInvalidQueryError('explain() only accepts SELECT/WITH/VALUES statements.');
  }
  if (!prisma || typeof prisma.$queryRawUnsafe !== 'function') {
    throw new ExplainInvalidQueryError('explain() requires a Prisma client with $queryRawUnsafe.');
  }

  const flags = [];
  flags.push(opts.analyze === false ? 'ANALYZE FALSE' : 'ANALYZE TRUE');
  if (opts.buffers) flags.push('BUFFERS TRUE');
  if (opts.verbose) flags.push('VERBOSE TRUE');
  flags.push('FORMAT JSON');

  const explainSql = `EXPLAIN (${flags.join(', ')}) ${sql}`;

  const rows = await prisma.$queryRawUnsafe(explainSql, ...params);
  // Postgres returns a single row whose value is the JSON plan array.
  // Different drivers expose it under different keys, so be tolerant.
  if (!Array.isArray(rows) || rows.length === 0) return { plan: null, raw: rows };
  const first = rows[0];
  const value = first && (first['QUERY PLAN'] || first.query_plan || first.plan || Object.values(first)[0]);
  return {
    plan: value ?? null,
    raw: rows,
    sql: explainSql,
  };
}

module.exports = {
  explain,
  isReadOnlyQuery,
  isProdEnvironment,
  stripLeadingComments,
  ExplainNotAllowedError,
  ExplainInvalidQueryError,
};
