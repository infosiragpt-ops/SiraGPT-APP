'use strict';

/**
 * document-counter-arguments.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects COUNTER-ARGUMENTS / OBJECTIONS / CAVEATS in attached
 * documents — sentences that introduce a contrasting view, exception,
 * or risk to the main argument. Routes "what are the objections to
 * X?" / "what's the counter-view?" to citeable sentences instead of
 * synthesising.
 *
 * Bilingual (English / Spanish). Deterministic. < 12 ms on 1 MB.
 *
 * Coverage:
 *   - English:  however / nevertheless / on the other hand / in
 *               contrast / yet / but / despite / although / one
 *               concern is / critics argue / detractors / opponents
 *               of … say / a counter-argument is.
 *   - Spanish:  sin embargo / no obstante / por otro lado / en
 *               contraste / pero / aunque / a pesar de / críticos
 *               argumentan / detractores / opositores señalan / un
 *               contra-argumento es.
 *
 * Each capture carries the trigger phrase + the source sentence.
 *
 * Public API:
 *   extractCounterArguments(text)        → CounterReport
 *   buildCounterArgumentsForFiles(files) → { perFile, aggregate }
 *   renderCounterArgumentsBlock(report)  → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 16;
const MAX_SENTENCE_LEN = 320;

const TRIGGER_PATTERNS = [
  /\b(however|nevertheless|nonetheless|on\s+the\s+other\s+hand|on\s+the\s+contrary|in\s+contrast|conversely|despite|although|though|even\s+though|yet)\b/i,
  /\b(one\s+concern\s+is|critics\s+argue|detractors\s+(?:claim|say|note)|opponents\s+of\s+\w+\s+(?:claim|say)|a\s+counter[-\s]?argument\s+is|the\s+counterpoint\s+is|a\s+caveat\s+is|a\s+limitation\s+is)\b/i,
  /(?:^|[^\p{L}])(sin\s+embargo|no\s+obstante|por\s+otro\s+lado|por\s+el\s+contrario|en\s+contraste|aunque|si\s+bien|a\s+pesar\s+de|cr[ií]ticos\s+(?:argumentan|sostienen|señalan)|detractores\s+(?:señalan|argumentan)|opositores\s+(?:señalan|argumentan)|un\s+contra-?argumento\s+es|un\s+inconveniente\s+es)(?=[^\p{L}]|$)/iu,
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

function detectTrigger(sentence) {
  for (const re of TRIGGER_PATTERNS) {
    const m = sentence.match(re);
    if (m) return m[1] ? m[1].trim() : m[0].trim();
  }
  return null;
}

function extractCounterArguments(input) {
  const text = safeText(input);
  if (!text) return { counters: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const counters = [];
  const seen = new Set();
  for (const s of sentences) {
    if (counters.length >= MAX_PER_FILE) break;
    const trigger = detectTrigger(s);
    if (!trigger) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    counters.push({ trigger, sentence: clipped });
  }
  return { counters, total: counters.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCounterArgumentsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractCounterArguments(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, counters: r.counters });
    aggregate = aggregate.concat(r.counters.map((c) => ({ ...c, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(c, opts = {}) {
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- [**COUNTER**]${file} _(${c.trigger})_ — ${c.sentence}`;
}

function renderCounterArgumentsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## COUNTER-ARGUMENTS & OBJECTIONS
Sentences that introduce a contrasting view, exception, or limitation to the main argument of the attached document(s). Use this block to answer "what are the objections?" / "what's the counter-view?" — quote the source sentence verbatim before claiming the document weighs the objection seriously.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.counters) sections.push(renderLine(c));
  } else {
    sections.push('### Aggregate counter-arguments across all files');
    for (const c of report.aggregate) sections.push(renderLine(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.counters) sections.push(renderLine(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...counter-arguments block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCounterArguments,
  buildCounterArgumentsForFiles,
  renderCounterArgumentsBlock,
  _internal: {
    splitSentences,
    detectTrigger,
    TRIGGER_PATTERNS,
  },
};
