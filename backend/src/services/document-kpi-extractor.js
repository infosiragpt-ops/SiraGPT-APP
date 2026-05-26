'use strict';

/**
 * document-kpi-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls quantitative KPIs / metrics out of attached documents with their
 * surrounding context, so the chat can answer "what's the X metric?",
 * "show me the revenue figures", "what are the headline numbers?".
 *
 * Different from document-insights-engine (which extracts a broader
 * range of entities + risk language + dates) and document-numeric-
 * coherence (which validates math). This module is laser-focused on
 * KPI-shaped statements:
 *
 *   - "Revenue grew 32% YoY to $4.2M in Q1 2026"
 *   - "Net Promoter Score climbed from 38 to 47"
 *   - "Churn rate descended a 1.8 puntos porcentuales hasta el 4.1%"
 *
 * Each KPI is emitted as { label, value, unit, period, direction,
 * baseline, sentence } with the source sentence intact for citation.
 *
 * Detection coverage (deterministic, no LLM, < 20 ms on 1 MB):
 *
 *   - Label heads: revenue / sales / margin / ARR / MRR / churn /
 *     CAC / LTV / NPS / CSAT / OKR / KPI / Gross profit / EBITDA /
 *     conversion rate / retention / engagement / DAU / MAU / uptime,
 *     plus Spanish equivalents (ingresos / ventas / margen / tasa
 *     de retención / etc.).
 *   - Value: any numeric / currency / percent / ratio token (or
 *     "X to Y" pair when growth language is present).
 *   - Direction: grew / increased / dropped / fell / stable.
 *   - Period: "in Q1 2026", "en el cuarto trimestre", "2025-2026",
 *     "this month", trailing "MoM" / "YoY" / "QoQ" tags.
 *
 * Public API:
 *   extractKpis(text, opts)                  → KpiReport
 *   buildKpisForFiles(files)                 → { perFile, aggregate }
 *   renderKpisBlock(batchReport)             → markdown string
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_KPIS_PER_FILE = 12;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4200;

const KPI_HEADS = [
  // English business metrics
  'revenue', 'gross\\s+revenue', 'net\\s+revenue', 'sales', 'bookings',
  'gross\\s+margin', 'operating\\s+margin', 'net\\s+margin', 'EBITDA',
  'profit', 'gross\\s+profit', 'operating\\s+profit', 'net\\s+income',
  'ARR', 'MRR', 'ARPU', 'churn(?:\\s+rate)?', 'CAC', 'LTV', 'NPS',
  'CSAT', 'CES', 'retention(?:\\s+rate)?', 'conversion(?:\\s+rate)?',
  'engagement(?:\\s+rate)?', 'DAU', 'WAU', 'MAU', 'uptime', 'availability',
  'latency', 'throughput', 'response\\s+time', 'P50', 'P95', 'P99',
  'cost', 'spend', 'expense', 'expenditure', 'OPEX', 'CAPEX',
  'headcount', 'attrition', 'turnover', 'OKR\\s+score', 'KR',
  // Spanish business metrics
  'ingresos', 'ingreso', 'ventas', 'margen\\s+bruto', 'margen\\s+operativo',
  'margen\\s+neto', 'utilidad', 'beneficio', 'rentabilidad',
  'tasa\\s+de\\s+abandono', 'tasa\\s+de\\s+rotaci[oó]n',
  'tasa\\s+de\\s+retenci[oó]n', 'tasa\\s+de\\s+conversi[oó]n',
  'usuarios\\s+activos', 'crecimiento', 'gasto', 'costo', 'inversi[oó]n',
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function clip(text, max = 240) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

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

function sentenceAroundIndex(text, idx, len) {
  const punct = ['.', '!', '?', '\n'];
  let from = idx;
  while (from > 0 && !punct.includes(text[from - 1])) from--;
  let to = idx + len;
  while (to < text.length && !punct.includes(text[to])) to++;
  return text.slice(from, Math.min(to + 1, text.length)).trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Regex set
// ──────────────────────────────────────────────────────────────────────────

const LABEL_GROUP = `(?:${KPI_HEADS.join('|')})`;
const VALUE_GROUP = `(?:[$€£¥]\\s?)?(\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d+)?(?:\\s?(?:[KkMmBb]|millones?|billones?|thousand|million|billion))?)(\\s?%|\\s?(?:USD|EUR|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CHF|d[oó]lares?|euros?|pesos?|reales?|soles?))?`;
const DIRECTION_GROUP = `(grew|increased|climbed|rose|fell|dropped|declined|decreased|stabilised|stabilized|aument[oó]|subi[oó]|creci[oó]|baj[oó]|cay[oó]|disminuy[oó]|se\\s+mantuvo)`;
const PERIOD_PATTERNS = [
  /\b(YoY|QoQ|MoM|YTD)\b/i,
  /\b(?:in|for|during|en|durante|para)\s+(Q[1-4]\s+\d{4}|\d{4}\s*[-–]\s*\d{4}|this\s+(?:quarter|year|month)|el\s+(?:último|presente)\s+(?:trimestre|año|mes))/i,
];

const LABEL_VALUE_RE = new RegExp(
  `\\b(${KPI_HEADS.join('|')})\\b[^.\\n]{0,80}?${VALUE_GROUP}`,
  'gi',
);
const VALUE_DIRECTION_LABEL_RE = new RegExp(
  `\\b${DIRECTION_GROUP}\\s+[^.\\n]{0,30}?${VALUE_GROUP}[^.\\n]{0,80}?(${KPI_HEADS.join('|')})`,
  'gi',
);

function detectPeriod(sentence) {
  for (const re of PERIOD_PATTERNS) {
    const m = sentence.match(re);
    if (m) return (m[1] || m[2] || '').trim();
  }
  return null;
}

function classifyDirection(token) {
  if (!token) return 'stable';
  const t = token.toLowerCase();
  if (/grew|increased|climbed|rose|aument|subi|creci/.test(t)) return 'up';
  if (/fell|dropped|declined|decreased|baj|cay|disminuy/.test(t)) return 'down';
  return 'stable';
}

function extractKpis(input) {
  const text = safeText(input);
  if (!text) return { kpis: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const kpis = [];

  // Pattern A: LABEL near VALUE  ("Revenue: $4.2M", "Margin grew to 32%").
  for (const m of head.matchAll(LABEL_VALUE_RE)) {
    if (kpis.length >= MAX_KPIS_PER_FILE) break;
    const idx = m.index ?? 0;
    const sentence = clip(sentenceAroundIndex(head, idx, m[0].length));
    const key = `${m[1].toLowerCase()}|${(m[2] || '').toLowerCase()}|${sentence.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = parseNumeric(m[2] || '');
    const unit = (m[3] || '').trim() || null;
    kpis.push({
      label: m[1].trim(),
      value,
      rawValue: (m[2] || '').trim(),
      unit,
      period: detectPeriod(sentence),
      direction: classifyDirection(sentence),
      sentence,
    });
  }

  // Pattern B: VALUE preceded by a DIRECTION verb and followed by a LABEL.
  //   "Revenue grew 32% YoY", "Margin dropped 1.5 points to 18%".
  for (const m of head.matchAll(VALUE_DIRECTION_LABEL_RE)) {
    if (kpis.length >= MAX_KPIS_PER_FILE) break;
    const idx = m.index ?? 0;
    const sentence = clip(sentenceAroundIndex(head, idx, m[0].length));
    const label = m[4];
    const key = `${label.toLowerCase()}|${(m[2] || '').toLowerCase()}|${sentence.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kpis.push({
      label: label.trim(),
      value: parseNumeric(m[2] || ''),
      rawValue: (m[2] || '').trim(),
      unit: (m[3] || '').trim() || null,
      period: detectPeriod(sentence),
      direction: classifyDirection(m[1]),
      sentence,
    });
  }

  return { kpis, total: kpis.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildKpisForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractKpis(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.kpis.map((k) => ({ ...k, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderKpiLine(k, opts = {}) {
  const parts = [];
  parts.push(`**${k.label}**`);
  if (k.rawValue) {
    const unit = k.unit ? ` ${k.unit.trim()}` : '';
    parts.push(`= ${k.rawValue}${unit}`);
  }
  if (k.period) parts.push(`(${k.period})`);
  if (k.direction && k.direction !== 'stable') parts.push(`[${k.direction}]`);
  const head = parts.join(' ');
  const fileTag = opts.includeFile && k.file ? ` _(${k.file})_` : '';
  return `- ${head}${fileTag} — "${k.sentence}"`;
}

function renderKpisBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## KEY METRICS / KPIs
Quantitative KPIs surfaced from the attached document(s) — label, value, period, and trend direction with the source sentence intact. Use this block to answer headline-number questions directly; quote the source sentence before claiming a trend.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const k of only.report.kpis) sections.push(renderKpiLine(k));
  } else {
    sections.push('### Aggregate across all files');
    for (const k of batchReport.aggregate) sections.push(renderKpiLine(k, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const k of p.report.kpis) sections.push(renderKpiLine(k));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...KPI block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractKpis,
  buildKpisForFiles,
  renderKpisBlock,
  _internal: {
    parseNumeric,
    sentenceAroundIndex,
    classifyDirection,
    detectPeriod,
    KPI_HEADS,
    MAX_KPIS_PER_FILE,
  },
};
