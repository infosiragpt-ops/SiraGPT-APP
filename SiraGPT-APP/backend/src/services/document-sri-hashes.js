'use strict';

/**
 * document-sri-hashes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Subresource Integrity (SRI) hash attributes on <script> / <link> tags
 * and standalone hash strings:
 *
 *   - integrity="sha256-…"
 *   - integrity="sha384-…"
 *   - integrity="sha512-…"
 *   - crossorigin attribute presence
 *   - raw sha256-/sha384-/sha512- prefixed base64 strings
 *
 * Hash values are MASKED in output (first 8 + last 6 chars) — full hashes are
 * never echoed.
 *
 * Public API:
 *   extractSriHashes(text)             → { entries, totals, total }
 *   buildSriHashesForFiles(files)      → { perFile, aggregate, totals }
 *   renderSriHashesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

// integrity="sha256-base64string" (sometimes with multiple space-separated hashes)
const INTEGRITY_RE = /\bintegrity\s*=\s*["']((?:sha(?:256|384|512)-[A-Za-z0-9+/=]{20,200}\s*){1,5})["']/g;
// standalone hash strings
const STANDALONE_RE = /\b(sha(?:256|384|512))-([A-Za-z0-9+/=]{20,200})\b/g;
const CROSSORIGIN_RE = /\bcrossorigin\s*=\s*["']?(anonymous|use-credentials)/g;
const SCRIPT_TAG_RE = /<script\b[^>]*\bintegrity\s*=/gi;
const LINK_TAG_RE = /<link\b[^>]*\bintegrity\s*=/gi;

function maskHash(hash) {
  if (!hash) return '';
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function extractSriHashes(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { sha256: 0, sha384: 0, sha512: 0, scriptTag: 0, linkTag: 0, crossorigin: 0 };

  function pushHash(algo, hash, source) {
    const masked = maskHash(hash);
    const key = `${algo}:${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ algo, hash: masked, source });
    if (totals[algo] != null) totals[algo] += 1;
  }

  INTEGRITY_RE.lastIndex = 0;
  let m;
  while ((m = INTEGRITY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const all = m[1].trim().split(/\s+/);
    for (const single of all) {
      if (entries.length >= MAX_PER_FILE) break;
      const dash = single.indexOf('-');
      if (dash < 0) continue;
      const algo = single.slice(0, dash);
      const hash = single.slice(dash + 1);
      pushHash(algo, hash, 'integrity');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    STANDALONE_RE.lastIndex = 0;
    while ((m = STANDALONE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      pushHash(m[1], m[2], 'standalone');
    }
  }

  let scriptCount = 0;
  SCRIPT_TAG_RE.lastIndex = 0;
  while (SCRIPT_TAG_RE.exec(body) && scriptCount < 20) scriptCount += 1;
  totals.scriptTag = scriptCount;

  let linkCount = 0;
  LINK_TAG_RE.lastIndex = 0;
  while (LINK_TAG_RE.exec(body) && linkCount < 20) linkCount += 1;
  totals.linkTag = linkCount;

  CROSSORIGIN_RE.lastIndex = 0;
  const crossSeen = new Set();
  while ((m = CROSSORIGIN_RE.exec(body))) {
    if (crossSeen.has(m[1])) continue;
    crossSeen.add(m[1]);
    if (entries.length < MAX_PER_FILE) {
      entries.push({ algo: 'crossorigin', hash: m[1], source: 'attribute' });
    }
    totals.crossorigin += 1;
  }

  return { entries, totals, total: entries.length };
}

function buildSriHashesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { sha256: 0, sha384: 0, sha512: 0, scriptTag: 0, linkTag: 0, crossorigin: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSriHashes(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.algo}:${e.hash}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.algo] != null) totals[e.algo] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderSriHashesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SRI (SUBRESOURCE INTEGRITY) HASHES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.source}] \`${e.algo}-${e.hash}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSriHashes,
  buildSriHashesForFiles,
  renderSriHashesBlock,
  _internal: { maskHash },
};
