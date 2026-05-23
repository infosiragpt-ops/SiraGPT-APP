'use strict';

/**
 * document-goals-targets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects explicit GOALS / TARGETS / OBJECTIVES the document states —
 * "our goal is X", "target Y", "objective Z", "objetivo W", "meta",
 * "KR1", "OKR objective". Routes "what are the objectives?" / "what
 * are the targets?" to citeable trigger sentences.
 *
 * Different from document-action-dashboard (action items / deadlines)
 * and recommendations (suggestions): these are ASPIRATIONAL targets
 * the author commits to.
 *
 * Bilingual. Deterministic. < 12 ms on 1 MB.
 *
 * Public API:
 *   extractGoals(text)                  → GoalsReport
 *   buildGoalsForFiles(files)           → { perFile, aggregate }
 *   renderGoalsBlock(report)            → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const GOAL_PATTERNS_EN = [
  /\b(our\s+goal\s+is|the\s+goal\s+is|goal\s*:|our\s+(?:objective|aim)\s+is|the\s+(?:objective|aim)\s+is|objective\s*:|target\s*:|target\s+of|aim\s+to|seek\s+to|aspire\s+to|OKR\s*\d|KR\s*\d|key\s+result\s*[:\d])\b/i,
];

const GOAL_PATTERNS_ES = [
  /(?:^|[^\p{L}])(nuestro\s+objetivo\s+es|nuestra\s+meta\s+es|el\s+objetivo\s+es|la\s+meta\s+es|objetivo\s*:|meta\s*:|target\s*:|buscamos|aspiramos\s+a|nuestra\s+aspiraci[oó]n\s+es|resultado\s+clave\s*[:\d])(?=[^\p{L}]|$)/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function isGoal(sentence) {
  for (const re of GOAL_PATTERNS_EN) if (re.test(sentence)) return true;
  for (const re of GOAL_PATTERNS_ES) if (re.test(sentence)) return true;
  return false;
}

function extractGoals(input) {
  const text = safeText(input);
  if (!text) return { goals: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const goals = [];
  const seen = new Set();
  for (const s of sentences) {
    if (goals.length >= MAX_PER_FILE) break;
    if (!isGoal(s)) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    goals.push({ sentence: clipped });
  }
  return { goals, total: goals.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildGoalsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractGoals(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, goals: r.goals });
    aggregate = aggregate.concat(r.goals.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**GOAL**]${file} ${item.sentence}`;
}

function renderGoalsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## GOALS & TARGETS
Explicit objectives / targets / OKRs / key results stated by the attached document(s). Different from action items (operational TODOs) and recommendations (suggestions): these are aspirational targets the author commits to. Routes "what are the objectives?" / "what are the targets?" to citeable trigger sentences.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const x of only.goals) sections.push(renderLine(x));
  } else {
    sections.push('### Aggregate goals across all files');
    for (const x of report.aggregate) sections.push(renderLine(x, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const x of p.goals) sections.push(renderLine(x));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...goals block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractGoals,
  buildGoalsForFiles,
  renderGoalsBlock,
  _internal: {
    splitSentences,
    isGoal,
    GOAL_PATTERNS_EN,
    GOAL_PATTERNS_ES,
  },
};
