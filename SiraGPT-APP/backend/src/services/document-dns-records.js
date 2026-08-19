'use strict';

/**
 * document-dns-records.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects DNS record references in zone files, runbooks, debug logs:
 *
 *   - zone-file lines: "example.com. 3600 IN A 1.2.3.4"
 *   - dig outputs:     "example.com.  300  IN  CNAME  cname.host."
 *   - "Add an A record" prose
 *   - record types: A, AAAA, CNAME, MX, TXT, SOA, NS, SRV, CAA, PTR
 *
 * Public API:
 *   extractDnsRecords(text)             → { entries, totals, total }
 *   buildDnsRecordsForFiles(files)      → { perFile, aggregate, totals }
 *   renderDnsRecordsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SOA', 'NS', 'SRV', 'CAA', 'PTR', 'DNSKEY', 'DS', 'RRSIG', 'NSEC', 'NSEC3', 'TLSA', 'SVCB', 'HTTPS', 'NAPTR'];
const TYPE_ALT = TYPES.join('|');
const ZONE_LINE_RE = new RegExp(`^\\s*([a-zA-Z0-9_.-]{2,255})\\.?\\s+(\\d{1,7}\\s+)?IN\\s+(${TYPE_ALT})\\s+([^\\n\\r]{1,300})`, 'gm');
const PROSE_RE = new RegExp(`\\b(?:add|create|update|set|configure|delete|remove)\\s+(?:an?\\s+)?(${TYPE_ALT})\\s+record\\b`, 'gi');
const SUMMARY_RE = new RegExp(`\\bcurrent\\s+(${TYPE_ALT})\\s+records?\\b`, 'gi');

function extractDnsRecords(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  ZONE_LINE_RE.lastIndex = 0;
  let m;
  while ((m = ZONE_LINE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const name = m[1];
    const type = m[3].toUpperCase();
    const value = m[4].trim().slice(0, 80);
    const key = `zone:${name}:${type}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'zone', name, type, value });
    totals[type] = (totals[type] || 0) + 1;
  }

  if (entries.length < MAX_PER_FILE) {
    PROSE_RE.lastIndex = 0;
    while ((m = PROSE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const type = m[1].toUpperCase();
      const key = `prose:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'prose', name: null, type, value: m[0] });
      totals[type] = (totals[type] || 0) + 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SUMMARY_RE.lastIndex = 0;
    while ((m = SUMMARY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const type = m[1].toUpperCase();
      const key = `summary:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'summary', name: null, type, value: m[0] });
      totals[type] = (totals[type] || 0) + 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildDnsRecordsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractDnsRecords(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name || ''}:${e.type}:${e.value || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.type] = (totals[e.type] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderDnsRecordsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DNS RECORDS'];
  const t = report.totals || {};
  const parts = Object.entries(t).sort(([, a], [, b]) => b - a).slice(0, 10).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Top: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      if (e.kind === 'zone') {
        lines.push(`- ${e.type} ${e.name} → ${e.value}`);
      } else {
        lines.push(`- ${e.kind} ${e.type}: ${e.value}`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractDnsRecords,
  buildDnsRecordsForFiles,
  renderDnsRecordsBlock,
};
