'use strict';

/**
 * document-graphql-fragments.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GraphQL schema and operation constructs:
 *
 *   - fragment <Name> on <Type> { ... }
 *   - ...spread / ...inline-fragment { ... }
 *   - directives:  @include(if: …) / @skip(if: …) / @deprecated / @client / @connection
 *   - type system: type X / interface X / input X / scalar X / enum X / union X
 *   - schema:      schema { query: Q mutation: M subscription: S }
 *
 * Public API:
 *   extractGraphqlFragments(text)         → { entries, totals, total }
 *   buildGraphqlFragmentsForFiles(files)  → { perFile, aggregate, totals }
 *   renderGraphqlFragmentsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const FRAGMENT_RE = /\bfragment\s+([A-Z][A-Za-z0-9_]{0,60})\s+on\s+([A-Z][A-Za-z0-9_]{0,60})/g;
const SPREAD_RE = /\.\.\.([A-Z][A-Za-z0-9_]{0,60})\b/g;
const INLINE_FRAG_RE = /\.\.\.\s+on\s+([A-Z][A-Za-z0-9_]{0,60})/g;
const DIRECTIVE_RE = /@(include|skip|deprecated|client|connection|defer|stream|live|cacheControl|auth|requireAuth|key|external|provides|requires|extends|tag|inaccessible|policy)\b/g;
const TYPE_DEF_RE = /\b(type|interface|input|scalar|enum|union)\s+([A-Z][A-Za-z0-9_]{0,60})\b/g;
const SCHEMA_DEF_RE = /\bschema\s*\{[^}]{0,300}\}/g;

function extractGraphqlFragments(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { fragment: 0, spread: 0, inlineFragment: 0, directive: 0, type: 0, schema: 0 };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  FRAGMENT_RE.lastIndex = 0;
  let m;
  while ((m = FRAGMENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('fragment', m[1], `on ${m[2]}`);
  }
  if (entries.length < MAX_PER_FILE) {
    INLINE_FRAG_RE.lastIndex = 0;
    while ((m = INLINE_FRAG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('inlineFragment', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SPREAD_RE.lastIndex = 0;
    while ((m = SPREAD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      // skip if it's an inline fragment ("...on TypeName") — those are tracked separately
      const start = m.index;
      const tail = body.slice(Math.max(0, start - 8), start + m[0].length);
      if (/\.\.\.\s+on\s+/.test(tail)) continue;
      push('spread', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DIRECTIVE_RE.lastIndex = 0;
    while ((m = DIRECTIVE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('directive', `@${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TYPE_DEF_RE.lastIndex = 0;
    while ((m = TYPE_DEF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('type', m[2], m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SCHEMA_DEF_RE.lastIndex = 0;
    let schemaCount = 0;
    while (SCHEMA_DEF_RE.exec(body) && schemaCount < 5) schemaCount += 1;
    if (schemaCount) {
      entries.push({ kind: 'schema', name: 'schema', detail: `${schemaCount} block(s)` });
      totals.schema = schemaCount;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGraphqlFragmentsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { fragment: 0, spread: 0, inlineFragment: 0, directive: 0, type: 0, schema: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGraphqlFragments(txt);
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

function renderGraphqlFragmentsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GRAPHQL FRAGMENTS & SCHEMA'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` — ${e.detail}` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGraphqlFragments,
  buildGraphqlFragmentsForFiles,
  renderGraphqlFragmentsBlock,
};
