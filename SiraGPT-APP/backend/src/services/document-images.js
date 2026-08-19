'use strict';

/**
 * document-images.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects image references in markdown / HTML / docs:
 *
 *   - Markdown: ![alt](url) or ![alt][ref]
 *   - HTML: <img src="..." alt="...">
 *   - Inline emoji references: :emoji_name:
 *   - Accessibility: empty alt= signals decorative; missing alt is flagged
 *
 * Output groups by source kind + reports alt-text presence. Routes
 * "what images?" / "accessibility status?" to a citeable list.
 *
 * Public API:
 *   extractImages(text)         → ImageReport
 *   buildImagesForFiles(files)  → { perFile, aggregate, totals }
 *   renderImagesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 120;

// Markdown image: ![alt](url)
const MD_IMG_RE = /!\[([^\]\n]{0,200})\]\(([^)\n]{1,300})\)/g;
// Markdown reference-style: ![alt][ref]
const MD_REF_IMG_RE = /!\[([^\]\n]{0,200})\]\[([^\]\n]{1,80})\]/g;
// HTML: <img ... src="..." ... alt="..."> (full tag capture)
const HTML_IMG_RE = /<img\s+([^>]+)>/gi;
const HTML_SRC_RE = /\bsrc\s*=\s*["']([^"'\n]{1,300})["']/i;
const HTML_ALT_RE = /\balt\s*=\s*["']([^"'\n]{0,200})["']/i;
// :emoji_name: (gitmoji / shortcodes)
const EMOJI_REF_RE = /(?:^|[\s`'"<>(])(:[a-z][a-z0-9_+\-]{1,30}:)(?=[\s`'"<>):,;.!?]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  return { md: 0, html: 0, emoji: 0, withAlt: 0, missingAlt: 0 };
}

function extractImages(input) {
  const text = safeText(input);
  if (!text) return { images: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const images = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, alt, src) {
    if (images.length >= MAX_PER_FILE) return;
    const a = clipValue(alt || '');
    const s = clipValue(src || '');
    const key = `${kind}|${s.toLowerCase()}|${a.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    images.push({ kind, alt: a, src: s, hasAlt: a.length > 0 });
    totals[kind] += 1;
    if (a.length > 0) totals.withAlt += 1;
    else totals.missingAlt += 1;
  }

  for (const m of head.matchAll(MD_IMG_RE)) add('md', m[1], m[2]);
  for (const m of head.matchAll(MD_REF_IMG_RE)) add('md', m[1], `[${m[2]}]`);
  for (const m of head.matchAll(HTML_IMG_RE)) {
    const attrs = m[1] || '';
    const src = (HTML_SRC_RE.exec(attrs) || [])[1] || '';
    const alt = (HTML_ALT_RE.exec(attrs) || [])[1] || '';
    add('html', alt, src);
  }
  for (const m of head.matchAll(EMOJI_REF_RE)) {
    if (images.length >= MAX_PER_FILE) break;
    const key = `emoji|${m[1].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ kind: 'emoji', alt: m[1], src: '', hasAlt: true });
    totals.emoji += 1;
    totals.withAlt += 1;
  }

  return { images, total: images.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildImagesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractImages(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, images: r.images, totals: r.totals });
    aggregate = aggregate.concat(r.images.map((i) => ({ ...i, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderImage(i, opts = {}) {
  const file = opts.includeFile && i.file ? ` _(${i.file})_` : '';
  const altMark = i.hasAlt ? '✓alt' : '⚠no-alt';
  const alt = i.alt ? ` "${i.alt}"` : '';
  const src = i.src ? ` ← \`${i.src}\`` : '';
  return `- [${i.kind}] ${altMark}${alt}${src}${file}`;
}

function renderImagesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = `md=${totals.md} html=${totals.html} emoji=${totals.emoji}  withAlt=${totals.withAlt} missingAlt=${totals.missingAlt}`;
  const heading = `## IMAGES / VISUAL REFS
Image references detected in the document(s): Markdown (![alt](url) and reference style ![alt][id]), HTML (<img src=... alt=...>), and emoji shortcodes (:name:). Accessibility status surfaced via alt-text presence (✓alt / ⚠no-alt). Routes "what images?" / "accessibility status?" to a citeable list.

**Counts:** ${breakdown}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const i of only.images) sections.push(renderImage(i));
  } else {
    sections.push('### Aggregate images across all files');
    for (const i of report.aggregate) sections.push(renderImage(i, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const i of p.images) sections.push(renderImage(i));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...images block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractImages,
  buildImagesForFiles,
  renderImagesBlock,
  _internal: {
    MD_IMG_RE,
    MD_REF_IMG_RE,
    HTML_IMG_RE,
    EMOJI_REF_RE,
  },
};
