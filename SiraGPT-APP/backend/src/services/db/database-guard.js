'use strict';

// ──────────────────────────────────────────────────────────────
// database-guard.js — runtime guard against destructive SQL
// ──────────────────────────────────────────────────────────────
// Wraps a Prisma client's RAW SQL methods ($executeRaw(Unsafe),
// $queryRaw(Unsafe)) and inspects each statement for destructive
// operations: DROP / TRUNCATE / DELETE-without-WHERE / lossy ALTER
// (DROP COLUMN/CONSTRAINT) / UPDATE-without-WHERE. Reuses
// services/db/sql-safety.js for the leading-op taxonomy and
// utils/audit-log.js for the durable, secret-redacting audit trail.
//
// Modes (env SIRAGPT_DB_GUARD, default 'monitor'):
//   off     — disabled, the client is left untouched.
//   monitor — audit destructive ops, DO NOT block (safe default).
//   enforce — audit + throw (block the operation).
//
// SAFETY — the guard is FAIL-OPEN at every level. Any error inside the
// guard (sql extraction, inspection, audit) is swallowed and the
// original query proceeds, so a guard bug can NEVER take down DB
// access. The ONLY path that throws is an explicit enforce-mode block,
// and only for genuinely destructive statements.
//
// Scope — typed Prisma model methods (.create/.update/.deleteMany) are
// intentionally NOT wrapped: that is trusted application code. The
// guard targets the raw-SQL path, where agents / admin scripts can
// inject destructive operations. This keeps the blast radius tiny and
// the per-query overhead near-zero (a cheap keyword pre-filter skips
// every SELECT/INSERT before any analysis runs).
// ──────────────────────────────────────────────────────────────

const sqlSafety = require('./sql-safety');

let writeAuditLog = null;
try {
  // eslint-disable-next-line global-require
  ({ writeAuditLog } = require('../../utils/audit-log'));
} catch (_e) {
  writeAuditLog = null;
}

const RAW_METHODS = ['$executeRawUnsafe', '$queryRawUnsafe', '$executeRaw', '$queryRaw'];

// Only statements containing one of these keywords can possibly be
// destructive, so the common SELECT/INSERT path skips analysis entirely.
const MAYBE_DESTRUCTIVE = /\b(drop|truncate|delete|alter|update)\b/i;

function resolveMode(explicit) {
  const m = String(explicit || process.env.SIRAGPT_DB_GUARD || 'monitor').toLowerCase();
  return ['off', 'monitor', 'enforce'].includes(m) ? m : 'monitor';
}

/**
 * Best-effort SQL-string extraction from a raw-method call. Handles
 * both the *Unsafe (plain string) and tagged-template (TemplateStrings
 * array / Prisma.Sql) forms. We only need the STATIC parts: destructive
 * keywords live in the SQL skeleton, never in bound values.
 */
function extractSql(method, args) {
  const first = args && args[0];
  if (first == null) return '';
  if (method.endsWith('Unsafe')) return typeof first === 'string' ? first : '';
  if (typeof first === 'string') return first;
  if (Array.isArray(first.strings)) return first.strings.join(' ? '); // Prisma.Sql
  if (typeof first.sql === 'string') return first.sql; // Prisma.Sql .sql getter
  if (Array.isArray(first)) return first.join(' ? '); // TemplateStringsArray
  return '';
}

/**
 * Blank out string literals ('...' / "...") and comments (-- line, block)
 * so destructive-keyword detection sees only SQL structure: the word
 * "drop" inside a string value, or a column named "deleted", must not
 * trip the guard, and a WHERE that only appears inside a comment must not
 * mask a destructive DELETE. Length is preserved (chars → spaces) so the
 * structure (statement boundaries, keyword positions) stays intact.
 */
function stripLiteralsAndComments(sql) {
  let out = '';
  let state = 'code'; // code | single | double | line | block
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (state === 'code') {
      if (c === "'") { state = 'single'; out += ' '; continue; }
      if (c === '"') { state = 'double'; out += ' '; continue; }
      if (c === '-' && c2 === '-') { state = 'line'; out += '  '; i += 1; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 1; continue; }
      out += c; continue;
    }
    if (state === 'single') {
      if (c === "'" && c2 === "'") { out += '  '; i += 1; continue; } // escaped ''
      if (c === "'") { state = 'code'; out += ' '; continue; }
      out += ' '; continue;
    }
    if (state === 'double') {
      if (c === '"' && c2 === '"') { out += '  '; i += 1; continue; } // escaped ""
      if (c === '"') { state = 'code'; out += ' '; continue; }
      out += ' '; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; continue; }
      out += ' '; continue;
    }
    // block comment
    if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 1; continue; }
    out += ' ';
  }
  return out;
}

/**
 * Inspect a SQL string. Returns
 *   { destructive:boolean, reasons:string[], classification:string }
 * Never throws (fail-open: an inspection bug reports non-destructive).
 * Detection runs on a literal/comment-stripped copy, and DELETE/UPDATE
 * -without-WHERE is checked per statement so a trailing destructive
 * statement in a multi-statement payload is still caught.
 */
