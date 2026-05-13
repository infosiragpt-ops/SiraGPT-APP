'use strict';

/**
 * document-questions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects interrogative sentences (questions) in body text — distinct from
 * the QA-pairs extractor which expects formal Q/A structure.
 *
 *   - WH-questions: What is X? How does Y work? Why does Z fail?
 *   - Yes/no: Does it scale? Will it work?
 *   - Tag questions: ..., right? ..., isn't it?
 *   - Spanish: ¿Qué es X? ¿Cómo funciona Y? ¿Por qué Z?
 *
 * Routes "what questions does this raise?" / "what's still open?" to a
 * citeable list.
 *
 * Public API:
 *   extractQuestions(text)         → QuestionReport
 *   buildQuestionsForFiles(files)  → { perFile, aggregate, totals }
 *   renderQuestionsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;
const MAX_TEXT_LEN = 220;

// Sentences ending in ? — capture up to 200 chars before the ?
const QUESTION_RE = /(?:^|(?<=[.!?\n]))\s*([A-Z¿][^.!?\n]{4,200}\?)/g;
// Spanish ¿...?
const SPANISH_Q_RE = /¿([^¿?\n]{4,200})\?/g;

const WH_WORDS_EN = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'whose'];
const WH_WORDS_ES = ['qué', 'que', 'quién', 'quien', 'dónde', 'donde', 'cuándo', 'cuando', 'por qué', 'porque', 'cómo', 'como', 'cuál', 'cual'];

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

function classifyQuestion(text) {
  const t = text.toLowerCase().replace(/^¿/, '');
  // WH-question (English)
  for (const wh of WH_WORDS_EN) {
    if (t.startsWith(wh + ' ') || t.startsWith(wh + '\'')) return 'wh-en';
  }
  // WH-question (Spanish, with or without inverted ¿)
  for (const wh of WH_WORDS_ES) {
    if (t.startsWith(wh + ' ') || t.startsWith(wh + '?')) return 'wh-es';
  }
  // Yes/No (English starting with aux verb)
  if (/^(does|do|did|is|are|was|were|will|would|can|could|should|may|might|has|have|had)\b/.test(t)) return 'yes-no';
  // Tag question (ends with ", right?" / ", isn't it?")
  if (/,\s*(right|correct|isn'?t\s+it|don'?t\s+you|verdad|cierto|no)\?$/.test(t)) return 'tag';
  return 'other';
}

const KINDS = ['wh-en', 'wh-es', 'yes-no', 'tag', 'other'];

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractQuestions(input) {
  const text = safeText(input);
  if (!text) return { questions: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const questions = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(text, kind) {
    if (questions.length >= MAX_PER_FILE) return;
    const t = clipText(text);
    if (!t) return;
    const key = t.toLowerCase().slice(0, 100);
    if (seen.has(key)) return;
    seen.add(key);
    questions.push({ text: t, kind });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(QUESTION_RE)) {
    const sentence = m[1].trim();
    add(sentence, classifyQuestion(sentence));
  }
  for (const m of head.matchAll(SPANISH_Q_RE)) {
    const sentence = `¿${m[1].trim()}?`;
    add(sentence, 'wh-es');
  }

  return { questions, total: questions.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildQuestionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractQuestions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, questions: r.questions, totals: r.totals });
    aggregate = aggregate.concat(r.questions.map((q) => ({ ...q, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderQuestion(q, opts = {}) {
  const file = opts.includeFile && q.file ? ` _(${q.file})_` : '';
  return `- [${q.kind}]${file} ${q.text}`;
}

function renderQuestionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## QUESTIONS / INTERROGATIVES
Interrogative sentences detected in the document(s) classified by kind — wh-en (English WH: what/who/where/when/why/how/which/whose), wh-es (Spanish: qué/quién/dónde/cuándo/por qué/cómo/cuál), yes-no (does/do/is/are/will/can/...), tag (..., right? / ..., isn't it? / ..., verdad?), other. Spanish ¿...? brackets supported. Different from formal Q/A pairs by surfacing any inline questions. Routes "what questions does this raise?" / "what's still open?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const q of only.questions) sections.push(renderQuestion(q));
  } else {
    sections.push('### Aggregate questions across all files');
    for (const q of report.aggregate) sections.push(renderQuestion(q, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const q of p.questions) sections.push(renderQuestion(q));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...questions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractQuestions,
  buildQuestionsForFiles,
  renderQuestionsBlock,
  _internal: {
    QUESTION_RE,
    SPANISH_Q_RE,
    WH_WORDS_EN,
    WH_WORDS_ES,
    classifyQuestion,
  },
};
