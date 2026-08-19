'use strict';

/**
 * document-lifecycle-phases.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects software lifecycle / release phase markers:
 *
 *   - early: alpha / preview / experimental / canary / nightly
 *   - mid:   beta / RC / release-candidate
 *   - stable: GA / general availability / stable / production
 *   - end:   deprecated / EOL / end-of-life / sunset / retired / removed
 *
 * Public API:
 *   extractLifecyclePhases(text)             → { entries, totals, total }
 *   buildLifecyclePhasesForFiles(files)      → { perFile, aggregate, totals }
 *   renderLifecyclePhasesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const PHASES = {
  alpha: 'early',
  preview: 'early',
  experimental: 'early',
  canary: 'early',
  nightly: 'early',
  'early-access': 'early',
  'pre-release': 'early',
  prerelease: 'early',
  beta: 'mid',
  'public-beta': 'mid',
  'private-beta': 'mid',
  rc: 'mid',
  'release-candidate': 'mid',
  ga: 'stable',
  'general-availability': 'stable',
  'general-available': 'stable',
  stable: 'stable',
  production: 'stable',
  released: 'stable',
  deprecated: 'end',
  eol: 'end',
  'end-of-life': 'end',
  sunset: 'end',
  retired: 'end',
  removed: 'end',
  obsolete: 'end',
};

const PHASE_TERMS = Object.keys(PHASES).sort((a, b) => b.length - a.length);
const PHASE_ALT = PHASE_TERMS.map((t) => t.replace(/-/g, '[-\\s]?')).join('|');
const PHASE_RE = new RegExp(`\\b(${PHASE_ALT})\\b`, 'gi');

const VERSION_PHASE_RE = /\b(\d+(?:\.\d+){1,3})[-.]?(alpha|beta|rc|preview|canary|nightly|experimental)(?:[-.]?(\d{1,3}))?\b/gi;

function normalisePhase(s) {
  return s.toLowerCase().replace(/[\s_]+/g, '-');
}

function extractLifecyclePhases(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { early: 0, mid: 0, stable: 0, end: 0 };

  function push(term, bucket, source) {
    const norm = normalisePhase(term);
    const key = `${norm}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ term: norm, bucket, source });
    if (totals[bucket] != null) totals[bucket] += 1;
  }

  // Version-attached: 1.2.3-beta.4
  VERSION_PHASE_RE.lastIndex = 0;
  let m;
  while ((m = VERSION_PHASE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const term = m[2].toLowerCase();
    const bucket = PHASES[term] || PHASES[`${term}-access`] || 'other';
    push(`${m[1]}-${term}${m[3] ? '.' + m[3] : ''}`, bucket === 'other' ? 'mid' : bucket, 'version');
  }

  // Bare phase terms
  if (entries.length < MAX_PER_FILE) {
    PHASE_RE.lastIndex = 0;
    while ((m = PHASE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const term = m[1];
      const norm = normalisePhase(term);
      const bucket = PHASES[norm];
      if (!bucket) continue;
      push(norm, bucket, 'term');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildLifecyclePhasesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { early: 0, mid: 0, stable: 0, end: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractLifecyclePhases(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.term}:${e.source}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.bucket] != null) totals[e.bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderLifecyclePhasesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## LIFECYCLE / RELEASE PHASES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.bucket}] ${e.term} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractLifecyclePhases,
  buildLifecyclePhasesForFiles,
  renderLifecyclePhasesBlock,
  _internal: { PHASES, normalisePhase },
};
