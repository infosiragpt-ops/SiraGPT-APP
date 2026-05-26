'use strict';

/**
 * document-json-ld.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects JSON-LD (JSON Linked Data) structured-data constructs commonly
 * used for schema.org markup in HTML pages:
 *
 *   - @context:   "https://schema.org" / "http://schema.org" / "schema:..."
 *   - @type:      Person, Organization, Product, Article, BreadcrumbList,
 *                 Event, WebSite, Recipe, FAQPage, HowTo, etc.
 *   - @id:        URI for the entity
 *   - @graph:     array of subentities
 *   - schema.org properties: itemListElement, mainEntity, author, datePublished, etc.
 *   - <script type="application/ld+json"> tag count
 *
 * Public API:
 *   extractJsonLd(text)             → { entries, totals, total }
 *   buildJsonLdForFiles(files)      → { perFile, aggregate, totals }
 *   renderJsonLdBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const CONTEXT_RE = /"@context"\s*:\s*("[^"\n]{1,200}"|\[[^\]]{0,300}\]|\{[^}]{0,300}\})/g;
const TYPE_RE = /"@type"\s*:\s*("([A-Z][A-Za-z]{1,60})"|\[[^\]]{0,200}\])/g;
const ID_RE = /"@id"\s*:\s*"([^"\n]{1,200})"/g;
const GRAPH_RE = /"@graph"\s*:\s*\[/g;
const SCRIPT_TAG_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["']/gi;
const SCHEMA_PROPS = new Set([
  'name', 'description', 'url', 'image', 'author', 'publisher',
  'datePublished', 'dateModified', 'headline', 'articleBody',
  'mainEntity', 'mainEntityOfPage', 'itemListElement', 'breadcrumb',
  'address', 'telephone', 'email', 'jobTitle', 'worksFor',
  'price', 'priceCurrency', 'availability', 'sku', 'brand', 'offers',
  'aggregateRating', 'ratingValue', 'reviewCount', 'review',
  'startDate', 'endDate', 'location', 'organizer', 'eventStatus',
  'recipeIngredient', 'recipeInstructions', 'cookTime', 'prepTime',
  'question', 'acceptedAnswer', 'step', 'tool', 'supply',
]);
const PROP_RE = new RegExp(`"(${[...SCHEMA_PROPS].join('|')})"\\s*:`, 'g');

function isJsonLdLike(body) {
  return /"@(context|type|graph)"|application\/ld\+json/.test(body);
}

function previewValue(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (s.length <= 40) return s;
  return `${s.slice(0, 32)}…`;
}

function extractJsonLd(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isJsonLdLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = { context: 0, type: 0, id: 0, graph: 0, property: 0, scriptTag: 0 };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  let scriptCount = 0;
  SCRIPT_TAG_RE.lastIndex = 0;
  while (SCRIPT_TAG_RE.exec(body) && scriptCount < 10) scriptCount += 1;
  totals.scriptTag = scriptCount;
  if (scriptCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'scriptTag', name: 'application/ld+json', detail: `${scriptCount} block(s)` });
  }

  CONTEXT_RE.lastIndex = 0;
  let m;
  while ((m = CONTEXT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('context', '@context', previewValue(m[1]));
  }
  if (entries.length < MAX_PER_FILE) {
    TYPE_RE.lastIndex = 0;
    while ((m = TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[2] || 'multiple';
      push('type', name, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('id', '@id', previewValue(m[1]));
    }
  }

  let graphCount = 0;
  GRAPH_RE.lastIndex = 0;
  while (GRAPH_RE.exec(body) && graphCount < 5) graphCount += 1;
  totals.graph = graphCount;
  if (graphCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'graph', name: '@graph', detail: `${graphCount} array(s)` });
  }

  if (entries.length < MAX_PER_FILE) {
    PROP_RE.lastIndex = 0;
    while ((m = PROP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('property', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildJsonLdForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { context: 0, type: 0, id: 0, graph: 0, property: 0, scriptTag: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractJsonLd(txt);
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

function renderJsonLdBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## JSON-LD STRUCTURED DATA'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` = \`${e.detail}\`` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractJsonLd,
  buildJsonLdForFiles,
  renderJsonLdBlock,
  _internal: { isJsonLdLike, previewValue, SCHEMA_PROPS },
};
