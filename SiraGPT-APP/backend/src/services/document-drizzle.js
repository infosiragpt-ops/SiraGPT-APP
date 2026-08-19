'use strict';

/**
 * document-drizzle.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Drizzle ORM schema definitions and query patterns:
 *
 *   - Table definitions:  pgTable('users', {}) / mysqlTable / sqliteTable
 *   - Column types:       serial / text / varchar / integer / boolean / jsonb /
 *                         timestamp / uuid / date / decimal / real / bigint
 *   - Constraints:        .primaryKey() / .notNull() / .unique() / .default()
 *   - Foreign keys:       .references(() => other.id) / foreignKey({...})
 *   - Indexes:            index('idx_x').on(table.x) / uniqueIndex
 *   - Relations:          relations(usersTable, ({ many, one }) => ({...}))
 *   - Queries:            db.select() / db.insert() / db.update() / db.delete()
 *                         with chained .where(eq(...)) / .orderBy() / .limit()
 *
 * Public API:
 *   extractDrizzle(text)             → { entries, totals, total }
 *   buildDrizzleForFiles(files)      → { perFile, aggregate, totals }
 *   renderDrizzleBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 30;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const TABLE_RE = /\b(pgTable|mysqlTable|sqliteTable|table)\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_]{0,60})["']/g;
const COLUMN_RE = /\b(serial|bigserial|smallserial|text|varchar|char|integer|int|bigint|smallint|boolean|jsonb|json|timestamp|timestamptz|date|time|uuid|decimal|numeric|real|double|float|bytea|inet|cidr|macaddr|interval|tsvector|tsquery|point|polygon|circle|line|lseg|box|geography|geometry|pgEnum|customType|primaryKey|sql)\s*\(/g;
const CONSTRAINT_RE = /\.(primaryKey|notNull|unique|default|defaultNow|defaultRandom|references|onUpdate|onDelete|$type|array)\s*\(/g;
const RELATION_RE = /\brelations\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]{0,60})/g;
const QUERY_RE = /\bdb\s*\.\s*(select|insert|update|delete|with|transaction|execute|run|all|get|values)\s*\(/g;
const CONDITION_RE = /\b(eq|ne|gt|gte|lt|lte|isNull|isNotNull|inArray|notInArray|between|notBetween|like|notLike|ilike|notIlike|exists|notExists|and|or|not|asc|desc|sql)\s*\(/g;
const INDEX_RE = /\b(index|uniqueIndex)\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_]{0,60})["']/g;
const ENUM_RE = /\bpgEnum\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_]{0,60})["']/g;

function isDrizzleLike(body) {
  return /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(|from\s+["']drizzle-orm|\brelations\s*\(\s*[a-zA-Z_].*=>\s*\(|\.references\(\(\)\s*=>/.test(body);
}

function extractDrizzle(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isDrizzleLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    table: 0, column: 0, constraint: 0, relation: 0,
    query: 0, condition: 0, index: 0, enum: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  TABLE_RE.lastIndex = 0;
  let m;
  while ((m = TABLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('table', m[2], m[1]);
  }
  if (entries.length < MAX_PER_FILE) {
    ENUM_RE.lastIndex = 0;
    while ((m = ENUM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('enum', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RELATION_RE.lastIndex = 0;
    while ((m = RELATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('relation', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    INDEX_RE.lastIndex = 0;
    while ((m = INDEX_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('index', m[2], m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    QUERY_RE.lastIndex = 0;
    while ((m = QUERY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('query', `db.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    COLUMN_RE.lastIndex = 0;
    while ((m = COLUMN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('column', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CONSTRAINT_RE.lastIndex = 0;
    while ((m = CONSTRAINT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('constraint', `.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CONDITION_RE.lastIndex = 0;
    while ((m = CONDITION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('condition', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildDrizzleForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    table: 0, column: 0, constraint: 0, relation: 0,
    query: 0, condition: 0, index: 0, enum: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractDrizzle(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderDrizzleBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DRIZZLE ORM SCHEMA & QUERIES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractDrizzle,
  buildDrizzleForFiles,
  renderDrizzleBlock,
  _internal: { isDrizzleLike },
};
