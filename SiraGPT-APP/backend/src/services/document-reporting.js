'use strict';

/**
 * document-reporting.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects reporting verbs that introduce claims, statements, or research:
 *
 *   - English: said, says, stated, claimed, argued, suggested, found,
 *     reported, noted, observed, concluded, indicated, demonstrated,
 *     showed, explained, announced, confirmed, denied, alleged
 *   - Spanish: dijo, afirmó, declaró, sostuvo, sugirió, encontró,
 *     reportó, notó, observó, concluyó, indicó, demostró, mostró,
 *     explicó, anunció, confirmó, negó
 *
 * Routes "who said what?" / "what's been claimed?" to a citeable list.
 * Different from document-attributions (full "according to X" phrases).
 *
 * Public API:
 *   extractReporting(text)         → ReportingReport
 *   buildReportingForFiles(files)  → { perFile, aggregate, totals }
 *   renderReportingBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 200;

const REPORTING_VERBS = [
  // English
  'said', 'says', 'stated', 'claimed', 'argued', 'suggested', 'found',
  'reported', 'noted', 'observed', 'concluded', 'indicated', 'demonstrated',
  'showed', 'explained', 'announced', 'confirmed', 'denied', 'alleged',
  'asserted', 'maintained', 'admitted', 'acknowledged',
  // Spanish (allow accented endings)
  'dijo', 'afirm[óo]', 'declar[óo]', 'sostuvo', 'sugiri[óo]',
  'encontr[óo]', 'report[óo]', 'not[óo]', 'observ[óo]', 'concluy[óo]',
  'indic[óo]', 'demostr[óo]', 'mostr[óo]', 'explic[óo]', 'anunci[óo]',
  'confirm[óo]', 'neg[óo]', 'asegur[óo]', 'sosten[íi]a', 'admiti[óo]',
];

const REPORTING_RE = new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])(${REPORTING_VERBS.join('|')})(?![A-Za-zÀ-ÿ0-9_])`, 'giu');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 120);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function extractReporting(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const m of head.matchAll(REPORTING_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const verb = m[1].toLowerCase();
    const ctx = clipContext(head, m.index, m[0].length);
    const key = `${verb}|${ctx.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ verb, context: ctx });
  }

  return { entries, total: entries.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildReportingForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractReporting(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- **${e.verb}**${file} — ${e.context}`;
}

function renderReportingBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## REPORTING VERBS
Reporting verbs that introduce claims, statements, or research findings: said, stated, claimed, argued, suggested, found, reported, noted, observed, concluded, demonstrated, etc. (English) and dijo, afirmó, declaró, sostuvo, sugirió, encontró, reportó, etc. (Spanish). Different from "according to X" full attributions. Routes "who said what?" / "what's been claimed?" to a citeable list.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate reporting verbs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...reporting block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractReporting,
  buildReportingForFiles,
  renderReportingBlock,
  _internal: {
    REPORTING_VERBS,
    REPORTING_RE,
  },
};
