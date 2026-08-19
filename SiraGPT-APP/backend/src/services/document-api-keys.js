'use strict';

/**
 * document-api-keys.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects API keys / tokens (with masking) in tech docs / configs / leaked
 * payloads:
 *
 *   - Bearer tokens: "Bearer eyJ..." JWT-style
 *   - OpenAI: sk-... (40+ chars)
 *   - GitHub PAT: ghp_..., gho_..., ghs_..., ghu_..., github_pat_...
 *   - AWS Access Key: AKIA + 16 chars
 *   - Stripe: sk_live_..., pk_live_..., sk_test_...
 *   - Slack: xoxb-..., xoxp-..., xoxe-...
 *   - Generic JWT: 3 dot-separated base64 segments
 *   - Generic password=...
 *
 * ALWAYS masks to first-4 + last-4 — never reproduces full secret.
 * Routes "leaked secrets?" / "what API keys?" to a citeable masked list.
 *
 * Public API:
 *   extractApiKeys(text)         → ApiKeyReport
 *   buildApiKeysForFiles(files)  → { perFile, aggregate, totals }
 *   renderApiKeysBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  // OpenAI
  { kind: 'openai-sk', re: /\b(sk-[A-Za-z0-9_-]{20,80})\b/g },
  // GitHub PATs
  { kind: 'github-pat', re: /\b(ghp_[A-Za-z0-9]{36,40}|gho_[A-Za-z0-9]{36,40}|ghs_[A-Za-z0-9]{36,40}|ghu_[A-Za-z0-9]{36,40}|github_pat_[A-Za-z0-9_]{30,100})\b/g },
  // AWS Access Key
  { kind: 'aws-access', re: /\b(AKIA[A-Z0-9]{16})\b/g },
  // Stripe
  { kind: 'stripe', re: /\b(sk_(?:live|test)_[A-Za-z0-9]{20,99}|pk_(?:live|test)_[A-Za-z0-9]{20,99})\b/g },
  // Slack
  { kind: 'slack', re: /\b(xox[bpeoars]-[A-Za-z0-9-]{10,80})\b/g },
  // Bearer token
  { kind: 'bearer', re: /\bBearer\s+([A-Za-z0-9_\-.=]{20,400})\b/g },
  // JWT (3 segments)
  { kind: 'jwt', re: /\b(eyJ[A-Za-z0-9_=-]{10,200}\.eyJ[A-Za-z0-9_=-]{10,400}\.[A-Za-z0-9_\-=]{10,200})\b/g },
  // password=...
  { kind: 'password', re: /\b(?:password|passwd|pwd|api[_-]?key|apikey|token|secret)\s*[:=]\s*["']?([^\s"'`<>]{6,80})["']?/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function maskKey(s) {
  const t = String(s || '');
  if (t.length <= 8) return '*'.repeat(t.length);
  return `${t.slice(0, 4)}…${'*'.repeat(Math.min(t.length - 8, 16))}…${t.slice(-4)}`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractApiKeys(input) {
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
      const raw = m[1];
      if (!raw) continue;
      const masked = maskKey(raw);
      const key = `${kind}|${masked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, masked, length: raw.length });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildApiKeysForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractApiKeys(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.masked}\` (${e.length} chars)${file}`;
}

function renderApiKeysBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## API KEYS / SECRETS (MASKED — SECURITY ALERT)
API keys and secrets detected and **always masked to first-4…last-4** to prevent leaking credentials into the chat: OpenAI sk-..., GitHub PAT (ghp_/gho_/ghs_/ghu_/github_pat_), AWS AKIA-..., Stripe sk_live_/pk_live_/sk_test_, Slack xox[bpeoars]-..., Bearer tokens, JWT (eyJ...), and labeled password/secret/token/api_key. Full secrets are never reproduced in the enrichment block. ⚠️ If detected in production docs, treat as a security incident.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate (masked) keys across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...api keys block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractApiKeys,
  buildApiKeysForFiles,
  renderApiKeysBlock,
  _internal: {
    PATTERNS,
    KINDS,
    maskKey,
  },
};
