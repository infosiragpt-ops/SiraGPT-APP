'use strict';

/**
 * document-oauth-scopes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OAuth 2.0 / OIDC scope strings in auth docs / API specs:
 *
 *   - Verb-prefixed: "read:user", "write:org", "admin:repo", "delete:objects"
 *   - OIDC: "openid", "profile", "email", "offline_access"
 *   - Google: "https://www.googleapis.com/auth/userinfo.email"
 *   - Slack: "users:read", "chat:write", "files:write"
 *   - GitHub: "repo", "user", "admin:org", "delete_repo"
 *
 * Routes "what permissions?" / "what scopes?" to a citeable list.
 *
 * Public API:
 *   extractOauthScopes(text)         → ScopeReport
 *   buildOauthScopesForFiles(files)  → { perFile, aggregate, totals }
 *   renderOauthScopesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 120;

const OIDC_SCOPES = new Set([
  'openid', 'profile', 'email', 'address', 'phone', 'offline_access',
]);

const PATTERNS = [
  // Verb-prefixed: action:resource
  { kind: 'verb-resource', re: /\b((?:read|write|admin|delete|update|create|manage|list|get|put|patch|post|index|search)[:_-][a-z][a-z0-9_:.\-]{1,60})\b/g },
  // resource:action
  { kind: 'resource-action', re: /\b([a-z][a-z0-9]{2,30}:(?:read|write|admin|delete|update|create|manage|all))\b/g },
  // Google-style URL scope
  { kind: 'google-url', re: /\b(https?:\/\/www\.googleapis\.com\/auth\/[a-z0-9._\-]{3,80})\b/g },
  // Labeled scope: line
  { kind: 'labeled', re: /\b(?:scope|scopes|permission|permissions)\s*[:=]\s*["']?([a-zA-Z0-9_\-:.\/\s]{3,200})["']?/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

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

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  r.oidc = 0;
  return r;
}

function extractOauthScopes(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const value = clipValue(m[1]);
      const key = `${kind}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, value });
      totals[kind] += 1;
    }
  }

  // OIDC standard scopes (bare word matches)
  for (const word of OIDC_SCOPES) {
    if (entries.length >= MAX_PER_FILE) break;
    const re = new RegExp(`\\b${word}\\b`, 'g');
    for (const m of head.matchAll(re)) {
      const key = `oidc|${word}`;
      if (seen.has(key)) break;
      seen.add(key);
      entries.push({ kind: 'oidc', value: word });
      totals.oidc += 1;
      break;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildOauthScopesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractOauthScopes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k] || 0;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderOauthScopesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## OAUTH SCOPES / PERMISSIONS
OAuth 2.0 / OIDC scope strings detected: verb-prefixed (read:user / write:org / admin:repo / delete:objects), resource-action (users:read / chat:write), Google-URL scopes (https://www.googleapis.com/auth/...), labeled (scope: / scopes: / permission:), and OIDC standard (openid / profile / email / offline_access). Routes "what permissions?" / "what scopes?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate scopes across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...oauth scopes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractOauthScopes,
  buildOauthScopesForFiles,
  renderOauthScopesBlock,
  _internal: {
    PATTERNS,
    KINDS,
    OIDC_SCOPES,
  },
};
