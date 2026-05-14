'use strict';

/**
 * document-astro.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Astro component (.astro) and Astro framework constructs:
 *
 *   - frontmatter fences:  --- ... ---
 *   - Astro globals:       Astro.props / Astro.params / Astro.url / Astro.request
 *   - data functions:      export function getStaticPaths()  / getStaticProps()
 *   - client directives:   client:load / client:idle / client:visible / client:media / client:only
 *   - slots:               <slot /> / <slot name="x" />
 *   - layouts/imports:     import Layout from "../layouts/X.astro"
 *   - content collections: getCollection() / getEntry() / defineCollection()
 *
 * Public API:
 *   extractAstro(text)             → { entries, totals, total }
 *   buildAstroForFiles(files)      → { perFile, aggregate, totals }
 *   renderAstroBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const FRONTMATTER_RE = /^---\s*\n([\s\S]{0,3000}?)\n---/m;
const ASTRO_GLOBAL_RE = /\bAstro\.(props|params|url|request|site|generator|cookies|response|redirect|self|slots|locals)\b/g;
const STATIC_FN_RE = /\bexport\s+(?:async\s+)?function\s+(getStaticPaths|getStaticProps|getServerSideProps)\s*\(/g;
const CLIENT_DIR_RE = /\bclient:(load|idle|visible|media|only)(?:=["']([^"']{1,40})["'])?/g;
const SLOT_RE = /<slot\b(?:\s+name\s*=\s*["']([^"']{1,40})["'])?\s*\/?>/g;
const IMPORT_ASTRO_RE = /\bimport\s+(\w+)\s+from\s+["'][^"']+\.astro["']/g;
const COLLECTION_RE = /\b(getCollection|getEntry|getEntries|defineCollection)\s*\(/g;
const ASTRO_IS_PAGE_RE = /---[\s\S]{0,1000}---/;

function extractAstro(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  // Quick reject if no Astro-like signals
  if (!ASTRO_IS_PAGE_RE.test(body) && !/Astro\.|client:|defineCollection|getStaticPaths/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }

  const seen = new Set();
  const entries = [];
  const totals = {
    frontmatter: 0, global: 0, staticFn: 0, clientDir: 0,
    slot: 0, importAstro: 0, collection: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  let m;
  FRONTMATTER_RE.lastIndex = 0;
  m = body.match(FRONTMATTER_RE);
  if (m) {
    const fmLen = (m[1] || '').length;
    push('frontmatter', 'frontmatter', `${fmLen} chars`);
  }

  if (entries.length < MAX_PER_FILE) {
    ASTRO_GLOBAL_RE.lastIndex = 0;
    while ((m = ASTRO_GLOBAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('global', `Astro.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    STATIC_FN_RE.lastIndex = 0;
    while ((m = STATIC_FN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('staticFn', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CLIENT_DIR_RE.lastIndex = 0;
    while ((m = CLIENT_DIR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('clientDir', `client:${m[1]}`, m[2] || null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SLOT_RE.lastIndex = 0;
    while ((m = SLOT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('slot', m[1] ? `slot[name=${m[1]}]` : 'slot', null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    IMPORT_ASTRO_RE.lastIndex = 0;
    while ((m = IMPORT_ASTRO_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('importAstro', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    COLLECTION_RE.lastIndex = 0;
    while ((m = COLLECTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('collection', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildAstroForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    frontmatter: 0, global: 0, staticFn: 0, clientDir: 0,
    slot: 0, importAstro: 0, collection: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractAstro(txt);
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

function renderAstroBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ASTRO COMPONENTS'];
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
  extractAstro,
  buildAstroForFiles,
  renderAstroBlock,
};
