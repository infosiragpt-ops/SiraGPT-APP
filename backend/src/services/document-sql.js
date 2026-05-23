'use strict';

/**
 * document-sql.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SQL statements in docs/runbooks/RFCs/postmortems with statement
 * type and a best-effort target identifier (table / view).
 *
 *   - DDL: CREATE TABLE foo, CREATE INDEX, ALTER TABLE, DROP TABLE
 *   - DML: INSERT INTO foo, UPDATE foo, DELETE FROM foo, MERGE INTO foo
 *   - DQL: SELECT * FROM foo
 *   - DCL: GRANT … ON foo, REVOKE … ON foo
 *   - TCL: BEGIN / COMMIT / ROLLBACK / SAVEPOINT
 *   - WITH (CTE) extraction is recognised but classified as DQL
 *
 * Output groups by statement type and lists target tables. Routes
 * "what tables does this touch?", "is there a DDL change?" to a
 * citeable inventory. Different from document-code-blocks (full code)
 * by classifying SQL-specific intent.
 *
 * Public API:
 *   extractSql(text)             → SqlReport
 *   buildSqlForFiles(files)      → { perFile, aggregate, byType }
 *   renderSqlBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 32;
const MAX_BLOCK_CHARS = 5500;
const MAX_TABLE_LEN = 80;

// Capture statement + table target where applicable
// Note: tables in identifiers can be schema.table; we keep both.
const STATEMENT_PATTERNS = [
  // DDL
  { type: 'CREATE TABLE',  re: /\bCREATE\s+(?:GLOBAL\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+|VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'ddl' },
  { type: 'CREATE INDEX',  re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'ddl' },
  { type: 'CREATE VIEW',   re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW(?:\s+IF\s+NOT\s+EXISTS)?\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'ddl' },
  { type: 'ALTER TABLE',   re: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'ddl' },
  { type: 'DROP TABLE',    re: /\bDROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'ddl' },
  { type: 'DROP INDEX',    re: /\bDROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'ddl' },
  // DML
  { type: 'INSERT INTO',   re: /\bINSERT\s+INTO\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dml' },
  { type: 'UPDATE',        re: /\bUPDATE\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)\s+SET\b/gi, kind: 'dml' },
  { type: 'DELETE FROM',   re: /\bDELETE\s+FROM\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dml' },
  { type: 'MERGE INTO',    re: /\bMERGE\s+INTO\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dml' },
  { type: 'TRUNCATE',      re: /\bTRUNCATE\s+(?:TABLE\s+)?("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dml' },
  // DQL
  { type: 'SELECT FROM',   re: /\bSELECT\b[\s\S]{0,200}?\bFROM\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dql' },
  // DCL
  { type: 'GRANT',         re: /\bGRANT\s+[A-Z, ]+ON\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dcl' },
  { type: 'REVOKE',        re: /\bREVOKE\s+[A-Z, ]+ON\s+("?[a-zA-Z_][a-zA-Z0-9_.]*"?)/gi, kind: 'dcl' },
];

// Bare TCL statements (no table)
const TCL_PATTERNS = [
  { type: 'BEGIN',       re: /\bBEGIN\s*(?:TRANSACTION|TRAN)?\s*[;\n]/gi },
  { type: 'COMMIT',      re: /\bCOMMIT\s*(?:TRANSACTION|TRAN)?\s*[;\n]/gi },
  { type: 'ROLLBACK',    re: /\bROLLBACK\s*(?:TRANSACTION|TRAN)?\s*[;\n]/gi },
  { type: 'SAVEPOINT',   re: /\bSAVEPOINT\s+[a-zA-Z_][a-zA-Z0-9_]*\s*[;\n]/gi },
];

const TYPES = ['ddl', 'dml', 'dql', 'dcl', 'tcl'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipTable(t) {
  const s = String(t || '').replace(/"/g, '').trim();
  if (s.length <= MAX_TABLE_LEN) return s;
  return `${s.slice(0, MAX_TABLE_LEN - 1)}…`;
}

function emptyByKind() {
  const r = {};
  for (const k of TYPES) r[k] = 0;
  return r;
}

function extractSql(input) {
  const text = safeText(input);
  if (!text) return { statements: [], total: 0, byKind: emptyByKind(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const statements = [];
  const seen = new Set();
  const byKind = emptyByKind();

  function add(type, kind, table) {
    if (statements.length >= MAX_PER_FILE) return;
    const t = table ? clipTable(table) : null;
    const key = t ? `${type}|${t.toLowerCase()}` : `${type}|null|${statements.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    statements.push({ type, kind, table: t });
    if (TYPES.includes(kind)) byKind[kind] += 1;
  }

  for (const { type, re, kind } of STATEMENT_PATTERNS) {
    for (const m of head.matchAll(re)) add(type, kind, m[1]);
  }

  for (const { type, re } of TCL_PATTERNS) {
    for (const m of head.matchAll(re)) {
      // Only register once per type
      const key = `${type}|tcl`;
      if (seen.has(key)) continue;
      seen.add(key);
      statements.push({ type, kind: 'tcl', table: null });
      byKind.tcl += 1;
      if (statements.length >= MAX_PER_FILE) break;
    }
  }

  return { statements, total: statements.length, byKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildSqlForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byKind = emptyByKind();
  for (const f of list) {
    const r = extractSql(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, statements: r.statements, byKind: r.byKind });
    aggregate = aggregate.concat(r.statements.map((s) => ({ ...s, file: name })));
    for (const k of TYPES) byKind[k] += r.byKind[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byKind };
}

function renderStatement(s, opts = {}) {
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  const tbl = s.table ? ` \`${s.table}\`` : '';
  return `- [${s.kind.toUpperCase()}] **${s.type}**${tbl}${file}`;
}

function renderSqlBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byKind = report.byKind || emptyByKind();
  const breakdown = TYPES
    .filter((k) => byKind[k] > 0)
    .map((k) => `${k.toUpperCase()}=${byKind[k]}`)
    .join('  ');
  const heading = `## SQL STATEMENTS
SQL statements detected in the document(s) classified by kind (DDL: CREATE / ALTER / DROP; DML: INSERT / UPDATE / DELETE / MERGE / TRUNCATE; DQL: SELECT … FROM; DCL: GRANT / REVOKE; TCL: BEGIN / COMMIT / ROLLBACK / SAVEPOINT). Each entry surfaces the target table (or null for transactional statements). Routes "what tables does this touch?", "is there a DDL change?" to a citeable inventory. Different from generic code blocks by classifying SQL-specific intent.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.statements) sections.push(renderStatement(s));
  } else {
    sections.push('### Aggregate SQL across all files');
    for (const s of report.aggregate) sections.push(renderStatement(s, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.statements) sections.push(renderStatement(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...sql block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSql,
  buildSqlForFiles,
  renderSqlBlock,
  _internal: {
    STATEMENT_PATTERNS,
    TCL_PATTERNS,
    TYPES,
  },
};
