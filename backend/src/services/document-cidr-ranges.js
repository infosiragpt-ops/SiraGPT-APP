'use strict';

/**
 * document-cidr-ranges.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects CIDR network ranges and classifies private vs public per RFC 1918,
 * loopback, link-local, multicast, and reserved.
 *
 * Targets IPv4 CIDR (a.b.c.d/N) and IPv6 CIDR (xx:xx::/N).
 *
 * Public API:
 *   extractCidrRanges(text)             → { entries, totals, total }
 *   buildCidrRangesForFiles(files)      → { perFile, aggregate, totals }
 *   renderCidrRangesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const IPV4_CIDR_RE = /\b((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})\b/g;
const IPV6_CIDR_RE = /\b([0-9a-f:]{2,40})\/(\d{1,3})\b/gi;

function isValidIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d+$/.test(p)) return false;
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

function classifyIPv4(ip, prefix) {
  if (!isValidIPv4(ip)) return null;
  const p = parseInt(prefix, 10);
  if (p < 0 || p > 32) return null;
  const o = ip.split('.').map(Number);
  if (o[0] === 10) return 'private';
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 'private';
  if (o[0] === 192 && o[1] === 168) return 'private';
  if (o[0] === 127) return 'loopback';
  if (o[0] === 169 && o[1] === 254) return 'link-local';
  if (o[0] >= 224 && o[0] <= 239) return 'multicast';
  if (o[0] === 0) return 'reserved';
  if (o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255) return 'broadcast';
  if (o[0] >= 240) return 'reserved';
  return 'public';
}

function classifyIPv6(ip, prefix) {
  const p = parseInt(prefix, 10);
  if (p < 0 || p > 128) return null;
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return 'loopback';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'ula';
  if (lower.startsWith('fe80')) return 'link-local';
  if (lower.startsWith('ff')) return 'multicast';
  if (lower.startsWith('2001:db8')) return 'documentation';
  return 'public';
}

function looksLikeIPv6(s) {
  if (!s) return false;
  if (!/:/.test(s)) return false;
  if (s.split(':').length < 2) return false;
  if (!/[0-9a-f]/i.test(s)) return false;
  return /^[0-9a-f:]+$/i.test(s);
}

function extractCidrRanges(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { private: 0, public: 0, loopback: 0, 'link-local': 0, multicast: 0, reserved: 0, ula: 0, documentation: 0, broadcast: 0 };

  // IPv4
  IPV4_CIDR_RE.lastIndex = 0;
  let m;
  while ((m = IPV4_CIDR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const ip = m[1];
    const prefix = m[2];
    const kind = classifyIPv4(ip, prefix);
    if (!kind) continue;
    const key = `v4:${ip}/${prefix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ family: 'ipv4', cidr: `${ip}/${prefix}`, kind });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // IPv6
  if (entries.length < MAX_PER_FILE) {
    IPV6_CIDR_RE.lastIndex = 0;
    while ((m = IPV6_CIDR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const ip = m[1];
      const prefix = m[2];
      if (!looksLikeIPv6(ip)) continue;
      const kind = classifyIPv6(ip, prefix);
      if (!kind) continue;
      const key = `v6:${ip.toLowerCase()}/${prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ family: 'ipv6', cidr: `${ip}/${prefix}`, kind });
      if (totals[kind] != null) totals[kind] += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCidrRangesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { private: 0, public: 0, loopback: 0, 'link-local': 0, multicast: 0, reserved: 0, ula: 0, documentation: 0, broadcast: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCidrRanges(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.cidr)) continue;
      aggSeen.add(e.cidr);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCidrRangesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CIDR NETWORK RANGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.family} ${e.kind}] \`${e.cidr}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCidrRanges,
  buildCidrRangesForFiles,
  renderCidrRangesBlock,
  _internal: { isValidIPv4, classifyIPv4, classifyIPv6, looksLikeIPv6 },
};
