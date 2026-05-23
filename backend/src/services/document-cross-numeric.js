'use strict';

/**
 * document-cross-numeric.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-file numeric comparator. For each concept-token that surfaces
 * with a value in 2+ files (e.g. "revenue", "margin", "headcount",
 * "uptime"), emits a side-by-side comparison so the chat can answer
 * "which file has the higher X?" or "how does revenue differ across
 * the proposals?" without re-extracting numbers from prose.
 *
 * Different from document-numeric-coherence (within-file math),
 * document-kpi-extractor (per-doc KPIs) and document-comparison-engine
 * (high-level cross-file synthesis): this module specialises in
 * SAME-CONCEPT vs DIFFERENT-VALUE comparisons across files.
 *
 * Detection (deterministic, bilingual, < 25 ms on 1 MB total):
 *
 *   - Builds a concept-tag dictionary from a curated set of business
 *     / SaaS / financial heads (revenue / margin / churn / uptime /
 *     headcount / NPS / OKR-related / ingresos / margen / etc.).
 *   - For each file, captures the FIRST numeric or % value within ~80
 *     chars of each head term.
 *   - Emits one row per concept that appears in ≥ 2 files with the
 *     per-file value, plus a delta (max - min) and a winner label.
 *
 * Public API:
 *   buildComparisonForFiles(files)         → ComparisonReport
 *   renderComparisonBlock(report)          → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_ROWS = 12;
const MAX_BLOCK_CHARS = 3800;

const CONCEPT_TAGS = [
  { tag: 'revenue',        re: /\b(revenue|ingresos?|sales|ventas)\b/i },
  { tag: 'gross margin',   re: /\b(gross\s+margin|margen\s+bruto)\b/i },
  { tag: 'operating margin', re: /\b(operating\s+margin|margen\s+operativo)\b/i },
  { tag: 'net margin',     re: /\b(net\s+margin|margen\s+neto)\b/i },
  { tag: 'EBITDA',         re: /\bEBITDA\b/i },
  { tag: 'churn',          re: /\b(churn(?:\s+rate)?|tasa\s+de\s+abandono|tasa\s+de\s+rotaci[oó]n)\b/i },
  { tag: 'NPS',            re: /\bNPS\b/i },
  { tag: 'CSAT',           re: /\bCSAT\b/i },
  { tag: 'ARR',            re: /\bARR\b/i },
  { tag: 'MRR',            re: /\bMRR\b/i },
  { tag: 'headcount',      re: /\b(headcount|plantilla|personal|empleados)\b/i },
  { tag: 'uptime',         re: /\b(uptime|disponibilidad)\b/i },
  { tag: 'latency p99',    re: /\b(p99|99(?:th)?\s+percentile)\b/i },
  { tag: 'conversion rate', re: /\b(conversion\s+rate|tasa\s+de\s+conversi[oó]n)\b/i },
  { tag: 'retention rate', re: /\b(retention\s+rate|tasa\s+de\s+retenci[oó]n)\b/i },
  { tag: 'gross profit',   re: /\b(gross\s+profit|utilidad\s+bruta)\b/i },
  { tag: 'net income',     re: /\b(net\s+income|utilidad\s+neta|beneficio\s+neto)\b/i },
  { tag: 'CAC',            re: /\bCAC\b/i },
  { tag: 'LTV',            re: /\bLTV\b/i },
];

const VALUE_RE = /([$€£¥]\s?)?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s?(%|millones?|billones?|million|billion|[KkMmBb])?/;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function parseNumeric(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^\d.,\-]/g, '');
  if (!cleaned) return null;
  let n = cleaned;
  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      n = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      n = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    const after = cleaned.split(',').pop();
    if (after.length === 3) n = cleaned.replace(/,/g, '');
    else n = cleaned.replace(',', '.');
  }
  const f = Number(n);
  return Number.isFinite(f) ? f : null;
}

function normaliseValue(raw, suffix) {
  const num = parseNumeric(raw);
  if (num == null) return null;
  if (!suffix) return num;
  const s = suffix.toLowerCase();
  if (s === '%') return num; // percent left as-is
  if (s === 'k') return num * 1_000;
  if (s === 'm' || s === 'million' || s === 'millones' || s === 'millon') return num * 1_000_000;
  if (s === 'b' || s === 'billion' || s === 'billones' || s === 'billon') return num * 1_000_000_000;
  return num;
}

function captureValueForConcept(text, conceptRe) {
  const conceptMatch = text.match(conceptRe);
  if (!conceptMatch) return null;
  const start = Math.max(0, (conceptMatch.index || 0) - 20);
  const end = Math.min(text.length, (conceptMatch.index || 0) + (conceptMatch[0]?.length || 0) + 80);
  const window = text.slice(start, end);
  const m = window.match(VALUE_RE);
  if (!m) return null;
  const symbol = (m[1] || '').trim();
  const rawAmount = (m[2] || '').trim();
  const suffix = (m[3] || '').trim();
  const value = normaliseValue(rawAmount, suffix);
  if (value == null) return null;
  return {
    rawText: `${symbol}${rawAmount}${suffix ? ' ' + suffix : ''}`.trim(),
    value,
    suffix: suffix || null,
  };
}

function buildComparisonForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length < 2) return { rows: [], fileCount: list.length };
  const perFileValues = new Map(); // tag → array of { file, ...captured }
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
    const name = safeFileName(f);
    for (const concept of CONCEPT_TAGS) {
      const captured = captureValueForConcept(head, concept.re);
      if (!captured) continue;
      const arr = perFileValues.get(concept.tag) || [];
      arr.push({ file: name, ...captured });
      perFileValues.set(concept.tag, arr);
    }
  }
  const rows = [];
  for (const [tag, values] of perFileValues.entries()) {
    if (values.length < 2) continue;
    // Sort by numeric value descending so the leader is first.
    values.sort((a, b) => b.value - a.value);
    const max = values[0].value;
    const min = values[values.length - 1].value;
    const delta = Number((max - min).toFixed(4));
    rows.push({
      tag,
      values,
      max,
      min,
      delta,
      winner: values[0].file,
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { rows: rows.slice(0, MAX_ROWS), fileCount: list.length };
}

function renderRow(r) {
  const valueText = r.values.map((v) => `${v.file}: ${v.rawText}`).join(' | ');
  return `- **${r.tag}** → leader: **${r.winner}**, range: ${r.min} → ${r.max}, delta: ${r.delta} _(${valueText})_`;
}

function renderComparisonBlock(report) {
  if (!report || !Array.isArray(report.rows) || report.rows.length === 0) return '';
  const heading = `## CROSS-FILE NUMERIC COMPARISON
Side-by-side comparison of the same concept-tags (revenue / margin / churn / NPS / headcount / uptime / etc.) across the attached files. Use this block to answer "which file has the higher X?" or "how does Y differ across the documents?" — quote the per-file value verbatim from the source before claiming the gap is firm.`;
  const body = report.rows.map(renderRow).join('\n');
  let combined = `${heading}\n\n${body}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...comparison block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildComparisonForFiles,
  renderComparisonBlock,
  _internal: {
    parseNumeric,
    normaliseValue,
    captureValueForConcept,
    CONCEPT_TAGS,
    VALUE_RE,
    MAX_ROWS,
  },
};
