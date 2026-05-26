'use strict';

/**
 * document-mime-types.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects MIME type references in API specs / HTTP docs / file format
 * documentation:
 *
 *   - text/plain, text/html, text/css, text/javascript, text/markdown
 *   - application/json, application/xml, application/octet-stream,
 *     application/pdf, application/x-www-form-urlencoded
 *   - image/png, image/jpeg, image/gif, image/svg+xml, image/webp
 *   - audio/mpeg, audio/wav, audio/ogg
 *   - video/mp4, video/webm, video/quicktime
 *   - multipart/form-data, multipart/mixed
 *
 * Validates against the top-level type whitelist. Routes "what MIME type?"
 * / "what content-type?" to a citeable list.
 *
 * Public API:
 *   extractMimeTypes(text)         → MimeReport
 *   buildMimeTypesForFiles(files)  → { perFile, aggregate, totals }
 *   renderMimeTypesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 80;

const TOP_LEVEL_TYPES = new Set([
  'text', 'application', 'image', 'audio', 'video', 'multipart',
  'message', 'model', 'font',
]);

const MIME_RE = /\b((?:text|application|image|audio|video|multipart|message|model|font)\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]{1,80})\b/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function topLevel(mime) {
  return mime.split('/')[0];
}

function extractMimeTypes(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: {}, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = {};

  for (const m of head.matchAll(MIME_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const mime = clipValue(m[1]);
    const top = topLevel(mime);
    if (!TOP_LEVEL_TYPES.has(top)) continue;
    const key = mime.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ mime, topLevel: top });
    totals[top] = (totals[top] || 0) + 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildMimeTypesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = {};
  for (const f of list) {
    const r = extractMimeTypes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(r.totals)) totals[k] = (totals[k] || 0) + r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.topLevel}] \`${e.mime}\`${file}`;
}

function renderMimeTypesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || {};
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## MIME TYPES
MIME (Media-Type) references detected: text/* (plain/html/css/javascript/markdown), application/* (json/xml/octet-stream/pdf/...), image/* (png/jpeg/svg+xml/webp/...), audio/* (mpeg/wav/ogg), video/* (mp4/webm/quicktime), multipart/* (form-data/mixed), plus message/model/font. Validated against IANA top-level types. Routes "what content-type?" / "what MIME?" to a citeable list.

**By top-level:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate MIME types across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...MIME types block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMimeTypes,
  buildMimeTypesForFiles,
  renderMimeTypesBlock,
  _internal: {
    MIME_RE,
    TOP_LEVEL_TYPES,
    topLevel,
  },
};
