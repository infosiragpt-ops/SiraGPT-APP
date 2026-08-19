'use strict';

/**
 * document-git-shas.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects git commit SHAs (short and full) along with common contextual
 * markers ("commit abc1234", "git checkout deadbeef", "rev:abcd1234").
 *
 * Rejects:
 *   - Hex strings inside URLs/paths (they're usually hashes of something else)
 *   - Pure 0/F runs (genesis / placeholder)
 *
 * Public API:
 *   extractGitShas(text)            → { entries, totals, total }
 *   buildGitShasForFiles(files)     → { perFile, aggregate, totals }
 *   renderGitShasBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

// Labeled: "commit abc1234", "git checkout deadbeef", "rev abc1234", "sha: abc1234"
const LABELED_RE = /\b(commit|git\s+checkout|git\s+show|git\s+reset|git\s+revert|git\s+cherry-pick|rev|sha|hash|ref|HEAD)\s*[:@]?\s*([0-9a-f]{7,40})\b/gi;
// PR-style "Fixes abc1234" / "Closes deadbeef"
const FIX_RE = /\b(?:fixes|closes|resolves|merges|addresses|reverts|reverting)\s+([0-9a-f]{7,40})\b/gi;
// Standalone 40-char (full) at word boundary
const FULL_RE = /(?<![A-Za-z0-9])([0-9a-f]{40})(?![A-Za-z0-9])/g;

function isHexPlaceholder(s) {
  return /^0+$/.test(s) || /^f+$/i.test(s);
}

function classifyLength(sha) {
  if (sha.length === 40) return 'full';
  if (sha.length >= 7 && sha.length <= 12) return 'short';
  return 'medium';
}

function extractGitShas(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { short: 0, medium: 0, full: 0 };

  function push(sha, label) {
    const lower = sha.toLowerCase();
    if (isHexPlaceholder(lower)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    const len = classifyLength(lower);
    entries.push({ sha: lower, length: len, source: label });
    if (totals[len] != null) totals[len] += 1;
  }

  // Labeled context
  LABELED_RE.lastIndex = 0;
  let m;
  while ((m = LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[2], 'labeled');
  }

  // PR-style
  if (entries.length < MAX_PER_FILE) {
    FIX_RE.lastIndex = 0;
    while ((m = FIX_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'pr-ref');
    }
  }

  // Standalone 40-char
  if (entries.length < MAX_PER_FILE) {
    FULL_RE.lastIndex = 0;
    while ((m = FULL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'standalone-40');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGitShasForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { short: 0, medium: 0, full: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGitShas(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.sha)) continue;
      aggSeen.add(e.sha);
      aggregate.push(e);
      if (totals[e.length] != null) totals[e.length] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderGitShasBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GIT COMMIT SHAs'];
  const t = report.totals || {};
  const parts = [];
  if (t.short) parts.push(`short (7-12): ${t.short}`);
  if (t.medium) parts.push(`medium (13-39): ${t.medium}`);
  if (t.full) parts.push(`full (40): ${t.full}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- \`${e.sha}\` (${e.length}, ${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGitShas,
  buildGitShasForFiles,
  renderGitShasBlock,
  _internal: { isHexPlaceholder, classifyLength },
};
