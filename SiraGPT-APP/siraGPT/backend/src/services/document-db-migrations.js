'use strict';

/**
 * document-db-migrations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects database-migration file naming conventions:
 *
 *   - Flyway:        V001__create_users.sql / V1.2__add_index.sql
 *   - Liquibase:     <id>-changelog.xml references
 *   - Knex.js:       20240115120000_create_users.js
 *   - Rails:         20240115120000_create_users.rb
 *   - Django:        0001_initial.py
 *   - Alembic:       abc123def_description.py
 *   - Prisma:        20240115120000_init/migration.sql
 *   - Goose:         001_create_users.up.sql / .down.sql
 *
 * Public API:
 *   extractDbMigrations(text)             → { entries, totals, total }
 *   buildDbMigrationsForFiles(files)      → { perFile, aggregate, totals }
 *   renderDbMigrationsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4800;

const FLYWAY_RE = /\b(V\d+(?:\.\d+)*__[A-Za-z0-9_]{2,80}\.sql)/g;
const TS_RE = /\b(20\d{12}_[A-Za-z0-9_]{2,80}\.(?:rb|js|ts|py|sql))/g;
const PRISMA_RE = /\b(20\d{12}_[A-Za-z0-9_-]{2,80})\/migration\.sql/g;
const DJANGO_RE = /\b(\d{4}_[a-z][a-z0-9_]{2,80}\.py)/g;
const GOOSE_RE = /\b(\d{3,6}_[A-Za-z0-9_]{2,80}\.(?:up|down)\.sql)/g;
const ALEMBIC_RE = /\b([a-f0-9]{8,16}_[a-z][a-z0-9_]{2,80}\.py)/g;
const SQUITCH_RE = /\b(deploy|revert|verify)\/([a-z0-9_-]{2,80})\.sql\b/g;

function classifyMigration(filename) {
  if (/^V\d/.test(filename)) return 'flyway';
  if (/^20\d{12}_.*\.rb$/.test(filename)) return 'rails';
  if (/^20\d{12}_.*\.js$/.test(filename)) return 'knex';
  if (/^20\d{12}_.*\.ts$/.test(filename)) return 'knex-ts';
  if (/^20\d{12}_.*\.py$/.test(filename)) return 'sqlalchemy';
  if (/^\d{4}_.*\.py$/.test(filename)) return 'django';
  if (/\.up\.sql$|\.down\.sql$/.test(filename)) return 'goose';
  if (/^[a-f0-9]{8,16}_/.test(filename)) return 'alembic';
  if (/^20\d{12}_/.test(filename)) return 'timestamped';
  return 'other';
}

function extractDbMigrations(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  function push(filename, framework) {
    if (seen.has(filename)) return;
    seen.add(filename);
    entries.push({ filename, framework });
    totals[framework] = (totals[framework] || 0) + 1;
  }

  FLYWAY_RE.lastIndex = 0;
  let m;
  while ((m = FLYWAY_RE.exec(body)) && entries.length < MAX_PER_FILE) push(m[1], 'flyway');
  if (entries.length < MAX_PER_FILE) {
    PRISMA_RE.lastIndex = 0;
    while ((m = PRISMA_RE.exec(body)) && entries.length < MAX_PER_FILE) push(`${m[1]}/migration.sql`, 'prisma');
  }
  if (entries.length < MAX_PER_FILE) {
    GOOSE_RE.lastIndex = 0;
    while ((m = GOOSE_RE.exec(body)) && entries.length < MAX_PER_FILE) push(m[1], 'goose');
  }
  if (entries.length < MAX_PER_FILE) {
    TS_RE.lastIndex = 0;
    while ((m = TS_RE.exec(body)) && entries.length < MAX_PER_FILE) push(m[1], classifyMigration(m[1]));
  }
  if (entries.length < MAX_PER_FILE) {
    DJANGO_RE.lastIndex = 0;
    while ((m = DJANGO_RE.exec(body)) && entries.length < MAX_PER_FILE) push(m[1], 'django');
  }
  if (entries.length < MAX_PER_FILE) {
    ALEMBIC_RE.lastIndex = 0;
    while ((m = ALEMBIC_RE.exec(body)) && entries.length < MAX_PER_FILE) push(m[1], 'alembic');
  }
  if (entries.length < MAX_PER_FILE) {
    SQUITCH_RE.lastIndex = 0;
    while ((m = SQUITCH_RE.exec(body)) && entries.length < MAX_PER_FILE) push(`${m[1]}/${m[2]}.sql`, 'squitch');
  }

  return { entries, totals, total: entries.length };
}

function buildDbMigrationsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractDbMigrations(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.filename)) continue;
      aggSeen.add(e.filename);
      aggregate.push(e);
      totals[e.framework] = (totals[e.framework] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderDbMigrationsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DATABASE MIGRATION FILES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.framework}] \`${e.filename}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractDbMigrations,
  buildDbMigrationsForFiles,
  renderDbMigrationsBlock,
  _internal: { classifyMigration },
};
