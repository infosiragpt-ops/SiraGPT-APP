'use strict';

/**
 * document-outline-generator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds a hierarchical outline / table of contents from a document so the
 * model receives a navigation map BEFORE it engages with the body. This
 * helps the model:
 *   - cite the correct section when answering questions
 *   - estimate where a topic lives without re-scanning the whole text
 *   - report progress ("answer based on §3 and §4.2") naturally
 *
 * Detection sources (in priority order):
 *   1. Markdown headings (#, ##, ###, …) — the most reliable signal.
 *   2. setext headings (Title\n=====, Subtitle\n-----).
 *   3. Numbered headings: "1.", "1.1", "1.1.1" + a Title-Cased phrase.
 *   4. ALL-CAPS lines that look like section banners (≤80 chars, ≥10 chars,
 *      not a sentence — typical of Word/PDF exports).
 *
 * Public API:
 *   extractOutline(text, opts)       → OutlineReport
 *   buildOutlineForFiles(files)      → { perFile, primary }
 *   renderOutlineBlock(report)       → markdown string
 *
 * Constraints: pure function, sync, no LLM, <30 ms per 1 MB.
 */

const MAX_SECTIONS = 60;
const MAX_DEPTH = 6;
const EXCERPT_CHARS = 100;
const SCAN_HEAD_BYTES = 80_000;

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, max = EXCERPT_CHARS) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function slugify(title) {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

// ──────────────────────────────────────────────────────────────────────────
// Heading collectors
// ──────────────────────────────────────────────────────────────────────────

function collectMarkdownHeadings(text) {
  const out = [];
  // Capture the headings + their byte offsets so we can pull excerpts later.
  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      depth: Math.min(m[1].length, MAX_DEPTH),
      title: m[2].trim(),
      offset: m.index,
      source: 'markdown',
    });
  }
  return out;
}

function collectSetextHeadings(text) {
  const out = [];
  // Title\n=====   (h1)   or   Subtitle\n-----  (h2)
  const re = /^([^\n]{3,120})\n(=+|-+)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const depth = m[2][0] === '=' ? 1 : 2;
    out.push({
      depth,
      title: m[1].trim(),
      offset: m.index,
      source: 'setext',
    });
  }
  return out;
}

function collectNumberedHeadings(text) {
  const out = [];
  // "1. Section title"   "1.1. Subsection"   "1.1.1 Sub-subsection"
  const re = /^\s*(\d+(?:\.\d+){0,5})\.?\s+([A-ZÁÉÍÓÚÑ][^\n]{3,120})$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const number = m[1];
    const depth = Math.min(number.split('.').length, MAX_DEPTH);
    out.push({
      depth,
      number,
      title: m[2].trim(),
      offset: m.index,
      source: 'numbered',
    });
  }
  return out;
}

function collectAllCapsHeadings(text) {
  const out = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 10 && trimmed.length <= 80
        && trimmed === trimmed.toUpperCase()
        && /[A-ZÁÉÍÓÚÑ]{4,}/.test(trimmed)
        && !/[.!?]$/.test(trimmed)) {
      // Only count lines that aren't surrounded by other content on both sides
      out.push({
        depth: 1,
        title: trimmed,
        offset,
        source: 'allcaps',
      });
    }
    offset += line.length + 1; // +1 for the newline
  }
  return out;
}

/**
 * Merge headings detected by all four collectors, deduplicated by offset and
 * preserved in document order. Markdown beats setext beats numbered beats
 * allcaps for any conflicting offset window.
 */
function mergeAndOrder(headings) {
  // Sort by offset ascending
  const sorted = headings.slice().sort((a, b) => a.offset - b.offset);
  const out = [];
  const sourcePriority = { markdown: 4, setext: 3, numbered: 2, allcaps: 1 };
  for (const h of sorted) {
    const last = out[out.length - 1];
    // If this heading is within 2 chars of the previous one, keep the higher
    // priority source (e.g. markdown beats numbered when both fired on the
    // same line).
    if (last && Math.abs(h.offset - last.offset) <= 2) {
      if (sourcePriority[h.source] > sourcePriority[last.source]) {
        out[out.length - 1] = h;
      }
      continue;
    }
    out.push(h);
  }
  return out.slice(0, MAX_SECTIONS);
}

