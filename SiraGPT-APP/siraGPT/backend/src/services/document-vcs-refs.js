'use strict';

/**
 * document-vcs-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects version-control system references in tech docs / changelogs /
 * release notes / postmortems:
 *
 *   - Commit SHA: 7-40 hex chars (post-validation against context)
 *   - PR / issue: #123, GH-123, PR-#456, gh-1234
 *   - GitHub URL: github.com/org/repo or owner/repo@sha
 *   - Branch names: "branch: feature/foo", "on main", "branch=develop"
 *   - Git tags: "tag: v1.0.0"
 *
 * Different from document-versions (SemVer labels) and document-identifiers
 * (CVE/ISBN). Routes "what commit?", "what PR?", "what branch?" to a
 * citeable list.
 *
 * Public API:
 *   extractVcsRefs(text)         → VcsRefReport
 *   buildVcsRefsForFiles(files)  → { perFile, aggregate, totals }
 *   renderVcsRefsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 10;
const MAX_PER_FILE = 28;
const MAX_AGGREGATE = 32;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 80;

// Commit SHA: only when prefixed with "commit", "sha", or "@" or in backticks
const COMMIT_RE = /(?:^|[\s`'"<>(,;:])(?:commit\s+|sha\s*[:=]\s*|@)([0-9a-f]{7,40})(?=[\s`'"<>):,;.!?]|$)/gi;
// Bare 40-char hex with explicit boundary (less reliable but more comprehensive)
const FULL_SHA_RE = /(?:^|[\s`'"<>(])([0-9a-f]{40})(?=[\s`'"<>):,;.!?]|$)/g;
// #123 / GH-123 / PR-#456
const ISSUE_RE = /(?:^|[\s`'"<>(])(#\d{1,7}|GH-\d{1,7}|gh-\d{1,7}|PR-?#?\d{1,7}|issues?\s+#?\d{1,7})(?=[\s`'"<>):,;.!?]|$)/g;
// owner/repo or owner/repo@sha (GitHub-style)
const REPO_REF_RE = /\b([a-zA-Z0-9][\w-]{0,38}\/[a-zA-Z0-9][\w.\-]{0,99}(?:@[0-9a-fA-F]{7,40})?)\b/g;
// "branch: feature/foo" / "on main"
const BRANCH_RE = /\b(?:branch|on\s+branch|in\s+branch)\s*[:=]?\s*([a-zA-Z0-9_\-./]{1,60})/gi;
// "tag: v1.2.3"
const TAG_RE = /\btag\s*[:=]\s*(v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.\-]+)?|[a-zA-Z][\w.\-]{1,30})/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function isLikelyRepoRef(s) {
  if (!s) return false;
  if (s.split('/').length !== 2 && !/@/.test(s)) return false;
  // Reject file paths with extensions
  if (/\.(js|ts|tsx|jsx|md|json|yaml|yml|css|html?|py|go|rs|java|cpp?|h|sh|sql|xml|csv)$/i.test(s)) return false;
  return /^[a-zA-Z0-9][\w-]{0,38}\/[a-zA-Z0-9][\w.\-]{0,99}/.test(s);
}

function emptyTotals() {
  return { commit: 0, issue: 0, repo: 0, branch: 0, tag: 0 };
}

function extractVcsRefs(input) {
  const text = safeText(input);
  if (!text) return { refs: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const refs = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (refs.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(COMMIT_RE)) add('commit', m[1]);
  for (const m of head.matchAll(FULL_SHA_RE)) add('commit', m[1]);
  for (const m of head.matchAll(ISSUE_RE)) add('issue', m[1]);
  for (const m of head.matchAll(REPO_REF_RE)) {
    if (isLikelyRepoRef(m[1])) add('repo', m[1]);
  }
  for (const m of head.matchAll(BRANCH_RE)) add('branch', m[1]);
  for (const m of head.matchAll(TAG_RE)) add('tag', m[1]);

  return { refs, total: refs.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildVcsRefsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractVcsRefs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, refs: r.refs, totals: r.totals });
    aggregate = aggregate.concat(r.refs.map((rf) => ({ ...rf, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderRef(r, opts = {}) {
  const file = opts.includeFile && r.file ? ` _(${r.file})_` : '';
  return `- [${r.kind}] \`${r.value}\`${file}`;
}

function renderVcsRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## VERSION CONTROL REFERENCES
Git / version-control references detected in the document(s): commit SHAs (prefixed forms commit X / sha=X / @X, plus bare 40-char hex), issue / PR numbers (#123, GH-123, PR-#456), owner/repo references (with optional @sha), branch names (branch: …, on …), and tags (tag: …). Different from SemVer document versions. Routes "what commit?" / "what PR?" / "what branch?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const r of only.refs) sections.push(renderRef(r));
  } else {
    sections.push('### Aggregate VCS refs across all files');
    for (const r of report.aggregate) sections.push(renderRef(r, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const r of p.refs) sections.push(renderRef(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...vcs refs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractVcsRefs,
  buildVcsRefsForFiles,
  renderVcsRefsBlock,
  _internal: {
    COMMIT_RE,
    FULL_SHA_RE,
    ISSUE_RE,
    REPO_REF_RE,
    BRANCH_RE,
    TAG_RE,
    isLikelyRepoRef,
  },
};
