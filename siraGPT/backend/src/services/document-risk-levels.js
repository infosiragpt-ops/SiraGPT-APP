'use strict';

/**
 * document-risk-levels.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects severity / risk-level labels in incident reports, security
 * advisories, runbooks, and audit logs.
 *
 *   - severity:  Critical / High / Medium / Low / Info
 *   - P0..P4 priority levels
 *   - Sev0..Sev5 severity classes
 *   - Pager urgency (P1, P2) and incident.io style
 *
 * Public API:
 *   extractRiskLevels(text)             → { entries, totals, total }
 *   buildRiskLevelsForFiles(files)      → { perFile, aggregate, totals }
 *   renderRiskLevelsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const SEVERITY_RE = /\b(severity|priority|risk|level|impact|urgency)\s*[:=]?\s*(critical|high|medium|moderate|low|info(?:rmational)?|negligible)\b/gi;
const BARE_SEVERITY_RE = /\b(critical|high|medium|low|info)\s+(?:risk|severity|priority|finding|vulnerability|issue|alert)\b/gi;
const P_LEVEL_RE = /\b(P[0-4])\b/g;
const SEV_LEVEL_RE = /\b(Sev[0-5])\b/g;
const INCIDENT_RE = /\b(SEV[0-5]|SEVERITY[-_]?[0-5])\b/gi;

const CANONICAL = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low',
  info: 'info',
  informational: 'info',
  negligible: 'info',
};

function classifyPLevel(level) {
  const n = parseInt(level.slice(1), 10);
  if (n === 0) return 'critical';
  if (n === 1) return 'high';
  if (n === 2) return 'medium';
  if (n === 3) return 'low';
  return 'info';
}

function classifySevLevel(s) {
  const n = parseInt(s.match(/\d/)[0], 10);
  if (n <= 1) return 'critical';
  if (n === 2) return 'high';
  if (n === 3) return 'medium';
  if (n === 4) return 'low';
  return 'info';
}

function extractRiskLevels(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  function push(level, source, raw) {
    if (!totals.hasOwnProperty(level)) return;
    const key = `${level}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ level, source, raw: raw.slice(0, 40) });
    totals[level] += 1;
  }

  SEVERITY_RE.lastIndex = 0;
  let m;
  while ((m = SEVERITY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const lbl = m[2].toLowerCase().replace(/rmational$/, '');
    const level = CANONICAL[lbl] || null;
    if (!level) continue;
    push(level, m[1].toLowerCase(), m[0]);
  }

  if (entries.length < MAX_PER_FILE) {
    BARE_SEVERITY_RE.lastIndex = 0;
    while ((m = BARE_SEVERITY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const level = CANONICAL[m[1].toLowerCase()];
      if (!level) continue;
      push(level, 'noun-phrase', m[0]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    P_LEVEL_RE.lastIndex = 0;
    while ((m = P_LEVEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(classifyPLevel(m[1]), 'p-level', m[1]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SEV_LEVEL_RE.lastIndex = 0;
    while ((m = SEV_LEVEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(classifySevLevel(m[1]), 'sev-level', m[1]);
    }
    INCIDENT_RE.lastIndex = 0;
    while ((m = INCIDENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(classifySevLevel(m[1]), 'sev-level', m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildRiskLevelsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractRiskLevels(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.level}:${e.source}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.level] != null) totals[e.level] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderRiskLevelsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## RISK / SEVERITY LEVELS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.level}] ${e.source}: \`${e.raw}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractRiskLevels,
  buildRiskLevelsForFiles,
  renderRiskLevelsBlock,
  _internal: { classifyPLevel, classifySevLevel, CANONICAL },
};