function pullSectionExcerpt(text, headings, idx) {
  const start = headings[idx].offset;
  // Skip the heading line itself
  const headingEol = text.indexOf('\n', start);
  if (headingEol < 0) return '';
  const next = headings[idx + 1] ? headings[idx + 1].offset : text.length;
  const body = text.slice(headingEol + 1, next).trim();
  // Pull the first non-empty paragraph
  const para = body.split(/\n{2,}/).map((p) => p.trim()).find((p) => p.length > 0) || '';
  return clip(para.replace(/\s+/g, ' '));
}

function estimateWordCount(text) {
  return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
}

// ──────────────────────────────────────────────────────────────────────────
// Public extractor
// ──────────────────────────────────────────────────────────────────────────

function extractOutline(text) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return { sections: [], depth: 0, totalSections: 0, hasOutline: false, source: 'none' };
  }
  const head = safe.slice(0, SCAN_HEAD_BYTES);

  const all = [
    ...collectMarkdownHeadings(head),
    ...collectSetextHeadings(head),
    ...collectNumberedHeadings(head),
  ];
  // Only fall back to all-caps banners if no other source found anything —
  // ALL-CAPS lines are noisy and would dominate a markdown doc otherwise.
  const ordered = all.length > 0 ? mergeAndOrder(all) : mergeAndOrder(collectAllCapsHeadings(head));
  if (ordered.length === 0) {
    return { sections: [], depth: 0, totalSections: 0, hasOutline: false, source: 'none' };
  }

  const sections = ordered.map((h, i) => {
    const excerpt = pullSectionExcerpt(head, ordered, i);
    const start = h.offset;
    const end = ordered[i + 1] ? ordered[i + 1].offset : safe.length;
    const sectionText = safe.slice(start, end);
    const words = estimateWordCount(sectionText);
    return {
      depth: h.depth,
      number: h.number || null,
      title: h.title,
      slug: slugify(h.title),
      offset: h.offset,
      words,
      excerpt,
      source: h.source,
    };
  });

  const maxDepth = Math.max(...sections.map((s) => s.depth));
  const sourceCounts = new Map();
  for (const s of sections) sourceCounts.set(s.source, (sourceCounts.get(s.source) || 0) + 1);
  const dominantSource = Array.from(sourceCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];

  return {
    sections,
    depth: maxDepth,
    totalSections: sections.length,
    hasOutline: true,
    source: dominantSource,
    estimatedReadingMinutes: Math.max(1, Math.ceil(sections.reduce((acc, s) => acc + s.words, 0) / 220)),
  };
}

function buildOutlineForFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const perFile = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const text = safeText(f.extractedText || f.text || '');
    if (!text.trim()) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    const report = extractOutline(text);
    if (report.hasOutline) perFile.push({ file: label, report });
  }
  // Choose the "primary" outline as the file with the most sections
  const primary = perFile.length > 0 ? perFile.slice().sort((a, b) => b.report.totalSections - a.report.totalSections)[0] : null;
  return { perFile, primary };
}

function renderOutlineBlock(report, opts = {}) {
  if (!report || !report.hasOutline || report.totalSections === 0) return '';
  const lines = [];
  const title = opts.title || 'DOCUMENT OUTLINE';
  const fileLabel = opts.fileLabel ? ` — ${opts.fileLabel}` : '';
  lines.push(`## ${title}${fileLabel}`);
  lines.push(`Use this outline as the navigation map. When the user asks about a topic, identify the most relevant section by title and cite it ("§${report.sections[0].number || '1'} — ${report.sections[0].title}"). Reading time estimate: ~${report.estimatedReadingMinutes} min.`);

  for (const section of report.sections) {
    const indent = '  '.repeat(Math.max(0, section.depth - 1));
    const number = section.number ? `**§${section.number}** ` : '';
    const wordCount = section.words ? ` _(${section.words} words)_` : '';
    lines.push(`${indent}- ${number}${section.title}${wordCount}`);
    if (section.excerpt) {
      lines.push(`${indent}  _${section.excerpt}_`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  extractOutline,
  buildOutlineForFiles,
  renderOutlineBlock,
  _internal: {
    collectMarkdownHeadings,
    collectSetextHeadings,
    collectNumberedHeadings,
    collectAllCapsHeadings,
    mergeAndOrder,
    slugify,
  },
};
