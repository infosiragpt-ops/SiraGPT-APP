'use strict';

/**
 * document-quality-grade.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Letter-grade quality scorecard for each attached document. Combines
 * the signals other analyzers already produce (or computes them
 * directly when those analyzers are missing) into a compact A / B / C
 * / D / F grade with explanations. Useful when the chat wants to lead
 * with "this document is high-quality / partially-supported" before
 * diving into analysis.
 *
 * Dimensions scored (each 0..1, weights sum to 1.0):
 *   - structure     0.15  outline depth, heading variety, list / table use
 *   - density       0.20  verifiable-anchor density (facts/KB)
 *   - citations     0.15  citation markers per 1000 chars
 *   - clarity       0.15  average sentence length closeness to 18 words
 *   - completeness  0.15  presence of abstract / intro / conclusion-like
 *                        anchors (or contract clauses, depending on type)
 *   - freshness     0.10  most-recent year mentioned within 5 years of now
 *   - traceability  0.10  evidence-anchor / quote / table / footnote count
 *
 * Mapped to letters:
 *   A   ≥ 0.85
 *   B   ≥ 0.70
 *   C   ≥ 0.55
 *   D   ≥ 0.40
 *   F   < 0.40
 *
 * Deterministic, no LLM, < 25 ms on 1 MB.
 *
 * Public API:
 *   gradeDocument(text, opts)         → DocumentGrade
 *   buildGradesForFiles(files, opts)  → { perFile, aggregate }
 *   renderGradeBlock(batchReport)     → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_BLOCK_CHARS = 3200;
const DEFAULT_NOW_YEAR = new Date().getUTCFullYear();

const WEIGHTS = {
  structure: 0.15,
  density: 0.20,
  citations: 0.15,
  clarity: 0.15,
  completeness: 0.15,
  freshness: 0.10,
  traceability: 0.10,
};

function safeText(v) { return typeof v === 'string' ? v : ''; }
function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clamp(n, lo = 0, hi = 1) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function countMatches(text, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let total = 0;
  for (const _ of text.matchAll(global)) total++;
  return total;
}

function structureScore(text) {
  const headingMatches = countMatches(text, /^(?:#{1,6}\s+|\d+(?:\.\d+){0,3}\s+)/gm);
  const bullets = countMatches(text, /^\s*[-*•]\s+/gm);
  const numbered = countMatches(text, /^\s*\d+\.\s+/gm);
  const tables = countMatches(text, /\|\s*[-:|]/g);
  const lengthKb = Math.max(1, text.length / 1024);
  // Want at least 2-3 of each per KB to feel "well-structured".
  const score = (headingMatches / lengthKb / 6) + (bullets / lengthKb / 10) + (numbered / lengthKb / 10) + (tables / lengthKb / 5);
  return clamp(score);
}

function densityScore(text) {
  const numbers = countMatches(text, /(?<![\w.])\d{1,3}(?:[.,]\d+)?(?![\w])/g);
  const percents = countMatches(text, /\d{1,3}(?:[.,]\d+)?\s?%/g);
  const dates = countMatches(text, /\b\d{4}-\d{2}-\d{2}\b/g);
  const entities = countMatches(text, /\b[A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]+){0,3}\b/gu);
  const acronyms = countMatches(text, /\b[A-Z]{2,}[A-Z0-9]{0,6}\b/g);
  const facts = numbers + percents + dates + entities + acronyms;
  const lengthKb = Math.max(1, text.length / 1024);
  return clamp((facts / lengthKb) / 30);
}

function citationsScore(text) {
  const citations = countMatches(text, /\([A-ZÁÉÍÓÚÑ][^)]{0,40}(?:19|20)\d{2}[a-z]?\)/g);
  const bracketed = countMatches(text, /\[\d{1,3}\]/g);
  const footnotes = countMatches(text, /\[\^[A-Za-z0-9]+\]/g);
  const totalCites = citations + bracketed + footnotes;
  const length1k = Math.max(1, text.length / 1000);
  return clamp((totalCites / length1k) / 1.5);
}

function clarityScore(text) {
  const sentences = text.split(/[.!?。！？]\s+/).filter((s) => s.trim().length > 6).slice(0, 200);
  if (sentences.length === 0) return 0.5;
  const lens = sentences.map((s) => (s.match(/\S+/g) || []).length);
  const avg = lens.reduce((acc, n) => acc + n, 0) / lens.length;
  // Optimum at 18 words/sentence — penalise either extreme.
  const distance = Math.abs(avg - 18);
  return clamp(1 - distance / 30);
}

function completenessScore(text) {
  const anchors = [
    /\b(abstract|resumen)\b/i,
    /\b(introduction|introducci[oó]n|antecedentes|background)\b/i,
    /\b(method(?:ology|s)?|metodolog[ií]a|m[ée]todo)\b/i,
    /\b(result(?:s)?|resultados)\b/i,
    /\b(conclusion(?:s|es)?|conclusi[oó]n(?:es)?)\b/i,
    /\b(references?|referencias?|bibliograf[ií]a)\b/i,
    /\b(clause|cl[áa]usula|article|art[íi]culo|secci[oó]n\s+\d|section\s+\d)\b/i,
  ];
  let hits = 0;
  for (const re of anchors) if (re.test(text)) hits++;
  return clamp(hits / 5);
}

function freshnessScore(text, opts = {}) {
  const nowYear = Number(opts.nowYear) || DEFAULT_NOW_YEAR;
  const years = [];
  for (const m of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    const y = Number(m[0]);
    if (y >= 1900 && y <= nowYear + 1) years.push(y);
    if (years.length >= 200) break;
  }
  if (years.length === 0) return 0.5;
  const newest = Math.max(...years);
  const gap = Math.max(0, nowYear - newest);
  return clamp(1 - gap / 10);
}

function traceabilityScore(text) {
  const quotes = countMatches(text, /"[^"\n]{6,200}"|[“][^”\n]{6,200}[”]/g);
  const tables = countMatches(text, /\|\s*[-:|]/g);
  const evidenceAnchors = countMatches(text, /\b(p\.\s?\d+|page\s+\d+|p[áa]gina\s+\d+|figure\s+\d+|figura\s+\d+|table\s+\d+|tabla\s+\d+|annex|anexo)\b/i);
  const footnotes = countMatches(text, /\[\^[A-Za-z0-9]+\]/g);
  const total = quotes + tables + evidenceAnchors + footnotes;
  return clamp(total / 18);
}

function combine(dimensions) {
  let score = 0;
  for (const [k, v] of Object.entries(dimensions)) score += v * (WEIGHTS[k] || 0);
  return Number(score.toFixed(3));
}

function letterFor(score) {
  if (score >= 0.85) return 'A';
  if (score >= 0.70) return 'B';
  if (score >= 0.55) return 'C';
  if (score >= 0.40) return 'D';
  return 'F';
}

function gradeDocument(input, opts = {}) {
  const text = safeText(input);
  if (!text) {
    return {
      letter: 'F',
      score: 0,
      dimensions: { structure: 0, density: 0, citations: 0, clarity: 0, completeness: 0, freshness: 0, traceability: 0 },
      truncated: false,
    };
  }
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const dimensions = {
    structure:    Number(structureScore(head).toFixed(3)),
    density:      Number(densityScore(head).toFixed(3)),
    citations:    Number(citationsScore(head).toFixed(3)),
    clarity:      Number(clarityScore(head).toFixed(3)),
    completeness: Number(completenessScore(head).toFixed(3)),
    freshness:    Number(freshnessScore(head, opts).toFixed(3)),
    traceability: Number(traceabilityScore(head).toFixed(3)),
  };
  const score = combine(dimensions);
  return {
    letter: letterFor(score),
    score,
    dimensions,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildGradesForFiles(files, opts = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let totalScore = 0;
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const g = gradeDocument(text, opts);
    perFile.push({ file: safeFileName(f), grade: g });
    totalScore += g.score;
  }
  const aggregate = perFile.length === 0 ? null : {
    averageScore: Number((totalScore / perFile.length).toFixed(3)),
    averageLetter: letterFor(totalScore / perFile.length),
    fileCount: perFile.length,
  };
  return { perFile, aggregate };
}

function renderDimensionsLine(d) {
  return [
    `structure=${d.structure}`,
    `density=${d.density}`,
    `citations=${d.citations}`,
    `clarity=${d.clarity}`,
    `completeness=${d.completeness}`,
    `freshness=${d.freshness}`,
    `traceability=${d.traceability}`,
  ].join(' · ');
}

function renderGradeBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## DOCUMENT QUALITY GRADE
Letter grade per attached document (A → F) over seven weighted dimensions: structure, density, citations, clarity, completeness, freshness, traceability. Lead with this when explaining how much weight a claim from each document deserves; a higher grade does NOT mean the content is correct, only that it is well-structured, sourced and current.`;
  const lines = [];
  for (const entry of batchReport.perFile) {
    const g = entry.grade;
    lines.push(`- **${entry.file}** — **${g.letter}** (score ${g.score})`);
    lines.push(`  - ${renderDimensionsLine(g.dimensions)}`);
  }
  if (batchReport.aggregate) {
    lines.push(`\n_Aggregate across ${batchReport.aggregate.fileCount} file(s): **${batchReport.aggregate.averageLetter}** (score ${batchReport.aggregate.averageScore})_`);
  }
  let combined = `${heading}\n\n${lines.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...quality grade block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  gradeDocument,
  buildGradesForFiles,
  renderGradeBlock,
  _internal: {
    structureScore,
    densityScore,
    citationsScore,
    clarityScore,
    completenessScore,
    freshnessScore,
    traceabilityScore,
    letterFor,
    WEIGHTS,
    DEFAULT_NOW_YEAR,
  },
};
