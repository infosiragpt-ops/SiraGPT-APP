'use strict';

/**
 * document-tlds.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Counts top-level domains across the document. Distinct from
 * document-domains.js which lists unique hostnames — this aggregates by TLD
 * to surface "this doc is full of .gov references" or "82% .com".
 *
 * Classifies into:
 *   - generic (gTLD): com, org, net, info, biz
 *   - sponsored: gov, edu, mil, int
 *   - new gTLD:  io, ai, app, dev, xyz, tech, online, store, …
 *   - country (ccTLD): us, uk, de, fr, es, mx, br, jp, cn, …
 *
 * Public API:
 *   extractTlds(text)             → { entries, totals, total }
 *   buildTldsForFiles(files)      → { perFile, aggregate, totals }
 *   renderTldsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const HOSTNAME_RE = /\b(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+)\b/gi;

const SPONSORED = new Set(['gov', 'edu', 'mil', 'int']);
const GENERIC = new Set(['com', 'org', 'net', 'info', 'biz', 'name', 'mobi', 'pro']);
const NEW_GTLD = new Set([
  'io', 'ai', 'app', 'dev', 'xyz', 'tech', 'online', 'store', 'site', 'cloud',
  'design', 'blog', 'news', 'media', 'studio', 'company', 'agency', 'codes',
  'tools', 'systems', 'works', 'engineering', 'careers', 'finance', 'capital',
  'one', 'top', 'pro', 'plus', 'today', 'world', 'global', 'group', 'team',
  'social', 'video', 'audio', 'photo', 'photography', 'shop',
]);

function classifyTld(tld) {
  const lower = tld.toLowerCase();
  if (SPONSORED.has(lower)) return 'sponsored';
  if (GENERIC.has(lower)) return 'generic';
  if (NEW_GTLD.has(lower)) return 'new-gtld';
  if (lower.length === 2) return 'country';
  return 'other';
}

function extractTldFromHost(host) {
  // Find last `.X` segment
  const parts = host.split('.');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].toLowerCase();
  if (last.length < 2 || last.length > 20) return null;
  if (!/^[a-z]+$/.test(last)) return null;
  return last;
}

function extractTlds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tldCounts = {};
  const seenHosts = new Set();

  HOSTNAME_RE.lastIndex = 0;
  let m;
  while ((m = HOSTNAME_RE.exec(body))) {
    const host = m[1].toLowerCase();
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    if (seenHosts.size > 5000) break;
    const tld = extractTldFromHost(host);
    if (!tld) continue;
    tldCounts[tld] = (tldCounts[tld] || 0) + 1;
  }

  const entries = Object.entries(tldCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_PER_FILE)
    .map(([tld, count]) => ({ tld, count, kind: classifyTld(tld) }));

  const totals = { sponsored: 0, generic: 0, 'new-gtld': 0, country: 0, other: 0 };
  for (const e of entries) {
    if (totals[e.kind] != null) totals[e.kind] += e.count;
  }

  return { entries, totals, total: entries.length };
}

function buildTldsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggregate = {};
  const totals = { sponsored: 0, generic: 0, 'new-gtld': 0, country: 0, other: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTlds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      aggregate[e.tld] = (aggregate[e.tld] || 0) + e.count;
      if (totals[e.kind] != null) totals[e.kind] += e.count;
    }
  }
  const aggregateEntries = Object.entries(aggregate)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_AGGREGATE)
    .map(([tld, count]) => ({ tld, count, kind: classifyTld(tld) }));
  return { perFile, aggregate: aggregateEntries, totals };
}

function renderTldsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TOP-LEVEL DOMAIN CENSUS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals by kind: ${parts.join(', ')}`);
  if (report.aggregate && report.aggregate.length) {
    const top = report.aggregate.slice(0, 12).map((e) => `.${e.tld}×${e.count}`).join(', ');
    lines.push(`- Top TLDs: ${top}`);
  }
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- .${e.tld} (${e.kind}): ${e.count}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTlds,
  buildTldsForFiles,
  renderTldsBlock,
  _internal: { classifyTld, extractTldFromHost },
};
