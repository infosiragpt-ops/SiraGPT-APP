'use strict';

/**
 * document-github-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GitHub references in text:
 *
 *   - owner/repo#123                       — short issue/PR ref
 *   - GH-123 / gh-123                      — short numeric ref
 *   - https://github.com/owner/repo        — repo URL
 *   - https://github.com/owner/repo/issues/N    — issue URL
 *   - https://github.com/owner/repo/pull/N      — PR URL
 *   - @username                            — user mention (limited context)
 *   - owner/repo@sha                       — repo at commit
 *
 * Public API:
 *   extractGithubRefs(text)             → { entries, totals, total }
 *   buildGithubRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderGithubRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const REPO = '[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,60}';
const SHORT_REF_RE = new RegExp(`\\b(${REPO})#(\\d{1,6})\\b`, 'g');
const REPO_AT_SHA_RE = new RegExp(`\\b(${REPO})@([0-9a-f]{7,40})\\b`, 'g');
const GH_NUM_RE = /\b(?:GH|gh)-(\d{1,6})\b/g;
const REPO_URL_RE = /\bhttps?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9_.][A-Za-z0-9_.-]{0,60})(?:\/(?:issues|pull|pulls|tree|blob|commit)\/([A-Za-z0-9_./-]{1,80}))?/g;
const MENTION_RE = /(?:^|[\s({,])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/g;
const RESERVED_USER = new Set(['everyone', 'channel', 'team', 'here', 'all']);

function extractGithubRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { shortRef: 0, repoAtSha: 0, ghNum: 0, repoUrl: 0, issueUrl: 0, prUrl: 0, mention: 0 };

  // short refs: owner/repo#N
  SHORT_REF_RE.lastIndex = 0;
  let m;
  while ((m = SHORT_REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const ref = `${m[1]}#${m[2]}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    entries.push({ kind: 'short-ref', repo: m[1], number: parseInt(m[2], 10), ref });
    totals.shortRef += 1;
  }

  // repo@sha
  if (entries.length < MAX_PER_FILE) {
    REPO_AT_SHA_RE.lastIndex = 0;
    while ((m = REPO_AT_SHA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const ref = `${m[1]}@${m[2]}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      entries.push({ kind: 'repo-at-sha', repo: m[1], sha: m[2], ref });
      totals.repoAtSha += 1;
    }
  }

  // GH-NNN
  if (entries.length < MAX_PER_FILE) {
    GH_NUM_RE.lastIndex = 0;
    while ((m = GH_NUM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const ref = `GH-${m[1]}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      entries.push({ kind: 'gh-num', number: parseInt(m[1], 10), ref });
      totals.ghNum += 1;
    }
  }

  // Repo URLs (with possible issues/pull suffix)
  if (entries.length < MAX_PER_FILE) {
    REPO_URL_RE.lastIndex = 0;
    while ((m = REPO_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const owner = m[1];
      const repo = m[2];
      const sub = m[0];
      const isIssue = /\/issues\//.test(sub);
      const isPull = /\/(?:pull|pulls)\//.test(sub);
      const ref = sub;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const kind = isIssue ? 'issue-url' : isPull ? 'pr-url' : 'repo-url';
      entries.push({ kind, repo: `${owner}/${repo}`, ref });
      if (kind === 'issue-url') totals.issueUrl += 1;
      else if (kind === 'pr-url') totals.prUrl += 1;
      else totals.repoUrl += 1;
    }
  }

  // @user mentions
  if (entries.length < MAX_PER_FILE) {
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const u = m[1];
      if (RESERVED_USER.has(u.toLowerCase())) continue;
      if (u.length < 2) continue;
      const ref = `@${u}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      entries.push({ kind: 'mention', user: u, ref });
      totals.mention += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGithubRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { shortRef: 0, repoAtSha: 0, ghNum: 0, repoUrl: 0, issueUrl: 0, prUrl: 0, mention: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGithubRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.ref)) continue;
      aggSeen.add(e.ref);
      aggregate.push(e);
      const bucket = e.kind === 'short-ref' ? 'shortRef' :
                     e.kind === 'repo-at-sha' ? 'repoAtSha' :
                     e.kind === 'gh-num' ? 'ghNum' :
                     e.kind === 'issue-url' ? 'issueUrl' :
                     e.kind === 'pr-url' ? 'prUrl' :
                     e.kind === 'repo-url' ? 'repoUrl' :
                     e.kind === 'mention' ? 'mention' : null;
      if (bucket && totals[bucket] != null) totals[bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderGithubRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GITHUB REFERENCES'];
  const t = report.totals || {};
  const parts = [];
  if (t.shortRef) parts.push(`short-refs: ${t.shortRef}`);
  if (t.repoAtSha) parts.push(`repo@sha: ${t.repoAtSha}`);
  if (t.ghNum) parts.push(`GH-N: ${t.ghNum}`);
  if (t.repoUrl) parts.push(`repos: ${t.repoUrl}`);
  if (t.issueUrl) parts.push(`issues: ${t.issueUrl}`);
  if (t.prUrl) parts.push(`PRs: ${t.prUrl}`);
  if (t.mention) parts.push(`mentions: ${t.mention}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.kind}] \`${e.ref}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGithubRefs,
  buildGithubRefsForFiles,
  renderGithubRefsBlock,
};
