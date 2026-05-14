'use strict';

/**
 * document-prisma-schema.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Prisma schema language constructs in `.prisma` files:
 *
 *   - datasource db { ... }
 *   - generator client { ... }
 *   - model X { ... }    with field attributes (@id @unique @default @relation)
 *   - enum X { ... }
 *   - model-level attributes: @@map @@unique @@index @@id @@schema
 *
 * Public API:
 *   extractPrismaSchema(text)             → { entries, totals, total }
 *   buildPrismaSchemaForFiles(files)      → { perFile, aggregate, totals }
 *   renderPrismaSchemaBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const MODEL_RE = /\bmodel\s+([A-Z][A-Za-z0-9_]{0,60})\s*\{/g;
const ENUM_RE = /\benum\s+([A-Z][A-Za-z0-9_]{0,60})\s*\{/g;
const DATASOURCE_RE = /\bdatasource\s+([a-z][a-zA-Z0-9_]{0,40})\s*\{/g;
const GENERATOR_RE = /\bgenerator\s+([a-z][a-zA-Z0-9_]{0,40})\s*\{/g;
const FIELD_ATTR_RE = /(?:^|[^@\w])@(id|unique|default|relation|map|updatedAt|ignore|db\.[A-Za-z]+)\b/g;
const MODEL_ATTR_RE = /@@(id|unique|index|map|schema|fulltext)\b/g;
const PROVIDER_RE = /\bprovider\s*=\s*"(postgresql|mysql|sqlite|mongodb|sqlserver|cockroachdb|prisma\+postgres)"/g;

function extractPrismaSchema(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { model: 0, enum: 0, datasource: 0, generator: 0, fieldAttr: 0, modelAttr: 0, provider: 0 };

  function push(kind, name, value) {
    const sig = `${kind}:${name}:${value || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, value });
    if (totals[kind] != null) totals[kind] += 1;
  }

  MODEL_RE.lastIndex = 0;
  let m;
  while ((m = MODEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('model', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    ENUM_RE.lastIndex = 0;
    while ((m = ENUM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('enum', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DATASOURCE_RE.lastIndex = 0;
    while ((m = DATASOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('datasource', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    GENERATOR_RE.lastIndex = 0;
    while ((m = GENERATOR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('generator', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PROVIDER_RE.lastIndex = 0;
    while ((m = PROVIDER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('provider', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FIELD_ATTR_RE.lastIndex = 0;
    while ((m = FIELD_ATTR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('fieldAttr', `@${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    MODEL_ATTR_RE.lastIndex = 0;
    while ((m = MODEL_ATTR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('modelAttr', `@@${m[1]}`, null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPrismaSchemaForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { model: 0, enum: 0, datasource: 0, generator: 0, fieldAttr: 0, modelAttr: 0, provider: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPrismaSchema(txt);
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

function renderPrismaSchemaBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PRISMA SCHEMA'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPrismaSchema,
  buildPrismaSchemaForFiles,
  renderPrismaSchemaBlock,
};
