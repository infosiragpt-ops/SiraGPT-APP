'use strict';

/**
 * document-pr-review-states.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects pull-request review states / approval signals in PR comments,
 * commit messages, design docs:
 *
 *   - approval:   "LGTM", "looks good to me", "ship it", "approved", ":lgtm:"
 *   - changes:    "request changes", "needs changes", "blocked", ":-1:"
 *   - dismissed:  "dismiss review", "stale review"
 *   - neutral:    "FYI", "nit:", "non-blocking", "optional:"
 *   - voting:     +1 / -1 / +2 / shorthand
 *
 * Public API:
 *   extractPrReviewStates(text)            → { entries, totals, total }
 *   buildPrReviewStatesForFiles(files)     → { perFile, aggregate, totals }
 *   renderPrReviewStatesBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const APPROVAL_RE = /\b(LGTM|looks\s+good\s+to\s+me|ship\s+it|approved?|merge\s+when\s+ready|\u{1F44D}|👍)\b/giu;
const CHANGES_RE = /\b(request(?:ed)?\s+changes|needs?\s+changes|blocked\s+on|blocking|requires?\s+fixes?|\u{1F44E}|👎)\b/giu;
const DISMISSED_RE = /\b(dismiss(?:ed)?\s+review|stale\s+review|outdated\s+review)\b/gi;
const NEUTRAL_RE = /\b(nit\s*:|non[-\s]?blocking|optional\s*:|FYI(?:\b|(?=\s|$|,|\.)))/gi;
const VOTING_RE = /(?<![A-Za-z0-9])([+-]\d)(?![A-Za-z0-9])/g;
const EMOJI_LGTM_RE = /:lgtm:|:shipit:|:white_check_mark:|:thumbsup:|:\+1:/gi;
const EMOJI_BLOCK_RE = /:no_entry:|:no_entry_sign:|:thumbsdown:|:-1:/gi;

function extractPrReviewStates(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { approval: 0, changes: 0, dismissed: 0, neutral: 0, voting: 0 };

  function push(kind, snippet) {
    const key = `${kind}:${snippet.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, snippet: snippet.slice(0, 60) });
    if (totals[kind] != null) totals[kind] += 1;
  }

  APPROVAL_RE.lastIndex = 0;
  let m;
  while ((m = APPROVAL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('approval', m[0]);
  if (entries.length < MAX_PER_FILE) {
    EMOJI_LGTM_RE.lastIndex = 0;
    while ((m = EMOJI_LGTM_RE.exec(body)) && entries.length < MAX_PER_FILE) push('approval', m[0]);
  }

  if (entries.length < MAX_PER_FILE) {
    CHANGES_RE.lastIndex = 0;
    while ((m = CHANGES_RE.exec(body)) && entries.length < MAX_PER_FILE) push('changes', m[0]);
    EMOJI_BLOCK_RE.lastIndex = 0;
    while ((m = EMOJI_BLOCK_RE.exec(body)) && entries.length < MAX_PER_FILE) push('changes', m[0]);
  }

  if (entries.length < MAX_PER_FILE) {
    DISMISSED_RE.lastIndex = 0;
    while ((m = DISMISSED_RE.exec(body)) && entries.length < MAX_PER_FILE) push('dismissed', m[0]);
  }

  if (entries.length < MAX_PER_FILE) {
    NEUTRAL_RE.lastIndex = 0;
    while ((m = NEUTRAL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('neutral', m[0]);
  }

  if (entries.length < MAX_PER_FILE) {
    VOTING_RE.lastIndex = 0;
    while ((m = VOTING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const v = m[1];
      const kind = v.startsWith('+') ? 'approval' : 'changes';
      push(kind === 'approval' ? 'voting' : 'voting', v);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPrReviewStatesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { approval: 0, changes: 0, dismissed: 0, neutral: 0, voting: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPrReviewStates(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.snippet}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPrReviewStatesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PR REVIEW STATES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] \`${e.snippet}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPrReviewStates,
  buildPrReviewStatesForFiles,
  renderPrReviewStatesBlock,
};
