'use strict';

/**
 * document-risk-matrix.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects risk severity matrix cells / scoring entries common to risk
 * registers, security threat models, business continuity plans:
 *
 *   - "Likelihood: High, Impact: Critical" pairs
 *   - "Probability: 4, Severity: 3" numeric pairs
 *   - Risk score lines "Risk Score: 12 (High)"
 *   - Spanish: Probabilidad / Impacto / Severidad
 *
 * Different from document-priority (P0/P1/Critical for tickets)
 * and document-risk-register (qualitative risk entries) by focusing
 * on the structured likelihood × impact matrix vocabulary used in
 * formal risk management. Routes "what's the risk score?",
 * "what's the likelihood/impact?" to a citeable structure.
 *
 * Public API:
 *   extractRiskMatrix(text)         → RiskMatrixReport
 *   buildRiskMatrixForFiles(files)  → { perFile, aggregate, totals }
 *   renderRiskMatrixBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 200;

// Vertical levels (English + Spanish)
const LEVEL_RE = '(?:very\\s+low|low|medium|moderate|high|very\\s+high|critical|severe|negligible|minor|major|catastrophic|muy\\s+baj[ao]|muy\\s+alt[ao]|baj[ao]|medi[ao]|alt[ao]|cr[íi]tic[ao]|sever[ao]|insignificante|menor|mayor|catastr[óo]fic[ao]|\\d+)';

const PAIR_RE = new RegExp(
  `\\b(Likelihood|Probability|Probabilidad)\\s*[:=]?\\s*(${LEVEL_RE})[\\s,.;]+(Impact|Severity|Severidad|Impacto)\\s*[:=]?\\s*(${LEVEL_RE})\\b`,
  'giu'
);
const REVERSE_PAIR_RE = new RegExp(
  `\\b(Impact|Severity|Severidad|Impacto)\\s*[:=]?\\s*(${LEVEL_RE})[\\s,.;]+(Likelihood|Probability|Probabilidad)\\s*[:=]?\\s*(${LEVEL_RE})\\b`,
  'giu'
);
const SCORE_RE = /\b(Risk\s+Score|Risk\s+Rating|Riesgo|Puntuaci[óo]n\s+de\s+Riesgo)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\(\s*([A-Za-zÀ-ÿ ]+?)\s*\))?/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 80);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function normaliseLevel(v) {
  if (!v) return null;
  const t = v.toLowerCase().trim();
  if (/^(critical|severe|catastr|cr[íi]tic)/u.test(t)) return 'critical';
  if (/^(very\s*high|major|muy\s*alt|cat[áa]strof)/u.test(t)) return 'high';
  if (/^(high|alt)/u.test(t)) return 'high';
  if (/^(medium|moderate|media|moderada)/u.test(t)) return 'medium';
  if (/^(low|baj[ao]|menor)/u.test(t)) return 'low';
  if (/^(very\s*low|negligible|insignificant|muy\s*baj)/u.test(t)) return 'very-low';
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 8) return 'critical';
    if (n >= 6) return 'high';
    if (n >= 4) return 'medium';
    if (n >= 2) return 'low';
    return 'very-low';
  }
  return null;
}

function extractRiskMatrix(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  function addPair(likelihood, impact, context) {
    if (entries.length >= MAX_PER_FILE) return;
    const lvL = normaliseLevel(likelihood);
    const lvI = normaliseLevel(impact);
    if (!lvL || !lvI) return;
    const key = `pair|${lvL}|${lvI}|${context.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind: 'pair', likelihood: lvL, impact: lvI, context });
  }

  for (const m of head.matchAll(PAIR_RE)) {
    addPair(m[2], m[4], clipContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(REVERSE_PAIR_RE)) {
    addPair(m[4], m[2], clipContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(SCORE_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const score = Number(m[2]);
    const rating = m[3] ? normaliseLevel(m[3]) : null;
    const ctx = clipContext(head, m.index, m[0].length);
    const key = `score|${score}|${rating || ''}|${ctx.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'score', score, rating, context: ctx });
  }

  return { entries, total: entries.length, totals: countTotals(entries), truncated: text.length > SCAN_HEAD_BYTES };
}

function emptyTotals() {
  return { pair: 0, score: 0 };
}

function countTotals(entries) {
  const t = emptyTotals();
  for (const e of entries) {
    if (e.kind === 'pair') t.pair += 1;
    else if (e.kind === 'score') t.score += 1;
  }
  return t;
}

function buildRiskMatrixForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractRiskMatrix(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  if (e.kind === 'pair') {
    return `- [pair]${file} likelihood=**${e.likelihood}**, impact=**${e.impact}** — ${e.context}`;
  }
  return `- [score]${file} score=**${e.score}**${e.rating ? ` (${e.rating})` : ''} — ${e.context}`;
}

function renderRiskMatrixBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## RISK MATRIX
Likelihood × Impact pairings and numeric risk scores detected in the document(s). Recognises English (Likelihood / Probability / Impact / Severity / Risk Score) and Spanish (Probabilidad / Impacto / Severidad / Puntuación de Riesgo) vocabulary. Levels normalised into very-low / low / medium / high / critical buckets. Routes "what's the risk score?" / "what's the likelihood/impact?" to a citeable structure. Different from priority/severity tags (ticket-level) by focusing on formal risk management matrix vocabulary.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate risk matrix across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...risk matrix block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractRiskMatrix,
  buildRiskMatrixForFiles,
  renderRiskMatrixBlock,
  _internal: {
    PAIR_RE,
    REVERSE_PAIR_RE,
    SCORE_RE,
    normaliseLevel,
  },
};
