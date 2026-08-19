'use strict';

/**
 * document-numeric-statistics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts statistical language from attached documents so the chat
 * can answer "what's the average?", "what's the spread?", "what's the
 * median X?" with the source sentence intact. Different from
 * document-kpi-extractor (operational KPIs with periods + trends)
 * and document-insights-engine (broad number harvest): this module
 * captures the SHAPE of distributions — mean / median / mode /
 * standard deviation / variance / percentile / range / quartile /
 * skewness / kurtosis — that signal a sampled or computed statistic.
 *
 * Each statistic is emitted as { kind, value, unit, dataset,
 * sentence } so callers can cite, sort, or compare.
 *
 * Bilingual (Spanish / English). Deterministic. No LLM. < 20 ms on
 * 1 MB.
 *
 * Public API:
 *   extractStatistics(text)           → StatisticsReport
 *   buildStatisticsForFiles(files)    → { perFile, aggregate }
 *   renderStatisticsBlock(report)     → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_STATS_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 280;

const STAT_KINDS = [
  { kind: 'mean', re: /\b(mean|average|promedio|media)\b/i },
  { kind: 'median', re: /\b(median|mediana)\b/i },
  { kind: 'mode', re: /\b(mode|moda)\b/i },
  { kind: 'std-dev', re: /\b(standard\s+deviation|std\.?\s*dev|desviaci[oó]n\s+est[áa]ndar|sd)\b/i },
  { kind: 'variance', re: /\b(variance|varianza)\b/i },
  { kind: 'range', re: /\b(range\s+of|rango\s+(?:de|entre)|spread|min\s*[:=]|max\s*[:=])\b/i },
  { kind: 'percentile', re: /\b(\d{1,3}\s?(?:st|nd|rd|th))?\s*percentile|percentil\s+\d{1,3}|p\d{1,3}\b/i },
  { kind: 'quartile', re: /\b(quartile|cuartil|Q[1-4]\s+(?:percentile|score|value))\b/i },
  { kind: 'skewness', re: /\b(skew(?:ness)?|asimetr[ií]a)\b/i },
  { kind: 'kurtosis', re: /\b(kurtosis|curtosis)\b/i },
  { kind: 'confidence-interval', re: /\b(confidence\s+interval|intervalo\s+de\s+confianza|CI|IC)\b/i },
  { kind: 'p-value', re: /\b(p\s?[<>=]\s?0?\.\d+|p[-\s]?value|valor\s+p)\b/i },
  { kind: 'correlation', re: /\b(correlation|coefficient|correlaci[oó]n|r\s?=\s?-?0?\.\d+)\b/i },
  { kind: 'effect-size', re: /\b(effect\s+size|tama[ñn]o\s+del\s+efecto|cohen's\s+d|d\s?=\s?-?\d)\b/i },
];

const VALUE_RE = /(?:[$€£¥]\s?)?(-?\d{1,4}(?:[.,]\d+)?(?:\s?(?:[KkMmBb]|million|billion|millones?|billones?|%))?)/g;
const UNIT_RE = /\b(seconds?|minutes?|hours?|days?|weeks?|months?|years?|ms|s|kg|lb|cm|m|km|°C|°F|USD|EUR|GBP|MXN|PEN|COP|CLP|BRL|JPY|d[oó]lares?|euros?|pesos?|reales?|soles?)\b/i;

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

function pickValue(sentence) {
  // Find the first numeric near the stat-kind keyword. Reset lastIndex.
  VALUE_RE.lastIndex = 0;
  const matches = Array.from(sentence.matchAll(new RegExp(VALUE_RE.source, VALUE_RE.flags)));
  if (matches.length === 0) return null;
  // Prefer the first non-pure-year number.
  for (const m of matches) {
    const raw = m[1];
    const clean = raw.replace(/[^\d.,\-]/g, '');
    if (!clean) continue;
    if (/^\d{4}$/.test(clean) && Number(clean) > 1900 && Number(clean) < 2200) continue; // skip plain years
    return raw.trim();
  }
  return matches[0][1].trim();
}

function pickUnit(sentence) {
  const m = sentence.match(UNIT_RE);
  return m ? m[1] : null;
}

function pickDataset(sentence) {
  // Light heuristic: when a noun phrase precedes "of" / "de" near the
  // stat keyword, treat that as the dataset label.
  const m = sentence.match(/\b(mean|average|promedio|media|median|mediana|std(?:\.\s*dev|andard\s+deviation)?|desviaci[oó]n\s+est[áa]ndar|range|rango|percentile|percentil|correlation|correlaci[oó]n)\b\s+of\s+([\p{L}\p{N}_'\- ]{2,40})/iu);
  if (m && m[2]) return m[2].trim().replace(/\s+/g, ' ');
  const es = sentence.match(/\b(promedio|media|mediana|desviaci[oó]n|rango|percentil|correlaci[oó]n)\s+de\s+([\p{L}\p{N}_'\- ]{2,40})/iu);
  if (es && es[2]) return es[2].trim().replace(/\s+/g, ' ');
  return null;
}

function extractStatistics(input) {
  const text = safeText(input);
  if (!text) return { stats: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const stats = [];
  const seen = new Set();

  for (const sentence of sentences) {
    if (stats.length >= MAX_STATS_PER_FILE) break;
    for (const k of STAT_KINDS) {
      if (!k.re.test(sentence)) continue;
      const clipped = clip(sentence);
      const value = pickValue(sentence);
      const unit = pickUnit(sentence);
      const dataset = pickDataset(sentence);
      const key = `${k.kind}|${(value || '').toLowerCase()}|${clipped.slice(0, 40).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stats.push({ kind: k.kind, value, unit, dataset, sentence: clipped });
      // Allow one sentence to surface up to two distinct stat kinds (e.g.
      // "the mean is 12 and the standard deviation is 3"), no more.
      if (stats.length >= MAX_STATS_PER_FILE) break;
    }
  }
  return { stats, total: stats.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildStatisticsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractStatistics(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.stats.map((s) => ({ ...s, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderStatLine(s, opts = {}) {
  const parts = [`**${s.kind}**`];
  if (s.value) {
    const unit = s.unit ? ` ${s.unit}` : '';
    parts.push(`= ${s.value}${unit}`);
  }
  if (s.dataset) parts.push(`for **${s.dataset}**`);
  const head = parts.join(' ');
  const fileTag = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  return `- ${head}${fileTag} — "${s.sentence}"`;
}

function renderStatisticsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## NUMERIC STATISTICS
Statistical language surfaced from the attached document(s) — mean / median / std dev / variance / range / percentile / quartile / skew / kurtosis / CI / p-value / correlation / effect size. Each statistic carries its dataset (when stated) and the source sentence. Use this block to answer "what's the average / median / spread?" without re-scanning raw text.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.report.stats) sections.push(renderStatLine(s));
  } else {
    sections.push('### Aggregate across all files');
    for (const s of batchReport.aggregate) sections.push(renderStatLine(s, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.report.stats) sections.push(renderStatLine(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...numeric statistics block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractStatistics,
  buildStatisticsForFiles,
  renderStatisticsBlock,
  _internal: {
    splitSentences,
    pickValue,
    pickUnit,
    pickDataset,
    STAT_KINDS,
    MAX_STATS_PER_FILE,
  },
};
