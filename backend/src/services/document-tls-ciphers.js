'use strict';

/**
 * document-tls-ciphers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects TLS cipher suite identifiers:
 *
 *   - IANA TLS 1.3:   TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256
 *   - OpenSSL TLS 1.2: ECDHE-RSA-AES256-GCM-SHA384
 *   - Weak / legacy:  RC4, DES, EXPORT, NULL
 *
 * Classifies into: tls13 / modern / legacy / weak.
 *
 * Public API:
 *   extractTlsCiphers(text)             → { entries, totals, total }
 *   buildTlsCiphersForFiles(files)      → { perFile, aggregate, totals }
 *   renderTlsCiphersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const IANA_RE = /\b(TLS_(?:AES_(?:128|256)_(?:GCM|CCM(?:_8)?)_SHA(?:256|384)|CHACHA20_POLY1305_SHA256|ECDHE_(?:ECDSA|RSA)_WITH_AES_(?:128|256)_(?:GCM_SHA(?:256|384)|CBC_SHA(?:256)?)|DHE_RSA_WITH_AES_(?:128|256)_(?:GCM_SHA(?:256|384)|CBC_SHA(?:256)?)|RSA_WITH_AES_(?:128|256)_(?:GCM_SHA(?:256|384)|CBC_SHA(?:256)?)))\b/g;
const OPENSSL_RE = /\b((?:ECDHE|DHE|TLS_AES)[-_](?:ECDSA[-_]|RSA[-_])?(?:AES(?:128|256)|CHACHA20)[-_](?:GCM[-_]SHA(?:256|384)|POLY1305[-_]SHA256|SHA(?:256)?))\b/g;

const WEAK_TERMS = ['RC4', 'DES-CBC', '3DES', 'EXPORT', 'NULL-SHA', 'eNULL', 'aNULL', 'IDEA', 'MD5', 'EXP-'];
const WEAK_RE = new RegExp(`\\b(${WEAK_TERMS.join('|')})\\b`, 'gi');

function classifyCipher(name) {
  if (/^TLS_AES_(?:128|256)_GCM_SHA|^TLS_CHACHA20/.test(name)) return 'tls13';
  if (/ECDHE.*GCM|ECDHE.*CHACHA20|DHE.*GCM/.test(name)) return 'modern';
  if (/RSA_WITH_AES/i.test(name) || /^AES/i.test(name)) return 'legacy';
  return 'other';
}

function extractTlsCiphers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { tls13: 0, modern: 0, legacy: 0, weak: 0, other: 0 };

  function push(cipher, kind, source) {
    const key = `${cipher}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ cipher, kind, source });
    if (totals[kind] != null) totals[kind] += 1;
  }

  IANA_RE.lastIndex = 0;
  let m;
  while ((m = IANA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], classifyCipher(m[1]), 'iana');
  }
  if (entries.length < MAX_PER_FILE) {
    OPENSSL_RE.lastIndex = 0;
    while ((m = OPENSSL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], classifyCipher(m[1]), 'openssl');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    WEAK_RE.lastIndex = 0;
    while ((m = WEAK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'weak', 'weak-term');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildTlsCiphersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { tls13: 0, modern: 0, legacy: 0, weak: 0, other: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTlsCiphers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.cipher)) continue;
      aggSeen.add(e.cipher);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderTlsCiphersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TLS CIPHER SUITES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] ${e.cipher} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTlsCiphers,
  buildTlsCiphersForFiles,
  renderTlsCiphersBlock,
  _internal: { classifyCipher },
};
