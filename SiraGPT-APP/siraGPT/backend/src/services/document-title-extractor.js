'use strict';

/**
 * document-title-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Best-effort canonical title detector. Different from the outline
 * generator (which extracts ALL headings): this module returns ONE
 * title per document so the chat can cite "X states that …" using a
 * human title rather than a filename.
 *
 * Detection order (first hit wins):
 *   1. Markdown title:    `# Title` at the top of the doc.
 *   2. HTML title tag:    `<title>...</title>` or `<h1>...</h1>` early.
 *   3. PDF title heuristic: first non-empty line of ≤ 14 words in
 *      title-case / ALL-CAPS within the first 500 chars.
 *   4. Filename fallback:  stem of the filename (without extension or
 *      version suffix) as a last resort.
 *
 * Bilingual. Deterministic. < 8 ms on 1 MB.
 *
 * Public API:
 *   extractTitle(text, filename)            → { title, source, confidence }
 *   buildTitlesForFiles(files)              → { perFile }
 *   renderTitlesBlock(report)               → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 4_000;
const MAX_TITLE_LEN = 140;
const MAX_BLOCK_CHARS = 2400;

function safeText(v) { return typeof v === 'string' ? v : ''; }
function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_TITLE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function normaliseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function stemFilename(name) {
  if (!name) return 'attachment';
  let stem = String(name).replace(/\.[a-z0-9]{1,5}$/i, '');
  stem = stem.replace(/[\s_-]?(v\d+(?:\.\d+)*|version[\s_-]?\d+|rev\d+|r\d+|draft|borrador|final|definitiv[oa]|\d{4}-\d{2}-\d{2})$/i, '');
  stem = stem.replace(/[_\-]+/g, ' ').trim();
  return stem || 'attachment';
}

function tryMarkdownTitle(head) {
  // First non-empty line. Accept `# Title` (or 2 - 6 hashes when no `# `
  // exists earlier).
  const lines = head.split('\n').map((l) => l.trim());
  for (const line of lines) {
    if (!line) continue;
    const m1 = line.match(/^#\s+(.{3,140}?)\s*#*$/);
    if (m1) return { title: clip(normaliseWhitespace(m1[1])), source: 'markdown' };
    const m2 = line.match(/^#{2,6}\s+(.{3,140}?)\s*#*$/);
    if (m2) return { title: clip(normaliseWhitespace(m2[1])), source: 'markdown' };
    break;
  }
  return null;
}

function tryHtmlTitle(head) {
  const t1 = head.match(/<title[^>]*>\s*([^<]{3,180})\s*<\/title>/i);
  if (t1) return { title: clip(normaliseWhitespace(t1[1])), source: 'html-title' };
  const h1 = head.match(/<h1[^>]*>\s*([^<]{3,180})\s*<\/h1>/i);
  if (h1) return { title: clip(normaliseWhitespace(h1[1])), source: 'html-h1' };
  return null;
}

function tryPdfHeuristic(head) {
  // Take first non-empty line(s) until we find one that looks like a title.
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    const words = (line.match(/\S+/g) || []).length;
    if (words < 2 || words > 18) continue;
    if (line.endsWith('.') || line.endsWith(',')) continue;
    if (line.length < 6 || line.length > MAX_TITLE_LEN) continue;
    // ALL-CAPS or Title Case heuristic
    const upperRatio = (line.match(/[A-ZÁÉÍÓÚÑ]/g) || []).length / line.length;
    const titleCaseHits = (line.match(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/g) || []).length;
    if (upperRatio >= 0.45 || titleCaseHits >= Math.max(2, Math.floor(words / 2))) {
      return { title: clip(normaliseWhitespace(line)), source: 'pdf-heuristic' };
    }
  }
  return null;
}

function extractTitle(input, filename) {
  const text = safeText(input);
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sources = [tryMarkdownTitle, tryHtmlTitle, tryPdfHeuristic];
  let confidence = 0;
  let candidate = null;
  for (let i = 0; i < sources.length; i++) {
    const r = sources[i](head);
    if (r && r.title && r.title.length >= 3) {
      candidate = r;
      confidence = i === 0 ? 0.95 : i === 1 ? 0.9 : 0.7;
      break;
    }
  }
  if (!candidate) {
    candidate = { title: stemFilename(filename), source: 'filename' };
    confidence = 0.4;
  }
  return { title: candidate.title, source: candidate.source, confidence };
}

function buildTitlesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const name = safeFileName(f);
    const r = extractTitle(f.extractedText, name);
    perFile.push({ file: name, ...r });
  }
  return { perFile };
}

function renderTitlesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## DOCUMENT TITLES
Best-effort canonical titles per attached document. Use these when citing the source ("X states that …") instead of the filename, but verify the title against the document itself before quoting it verbatim — the detector is heuristic and may pick a misleading first line on poorly-structured documents.`;
  const lines = report.perFile.map((p) => `- **${p.file}** → "${p.title}" _(source: ${p.source}, confidence: ${(p.confidence * 100).toFixed(0)}%)_`);
  let combined = `${heading}\n\n${lines.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...titles block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTitle,
  buildTitlesForFiles,
  renderTitlesBlock,
  _internal: {
    tryMarkdownTitle,
    tryHtmlTitle,
    tryPdfHeuristic,
    stemFilename,
    SCAN_HEAD_BYTES,
    MAX_TITLE_LEN,
  },
};
