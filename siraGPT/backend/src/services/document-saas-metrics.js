'use strict';

/**
 * document-saas-metrics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SaaS / business-metric terms in board decks, ARR reports, growth
 * dashboards:
 *
 *   - revenue: ARR / MRR / GMV / TPV / CARR
 *   - unit econ: CAC / LTV / LTV:CAC ratio / payback period
 *   - retention: churn rate / GRR / NRR / NDR / DRR
 *   - engagement: DAU / MAU / WAU / D7 retention / N-day retention
 *   - funnel: conversion rate / activation / signup-to-paid
 *   - sentiment: NPS / CSAT / CES
 *
 * Public API:
 *   extractSaasMetrics(text)             → { entries, totals, total }
 *   buildSaasMetricsForFiles(files)      → { perFile, aggregate, totals }
 *   renderSaasMetricsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const METRIC_TERMS = {
  ARR: 'revenue', MRR: 'revenue', GMV: 'revenue', TPV: 'revenue', CARR: 'revenue',
  CAC: 'unit-econ', LTV: 'unit-econ', payback: 'unit-econ',
  churn: 'retention', GRR: 'retention', NRR: 'retention', NDR: 'retention', DRR: 'retention',
  DAU: 'engagement', MAU: 'engagement', WAU: 'engagement',
  NPS: 'sentiment', CSAT: 'sentiment', CES: 'sentiment',
  conversion: 'funnel', activation: 'funnel',
};

const TERM_ALT = Object.keys(METRIC_TERMS).join('|');
const METRIC_RE = new RegExp(`\\b(${TERM_ALT})\\b`, 'g');
const VALUE_RE = new RegExp(`\\b(${TERM_ALT})\\s*(?:[:=]|of|is|was|reached|grew\\s+to)\\s*\\$?(\\d+(?:\\.\\d+)?[KMB]?)\\s*%?`, 'gi');
const RATIO_RE = /\b(LTV)\s*[:/]\s*(CAC)\b/gi;
const RETENTION_RE = /\b(D|W|M|N)(\d{1,3})\s+(?:retention|cohort)\b/gi;

function extractSaasMetrics(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { revenue: 0, 'unit-econ': 0, retention: 0, engagement: 0, sentiment: 0, funnel: 0 };

  function push(metric, value, source, category) {
    const key = `${metric}:${value || ''}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ metric, value, source, category });
    if (totals[category] != null) totals[category] += 1;
  }

  // With value
  VALUE_RE.lastIndex = 0;
  let m;
  while ((m = VALUE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const metric = m[1].toUpperCase();
    const cat = METRIC_TERMS[metric] || METRIC_TERMS[m[1].toLowerCase()];
    if (!cat) continue;
    push(metric, m[2], 'with-value', cat);
  }

  // Bare mentions
  if (entries.length < MAX_PER_FILE) {
    METRIC_RE.lastIndex = 0;
    while ((m = METRIC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const term = m[1];
      const cat = METRIC_TERMS[term] || METRIC_TERMS[term.toLowerCase()];
      if (!cat) continue;
      push(term, null, 'mention', cat);
    }
  }

  // LTV:CAC ratio
  if (entries.length < MAX_PER_FILE) {
    RATIO_RE.lastIndex = 0;
    while ((m = RATIO_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('LTV:CAC', null, 'ratio', 'unit-econ');
    }
  }

  // N-day retention
  if (entries.length < MAX_PER_FILE) {
    RETENTION_RE.lastIndex = 0;
    while ((m = RETENTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const period = `${m[1].toUpperCase()}${m[2]}`;
      push(`${period}-retention`, null, 'n-day', 'retention');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSaasMetricsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { revenue: 0, 'unit-econ': 0, retention: 0, engagement: 0, sentiment: 0, funnel: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSaasMetrics(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.metric}:${e.value || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.category] != null) totals[e.category] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderSaasMetricsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SAAS / BUSINESS METRICS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const v = e.value ? ` = ${e.value}` : '';
      lines.push(`- [${e.category}] ${e.metric}${v}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSaasMetrics,
  buildSaasMetricsForFiles,
  renderSaasMetricsBlock,
  _internal: { METRIC_TERMS },
};
