'use strict';

/**
 * document-network.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects network identifiers in tech docs / network configs / runbooks:
 *
 *   - IPv4: 192.168.1.1, 10.0.0.0
 *   - IPv6: 2001:db8::1, fe80::1
 *   - CIDR notation: 10.0.0.0/16, 2001:db8::/32
 *   - MAC addresses: 00:1A:2B:3C:4D:5E
 *   - Port labels: ":8080", "port 443"
 *
 * Different from document-api-endpoints (HTTP paths) and document-urls
 * (web links). Routes "what IP / port / network?" to a citeable list.
 *
 * Public API:
 *   extractNetwork(text)         → NetworkReport
 *   buildNetworkForFiles(files)  → { perFile, aggregate, totals }
 *   renderNetworkBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 12;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 60;

const IPV4_RE = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\/\d{1,2})?(?![\w.])/g;
// Simple IPv6 (8 groups of 1-4 hex separated by colons, with :: compression allowed)
const IPV6_RE = /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?:\/\d{1,3})?(?![\w:])|(?<![\w:])(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4})?(?:\/\d{1,3})?(?![\w:])|(?<![\w:])::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}(?:\/\d{1,3})?(?![\w:])/g;
const MAC_RE = /(?<![\w:])(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}(?![\w:])/g;
// Port: ":8080" or "port 443" or "Port: 8080"
const PORT_LABEL_RE = /\b(?:port|puerto)\s*[:=]?\s*(\d{2,5})\b/gi;
const PORT_INLINE_RE = /(?:^|[\s`'"<>(,;:])(?:listen(?:ing)?\s+on\s+)?:(\d{2,5})(?=[\s`'"<>):,;.!?]|$)/g;

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

function isValidPort(p) {
  const n = Number(p);
  return Number.isFinite(n) && n >= 1 && n <= 65535;
}

function isLikelyIPv4(s) {
  if (!s) return false;
  const parts = s.split('/')[0].split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isFinite(n) && n >= 0 && n <= 255;
  });
}

function emptyTotals() {
  return { ipv4: 0, ipv6: 0, mac: 0, port: 0 };
}

function extractNetwork(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (entries.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(IPV4_RE)) {
    if (isLikelyIPv4(m[0])) add('ipv4', m[0]);
  }
  for (const m of head.matchAll(IPV6_RE)) {
    add('ipv6', m[0]);
  }
  for (const m of head.matchAll(MAC_RE)) {
    add('mac', m[0]);
  }
  for (const m of head.matchAll(PORT_LABEL_RE)) {
    if (isValidPort(m[1])) add('port', m[1]);
  }
  for (const m of head.matchAll(PORT_INLINE_RE)) {
    if (isValidPort(m[1])) add('port', m[1]);
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildNetworkForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractNetwork(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderNetworkBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## NETWORK IDENTIFIERS
Network identifiers detected in the document(s): IPv4 (with optional CIDR), IPv6 (with optional CIDR), MAC addresses, and ports (labeled "port: 8080" / "puerto: 443", or inline ":8080"). Different from API endpoints (HTTP paths) and URLs (web links). Routes "what IP / port / network?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate network ids across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...network block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractNetwork,
  buildNetworkForFiles,
  renderNetworkBlock,
  _internal: {
    IPV4_RE,
    IPV6_RE,
    MAC_RE,
    PORT_LABEL_RE,
    PORT_INLINE_RE,
    isValidPort,
    isLikelyIPv4,
  },
};
