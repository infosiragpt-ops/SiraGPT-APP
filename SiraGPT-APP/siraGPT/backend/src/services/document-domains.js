'use strict';

/**
 * document-domains.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects bare domain names in documents (no scheme://, no path):
 *
 *   - example.com, sub.example.org, api.acme.io, dashboard.gov.br
 *   - Excludes domains that appear inside URLs (already covered by
 *     document-urls) or email addresses (document-contact-info)
 *   - Filters obvious false positives like file extensions (file.txt,
 *     image.png) by validating against a curated list of TLDs
 *
 * Routes "what domains does this reference?", "what's the homepage?"
 * to a citeable list. Different from URLs (which include scheme+path)
 * and email addresses (have @).
 *
 * Public API:
 *   extractDomains(text)         → DomainReport
 *   buildDomainsForFiles(files)  → { perFile, aggregate, totals }
 *   renderDomainsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_DOMAIN_LEN = 100;

// Curated list of common TLDs to validate against
const VALID_TLDS = new Set([
  'com', 'org', 'net', 'io', 'co', 'app', 'dev', 'ai', 'gov', 'edu',
  'mil', 'biz', 'info', 'name', 'pro', 'aero', 'coop', 'museum',
  'us', 'uk', 'ca', 'au', 'de', 'fr', 'it', 'es', 'pt', 'nl', 'be',
  'br', 'mx', 'ar', 'cl', 'co', 'pe', 've', 'ec', 'bo', 'py', 'uy',
  'jp', 'cn', 'kr', 'in', 'sg', 'hk', 'tw', 'my', 'th', 'id', 'vn',
  'ru', 'ua', 'pl', 'cz', 'hu', 'ro', 'gr', 'tr', 'il', 'sa', 'ae',
  'za', 'eg', 'ng', 'ke', 'gh', 'tz', 'ug', 'rw',
  'eu', 'cloud', 'tech', 'dev', 'design', 'studio', 'agency',
  'engineering', 'consulting', 'systems', 'software', 'services',
  'data', 'media', 'press', 'news', 'wiki', 'blog', 'docs',
]);

// Optional subdomains + label + tld
// Allows letters, digits, hyphens; rejects starting/ending with hyphen
const DOMAIN_RE = /(?:^|[\s`'"<>(,;:])(?<!@)(?<!\/)([a-zA-Z0-9][a-zA-Z0-9\-]{0,62}(?:\.[a-zA-Z0-9][a-zA-Z0-9\-]{0,62})+)(?=[\s`'"<>):,;.!?]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipDomain(d) {
  const s = String(d || '').toLowerCase();
  if (s.length <= MAX_DOMAIN_LEN) return s;
  return `${s.slice(0, MAX_DOMAIN_LEN - 1)}…`;
}

function getTld(domain) {
  const parts = domain.split('.');
  return parts[parts.length - 1].toLowerCase();
}

function getApex(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join('.');
}

function isLikelyDomain(d) {
  if (!d || d.length < 4) return false;
  if (d.startsWith('-') || d.endsWith('-')) return false;
  const parts = d.split('.');
  if (parts.length < 2) return false;
  const tld = getTld(d);
  if (!VALID_TLDS.has(tld)) return false;
  // Reject if any label is empty
  if (parts.some((p) => !p)) return false;
  // Each label must have at least one letter (rejects "1.2.3.com")
  return parts.slice(0, -1).some((p) => /[a-zA-Z]/.test(p));
}

function extractDomains(input) {
  const text = safeText(input);
  if (!text) return { domains: [], total: 0, totals: { domain: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const domains = [];
  const seen = new Set();

  for (const m of head.matchAll(DOMAIN_RE)) {
    if (domains.length >= MAX_PER_FILE) break;
    const d = clipDomain(m[1]);
    if (!isLikelyDomain(d)) continue;
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    domains.push({ domain: d, apex: getApex(d), tld: getTld(d) });
  }

  return { domains, total: domains.length, totals: { domain: domains.length }, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildDomainsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  let total = 0;
  for (const f of list) {
    const r = extractDomains(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, domains: r.domains, totals: r.totals });
    aggregate = aggregate.concat(r.domains.map((d) => ({ ...d, file: name })));
    total += r.total;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals: { domain: total } };
}

function renderDomain(d, opts = {}) {
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  const apex = d.apex && d.apex !== d.domain ? ` (apex: ${d.apex})` : '';
  return `- \`${d.domain}\`${apex}${file}`;
}

function renderDomainsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const total = report.totals?.domain || 0;
  const heading = `## DOMAINS
Bare domain names (no scheme, no path) detected in the document(s). Validated against a curated TLD list to reduce false positives. Excludes domains inside URLs and email addresses. Routes "what domains does this reference?" / "what's the homepage?" to a citeable list.

**Total domains:** ${total}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.domains) sections.push(renderDomain(d));
  } else {
    sections.push('### Aggregate domains across all files');
    for (const d of report.aggregate) sections.push(renderDomain(d, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.domains) sections.push(renderDomain(d));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...domains block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDomains,
  buildDomainsForFiles,
  renderDomainsBlock,
  _internal: {
    DOMAIN_RE,
    VALID_TLDS,
    isLikelyDomain,
    getTld,
    getApex,
  },
};
