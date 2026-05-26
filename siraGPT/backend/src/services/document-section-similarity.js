'use strict';

/**
 * document-section-similarity.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-document section similarity scorer. Splits each file into
 * sections (via the same heading rules as document-fact-density) and
 * scores pairwise similarity between sections from DIFFERENT files.
 * Surfaces top matches so the chat can answer:
 *
 *   - "Compare the SCOPE OF WORK in contract A and contract B."
 *   - "Where does each file talk about pricing?"
 *   - "Which sections discuss compliance across these documents?"
 *
 * Different from document-relationship-classifier (file-level kinds)
 * and document-comparison-engine (high-level shared entities + diverging
 * numbers): this module surfaces SECTION ↔ SECTION matches with the
 * source headings preserved.
 *
 * Deterministic. No LLM. No vector embeddings — uses Jaccard on a
 * stop-word-stripped, 4-char-minimum token set. < 35 ms on a 1 MB
 * 2-file batch.
 *
 * Public API:
 *   buildSimilarityForFiles(files)        → SimilarityReport
 *   renderSimilarityBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MIN_SECTION_LEN = 80;
const MIN_SIMILARITY = 0.18;
const MAX_PAIRS_PER_FILE_PAIR = 4;
const MAX_TOTAL_PAIRS = 18;
const MAX_BLOCK_CHARS = 4000;
const STOPWORD_RE = /\b(the|a|an|and|or|of|in|on|to|for|by|with|from|as|is|are|was|were|be|el|la|los|las|de|del|y|o|en|por|para|que|con|desde|como|es|son|fue|fueron|ser)\b/gi;

const HEADING_RES = [
  /^#{1,6}\s+(.{3,90})$/gm,
  /^(\d+(?:\.\d+){0,3})\s+([^\n]{3,90})$/gm,
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s,.:;()/-]{4,70})$/gm,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = 80) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(STOPWORD_RE, ' ')
    .match(/[\p{L}\p{N}]{4,}/gu) || [];
}

function tokenSet(text) {
  const set = new Set();
  for (const tok of tokenize(text)) set.add(tok);
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(3));
}

function detectHeadings(text) {
  const taken = new Set();
  const out = [];
  for (const re of HEADING_RES) {
    const cloned = new RegExp(re.source, re.flags);
    for (const m of text.matchAll(cloned)) {
      const idx = m.index ?? 0;
      if (taken.has(idx)) continue;
      taken.add(idx);
      const title = (m[2] || m[1] || '').trim().replace(/\s+/g, ' ');
      out.push({ index: idx, title });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function splitIntoSections(text) {
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const headings = detectHeadings(head);
  if (headings.length === 0) {
    return head
      .split(/\n{2,}/)
      .map((b, i) => ({ title: `Block ${i + 1}`, body: b.trim() }))
      .filter((s) => s.body.length >= MIN_SECTION_LEN)
      .slice(0, 24);
  }
  const out = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : head.length;
    const body = head.slice(start, end).trim();
    if (body.length < MIN_SECTION_LEN) continue;
    out.push({ title: clip(headings[i].title), body });
  }
  return out.slice(0, 24);
}

function buildSimilarityForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length < 2) return { pairs: [], fileCount: list.length, totalPairs: 0 };

  // Pre-compute sections + token sets per file.
  const profiles = list.map((f) => {
    const text = safeText(f.extractedText);
    const sections = splitIntoSections(text);
    return {
      file: safeFileName(f),
      sections: sections.map((s) => ({
        title: s.title,
        body: s.body,
        tokens: tokenSet(s.body),
        chars: s.body.length,
      })),
    };
  });

  const pairs = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const A = profiles[i];
      const B = profiles[j];
      const localPairs = [];
      for (const sa of A.sections) {
        for (const sb of B.sections) {
          const score = jaccard(sa.tokens, sb.tokens);
          if (score < MIN_SIMILARITY) continue;
          localPairs.push({
            fileA: A.file,
            fileB: B.file,
            titleA: sa.title,
            titleB: sb.title,
            score,
          });
        }
      }
      // Keep the top-N pairs between this file-file combo.
      localPairs.sort((x, y) => y.score - x.score);
      for (const p of localPairs.slice(0, MAX_PAIRS_PER_FILE_PAIR)) pairs.push(p);
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  return {
    pairs: pairs.slice(0, MAX_TOTAL_PAIRS),
    fileCount: list.length,
    totalPairs: pairs.length,
  };
}

function renderSimilarityBlock(report) {
  if (!report || !Array.isArray(report.pairs) || report.pairs.length === 0) return '';
  const heading = `## CROSS-DOCUMENT SECTION SIMILARITY
Top section-to-section matches across the attached document(s) by Jaccard overlap of content tokens. When the user asks to compare a specific area ("compare the scope clauses", "where does each file discuss pricing?"), use these pairs to anchor the comparison — quote the section titles verbatim.`;
  const body = report.pairs.map((p) => `- **${p.titleA}** _(${p.fileA})_ ↔ **${p.titleB}** _(${p.fileB})_ — similarity ${(p.score * 100).toFixed(0)}%`).join('\n');
  let combined = `${heading}\n\n${body}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...similarity block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildSimilarityForFiles,
  renderSimilarityBlock,
  _internal: {
    tokenize,
    tokenSet,
    jaccard,
    detectHeadings,
    splitIntoSections,
    MIN_SIMILARITY,
    MAX_PAIRS_PER_FILE_PAIR,
    MAX_TOTAL_PAIRS,
  },
};
