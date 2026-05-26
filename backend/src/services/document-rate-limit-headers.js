'use strict';

/**
 * document-rate-limit-headers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects HTTP rate-limit headers:
 *
 *   - X-RateLimit-Limit:     1000
 *   - X-RateLimit-Remaining: 873
 *   - X-RateLimit-Reset:     1577836800   (Unix timestamp)
 *   - Retry-After:           120          (seconds) or HTTP date
 *   - RateLimit:             RFC 8030 form ("limit=100, remaining=50, reset=60")
 *   - X-Ratelimit-Policy:    "100;w=60"   (windowed)
 *
 * Public API:
 *   extractRateLimitHeaders(text)            → { entries, totals, total }
 *   buildRateLimitHeadersForFiles(files)     → { perFile, aggregate, totals }
 *   renderRateLimitHeadersBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const LIMIT_RE = /\b(X-Rate[-]?Limit-Limit|X-Ratelimit-Limit)\s*:\s*(\d{1,8})/gi;
const REMAINING_RE = /\b(X-Rate[-]?Limit-Remaining|X-Ratelimit-Remaining)\s*:\s*(\d{1,8})/gi;
const RESET_RE = /\b(X-Rate[-]?Limit-Reset|X-Ratelimit-Reset)\s*:\s*(\d{1,15})/gi;
const RETRY_AFTER_RE = /\bRetry-After\s*:\s*(\d{1,7}|[A-Z][a-z]{2,8},\s+[^\n\r]{8,40})/g;
const RFC_RATELIMIT_RE = /\bRateLimit\s*:\s*([^\n\r]{5,150})/g;
const POLICY_RE = /\b(?:X-)?Ratelimit-Policy\s*:\s*"?([^"\n\r]{2,80})"?/gi;

function classifyResetUnit(value) {
  const n = parseInt(value, 10);
  if (n < 1000) return 'seconds';
  if (n < 1000000000) return 'epoch?';
  return 'epoch';
}

function extractRateLimitHeaders(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { limit: 0, remaining: 0, reset: 0, retryAfter: 0, rfc: 0, policy: 0 };

  function push(kind, header, value, extra) {
    const key = `${kind}:${header}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, header, value, ...(extra || {}) });
    if (totals[kind] != null) totals[kind] += 1;
  }

  LIMIT_RE.lastIndex = 0;
  let m;
  while ((m = LIMIT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('limit', m[1], m[2]);
  }
  if (entries.length < MAX_PER_FILE) {
    REMAINING_RE.lastIndex = 0;
    while ((m = REMAINING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('remaining', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RESET_RE.lastIndex = 0;
    while ((m = RESET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('reset', m[1], m[2], { unit: classifyResetUnit(m[2]) });
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RETRY_AFTER_RE.lastIndex = 0;
    while ((m = RETRY_AFTER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('retryAfter', 'Retry-After', m[1].slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RFC_RATELIMIT_RE.lastIndex = 0;
    while ((m = RFC_RATELIMIT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('rfc', 'RateLimit', m[1].slice(0, 100));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    POLICY_RE.lastIndex = 0;
    while ((m = POLICY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('policy', 'Ratelimit-Policy', m[1].slice(0, 80));
    }
  }

  return { entries, totals, total: entries.length };
}

function buildRateLimitHeadersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { limit: 0, remaining: 0, reset: 0, retryAfter: 0, rfc: 0, policy: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractRateLimitHeaders(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.value}`;
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

function renderRateLimitHeadersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## RATE-LIMIT HEADERS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      const suffix = e.unit ? ` (${e.unit})` : '';
      lines.push(`- ${e.header}: \`${e.value}\`${suffix}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractRateLimitHeaders,
  buildRateLimitHeadersForFiles,
  renderRateLimitHeadersBlock,
  _internal: { classifyResetUnit },
};
