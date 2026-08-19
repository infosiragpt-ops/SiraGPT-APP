'use strict';

/**
 * document-todos.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects code-comment style markers in tech docs, code-bearing files,
 * inline TODO lists:
 *
 *   - TODO: …
 *   - FIXME: …
 *   - NOTE: …
 *   - HACK: …
 *   - XXX: …
 *   - WIP: … / WIP
 *   - BUG: …
 *   - Spanish: PENDIENTE / NOTA / OJO
 *
 * Each marker is classified into severity:
 *   - todo, fixme, note, hack, xxx, wip, bug
 *
 * Routes "what's pending?" / "what needs fixing?" to a citeable list.
 * Different from document-priority (Pn / SEV-n / Critical) by focusing
 * on inline code-comment-style action markers.
 *
 * Public API:
 *   extractTodos(text)         → TodoReport
 *   buildTodosForFiles(files)  → { perFile, aggregate, totals }
 *   renderTodosBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 10;
const MAX_PER_FILE = 28;
const MAX_AGGREGATE = 32;
const MAX_BLOCK_CHARS = 5500;
const MAX_TEXT_LEN = 180;

// Standard markers — usually all-caps + colon. Allow optional bracket or paren prefix.
const MARKER_RE = /(?:^|[\s`'"<>(/])\(?\[?(TODO|FIXME|NOTE|HACK|XXX|WIP|BUG|PENDIENTE|NOTA|OJO)\)?\]?\s*[:\-—]\s*([^\n]{1,200})/g;
// Bare WIP (no colon)
const BARE_WIP_RE = /(?:^|[\s`'"<>(\[])(WIP|TBD|TBA|TBC)(?=[\s`'"<>):,;.!?\]]|$)/g;

const KINDS = ['todo', 'fixme', 'note', 'hack', 'xxx', 'wip', 'bug', 'pendiente'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT_LEN) return t;
  return `${t.slice(0, MAX_TEXT_LEN - 1)}…`;
}

function normaliseMarker(m) {
  const s = (m || '').toLowerCase();
  if (s === 'tbd' || s === 'tba' || s === 'tbc') return 'wip';
  if (s === 'nota' || s === 'ojo') return 'note';
  return s;
}

function emptyByKind() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractTodos(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, byKind: emptyByKind(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const byKind = emptyByKind();

  function add(marker, text) {
    if (entries.length >= MAX_PER_FILE) return;
    const kind = normaliseMarker(marker);
    if (!KINDS.includes(kind)) return;
    if (byKind[kind] >= MAX_PER_KIND) return;
    const t = clipText(text);
    const key = `${kind}|${t.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, marker: marker.toUpperCase(), text: t });
    byKind[kind] += 1;
  }

  for (const m of head.matchAll(MARKER_RE)) {
    add(m[1], m[2]);
  }
  for (const m of head.matchAll(BARE_WIP_RE)) {
    add(m[1], '(no description)');
  }

  return { entries, total: entries.length, byKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildTodosForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byKind = emptyByKind();
  for (const f of list) {
    const r = extractTodos(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, byKind: r.byKind });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) byKind[k] += r.byKind[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byKind };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] **${e.marker}**${file}: ${e.text}`;
}

function renderTodosBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byKind = report.byKind || emptyByKind();
  const breakdown = KINDS
    .filter((k) => byKind[k] > 0)
    .map((k) => `${k}=${byKind[k]}`)
    .join('  ');
  const heading = `## TODO / FIXME / NOTE MARKERS
Code-comment style action markers detected in the document(s): TODO, FIXME, NOTE, HACK, XXX, WIP, BUG (plus Spanish PENDIENTE, NOTA, OJO and TBD/TBA/TBC). Different from document-priority (P0/P1/Critical) by focusing on inline action markers. Routes "what's pending?" / "what needs fixing?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate markers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...todos block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTodos,
  buildTodosForFiles,
  renderTodosBlock,
  _internal: {
    MARKER_RE,
    BARE_WIP_RE,
    KINDS,
    normaliseMarker,
  },
};