function inspectSql(rawSql) {
  const sql = String(rawSql == null ? '' : rawSql);
  const reasons = [];
  let classification = 'unknown';
  try {
    if (!MAYBE_DESTRUCTIVE.test(sql)) {
      return { destructive: false, reasons, classification: 'safe' };
    }
    try {
      const a = sqlSafety.analyzeSql(sql, { allowDDL: true });
      classification = (a && a.classification) || 'unknown';
    } catch (_e) {
      // analyzeSql failed — fall back to regex-only detection below.
    }
    const stripped = stripLiteralsAndComments(sql);
    if (!MAYBE_DESTRUCTIVE.test(stripped)) {
      // Every destructive keyword was inside a string literal or comment.
      return { destructive: false, reasons, classification };
    }
    if (/\bdrop\s+(table|database|schema|index|view|sequence|materialized|type|function|trigger)\b/i.test(stripped)) {
      reasons.push('drop');
    }
    if (/\btruncate\b/i.test(stripped)) {
      reasons.push('truncate');
    }
    if (/\balter\s+table\b[\s\S]*?\bdrop\s+(column|constraint)\b/i.test(stripped)) {
      reasons.push('alter_drop');
    }
    const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
    for (const st of statements.length ? statements : [stripped]) {
      const sl = st.toLowerCase();
      if (/\bdelete\s+from\b/i.test(st) && !/\bwhere\b/.test(sl)) reasons.push('delete_without_where');
      if (/\bupdate\b[\s\S]*?\bset\b/i.test(st) && !/\bwhere\b/.test(sl)) reasons.push('update_without_where');
    }
  } catch (_e) {
    return { destructive: false, reasons: [], classification };
  }
  const unique = [...new Set(reasons)];
  return { destructive: unique.length > 0, reasons: unique, classification };
}

function sqlPreview(sql, max = 400) {
  const s = String(sql || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Default destructive-op sink: write a durable audit row. Fire-and-forget
 * — never affects the query path, never throws.
 */
function auditDestructive(prisma, info) {
  if (!writeAuditLog) return;
  try {
    Promise.resolve(
      writeAuditLog(prisma, {
        action: 'db.destructive_sql',
        actorType: 'system',
        resource: 'database',
        resourceId: info.source || 'prisma',
        tags: ['db-guard', info.mode, ...info.verdict.reasons],
        metadata: {
          mode: info.mode,
          source: info.source || 'prisma',
          reasons: info.verdict.reasons,
          classification: info.verdict.classification,
          blocked: info.mode === 'enforce',
          sqlPreview: sqlPreview(info.sql),
        },
      }),
    ).catch(() => {});
  } catch (_e) {
    // never throw from the audit path
  }
}

/**
 * Pure verdict helper for explicit callers (e.g. an agent SQL tool that
 * wants to pre-check before executing). Does not audit or block.
 */
function guardRawSql(sql, opts = {}) {
  const mode = resolveMode(opts.mode);
  const verdict = inspectSql(sql);
  return { mode, allowed: !(mode === 'enforce' && verdict.destructive), ...verdict };
}

class DatabaseGuardError extends Error {
  constructor(reasons) {
    super(
      `DatabaseGuard blocked a destructive operation (${reasons.join(', ')}). ` +
        'Set SIRAGPT_DB_GUARD=monitor to audit without blocking.',
    );
    this.name = 'DatabaseGuardError';
    this.code = 'DB_GUARD_BLOCKED';
    this.reasons = reasons;
  }
}

/**
 * Wrap the raw-SQL methods of a Prisma client with the guard.
 * Idempotent (skips if already attached). Fail-open: a reassignment
 * failure leaves the original method in place.
 *
 * @param {object} prisma                  Prisma client (mutated in place).
 * @param {object} [opts]
 * @param {('off'|'monitor'|'enforce')} [opts.mode]  Override env.
 * @param {Function} [opts.onDestructive]  (info) => void sink; defaults to audit.
 * @returns {object} the same prisma client.
 */
function attachDatabaseGuard(prisma, opts = {}) {
  if (!prisma || prisma.__dbGuardAttached) return prisma;
  const mode = resolveMode(opts.mode);
  if (mode === 'off') {
    prisma.__dbGuardMode = 'off';
    return prisma;
  }
  const onDestructive =
    typeof opts.onDestructive === 'function'
      ? opts.onDestructive
      : (info) => auditDestructive(prisma, info);

  for (const method of RAW_METHODS) {
    let orig;
    try {
      orig = prisma[method];
    } catch (_e) {
      orig = null;
    }
    if (typeof orig !== 'function') continue;
    const bound = orig.bind(prisma);
    try {
      prisma[method] = function guardedRaw(...args) {
        let block = null;
        try {
          const sql = extractSql(method, args);
          if (sql && MAYBE_DESTRUCTIVE.test(sql)) {
            const verdict = inspectSql(sql);
            if (verdict.destructive) {
              try {
                onDestructive({ sql, verdict, mode, source: `prisma:${method}` });
              } catch (_e) {
                // a broken sink must not affect the query
              }
              if (mode === 'enforce') block = new DatabaseGuardError(verdict.reasons);
            }
          }
        } catch (_e) {
          // any guard error → fail open (run the original query)
        }
        // The raw methods are async; reject asynchronously to preserve the
        // promise contract (callers may use .then/.catch, not just await).
        if (block) return Promise.reject(block);
        return bound(...args);
      };
    } catch (_e) {
      // method not writable on this Prisma build — leave original (fail-open)
    }
  }
  prisma.__dbGuardAttached = true;
  prisma.__dbGuardMode = mode;
  try {
    // eslint-disable-next-line no-console
    console.log(`🛡️  Database Guard active (mode=${mode})`);
  } catch (_e) {
    /* noop */
  }
  return prisma;
}

module.exports = {
  attachDatabaseGuard,
  inspectSql,
  guardRawSql,
  DatabaseGuardError,
  // exported for tests
  extractSql,
  resolveMode,
};
