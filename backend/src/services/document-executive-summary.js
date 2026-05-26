'use strict';

/**
 * document-executive-summary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Composes a single EXECUTIVE-SUMMARY block per attached document by
 * orchestrating outputs from existing deterministic analyzers:
 *
 *   - title          (document-title-extractor)
 *   - TL;DR bullet   (document-tldr → first bullet)
 *   - top KPI        (document-kpi-extractor → first kpi)
 *   - top risk       (document-risk-register → highest severity)
 *   - top obligation (document-obligations-extractor → first)
 *   - quality grade  (document-quality-grade → letter)
 *
 * The block fits in a single screenful and gives the chat a stable
 * "open with this" answer for "give me an executive summary".
 *
 * Deterministic, no LLM. < 30 ms on 1 MB (the underlying analyzers
 * already cap their own work).
 *
 * Public API:
 *   buildExecutiveSummaryForFiles(files)  → SummaryReport
 *   renderExecutiveSummaryBlock(report)   → markdown string ('' OK)
 */

const MAX_BLOCK_CHARS = 4200;

let titleExtractorCache = null;
function getTitleExtractor() {
  if (titleExtractorCache) return titleExtractorCache;
  try { titleExtractorCache = require('./document-title-extractor'); } catch { titleExtractorCache = null; }
  return titleExtractorCache;
}
let tldrCache = null;
function getTldr() {
  if (tldrCache) return tldrCache;
  try { tldrCache = require('./document-tldr'); } catch { tldrCache = null; }
  return tldrCache;
}
let kpiCache = null;
function getKpi() {
  if (kpiCache) return kpiCache;
  try { kpiCache = require('./document-kpi-extractor'); } catch { kpiCache = null; }
  return kpiCache;
}
let riskRegisterCache = null;
function getRiskRegister() {
  if (riskRegisterCache) return riskRegisterCache;
  try { riskRegisterCache = require('./document-risk-register'); } catch { riskRegisterCache = null; }
  return riskRegisterCache;
}
let obligationsCache = null;
function getObligations() {
  if (obligationsCache) return obligationsCache;
  try { obligationsCache = require('./document-obligations-extractor'); } catch { obligationsCache = null; }
  return obligationsCache;
}
let qualityCache = null;
function getQualityGrade() {
  if (qualityCache) return qualityCache;
  try { qualityCache = require('./document-quality-grade'); } catch { qualityCache = null; }
  return qualityCache;
}

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function pickTitle(file) {
  const engine = getTitleExtractor();
  if (!engine || typeof engine.extractTitle !== 'function') return null;
  try {
    return engine.extractTitle(safeText(file.extractedText), safeFileName(file));
  } catch { return null; }
}

function pickTldr(text) {
  const engine = getTldr();
  if (!engine || typeof engine.buildTldrForFile !== 'function') return null;
  try {
    const r = engine.buildTldrForFile(text);
    if (r.bullets && r.bullets.length > 0) return r.bullets[0];
  } catch { /* swallow */ }
  return null;
}

function pickKpi(text) {
  const engine = getKpi();
  if (!engine || typeof engine.extractKpis !== 'function') return null;
  try {
    const r = engine.extractKpis(text);
    if (r.kpis && r.kpis.length > 0) return r.kpis[0];
  } catch { /* swallow */ }
  return null;
}

function pickRisk(text) {
  const engine = getRiskRegister();
  if (!engine || typeof engine.extractRiskRegister !== 'function') return null;
  try {
    const r = engine.extractRiskRegister(text);
    if (r.risks && r.risks.length > 0) {
      // Sort by severity rank using engine's exported helper
      const rank = engine._internal && typeof engine._internal.severityRank === 'function'
        ? engine._internal.severityRank
        : (s) => ({ critical: 0, high: 1, medium: 2, low: 3 })[s] ?? 4;
      const sorted = [...r.risks].sort((a, b) => rank(a.severity) - rank(b.severity));
      return sorted[0];
    }
  } catch { /* swallow */ }
  return null;
}

function pickObligation(text) {
  const engine = getObligations();
  if (!engine || typeof engine.extractObligations !== 'function') return null;
  try {
    const r = engine.extractObligations(text);
    if (r.obligations && r.obligations.length > 0) return r.obligations[0];
  } catch { /* swallow */ }
  return null;
}

function pickGrade(text) {
  const engine = getQualityGrade();
  if (!engine || typeof engine.gradeDocument !== 'function') return null;
  try {
    return engine.gradeDocument(text);
  } catch { return null; }
}

function buildExecutiveSummaryForFile(file) {
  if (!file || typeof file !== 'object') return null;
  const text = safeText(file.extractedText);
  if (!text) return null;
  const title = pickTitle(file);
  const tldr = pickTldr(text);
  const kpi = pickKpi(text);
  const risk = pickRisk(text);
  const obligation = pickObligation(text);
  const grade = pickGrade(text);
  if (!title && !tldr && !kpi && !risk && !obligation && !grade) return null;
  return {
    file: safeFileName(file),
    title: title ? title.title : null,
    titleConfidence: title ? title.confidence : null,
    tldr: tldr ? tldr.sentence : null,
    tldrKind: tldr ? tldr.kind : null,
    kpi: kpi ? { label: kpi.label, value: kpi.rawValue, unit: kpi.unit, period: kpi.period, sentence: kpi.sentence } : null,
    risk: risk ? { severity: risk.severity, category: risk.category, sentence: risk.sentence } : null,
    obligation: obligation ? { polarity: obligation.polarity, subject: obligation.subject, sentence: obligation.sentence } : null,
    grade: grade ? { letter: grade.letter, score: grade.score } : null,
  };
}

function buildExecutiveSummaryForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const summary = buildExecutiveSummaryForFile(f);
    if (summary) perFile.push(summary);
  }
  return { perFile };
}

function renderFile(s) {
  const lines = [];
  if (s.title) lines.push(`**${s.title}** _(${s.file})_`);
  else lines.push(`**${s.file}**`);
  if (s.grade) lines.push(`- Grade: **${s.grade.letter}** (score ${s.grade.score})`);
  if (s.tldr) lines.push(`- TL;DR: ${s.tldr}`);
  if (s.kpi) {
    const unit = s.kpi.unit ? ` ${s.kpi.unit}` : '';
    const period = s.kpi.period ? ` (${s.kpi.period})` : '';
    lines.push(`- Top KPI: **${s.kpi.label}** = ${s.kpi.value}${unit}${period}`);
  }
  if (s.risk) {
    lines.push(`- Top risk: [**${(s.risk.severity || '').toUpperCase()}** · ${s.risk.category}] ${s.risk.sentence}`);
  }
  if (s.obligation) {
    const tag = (s.obligation.polarity || 'positive').toUpperCase();
    const subj = s.obligation.subject ? `**${s.obligation.subject}** ` : '';
    lines.push(`- Top obligation: [${tag}] ${subj}${s.obligation.sentence}`);
  }
  return lines.join('\n');
}

function renderExecutiveSummaryBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## EXECUTIVE SUMMARY
A single-card synthesis per attached document — title + grade + TL;DR + top KPI + top risk + top obligation. Compiled deterministically from the underlying analyzers; use it to open analytical answers before diving into per-axis blocks.`;
  const sections = report.perFile.map(renderFile);
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...executive summary block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildExecutiveSummaryForFile,
  buildExecutiveSummaryForFiles,
  renderExecutiveSummaryBlock,
  _internal: {
    pickTitle,
    pickTldr,
    pickKpi,
    pickRisk,
    pickObligation,
    pickGrade,
  },
};
