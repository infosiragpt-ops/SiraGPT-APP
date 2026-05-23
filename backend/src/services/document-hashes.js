'use strict';

/**
 * document-hashes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects cryptographic hash digests in documents (release notes,
 * security advisories, incident reports):
 *
 *   - MD5 (32 hex chars)
 *   - SHA-1 (40 hex chars)
 *   - SHA-224 (56)
 *   - SHA-256 (64)
 *   - SHA-384 (96)
 *   - SHA-512 (128)
 *   - BLAKE2b/BLAKE3 (variable)
 *
 * Output classifies by length and optional preceding label hint.
 * Routes "what's the hash?" / "verify integrity" to a citeable list.
 *
 * Public API:
 *   extractHashes(text)         → HashReport
 *   buildHashesForFiles(files)  → { perFile, aggregate, byKind }
 *   renderHashesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_KIND = 8;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

// Lengths
const KIND_BY_LEN = {
  32: 'MD5',
  40: 'SHA-1',
  56: 'SHA-224',
  64: 'SHA-256',
  96: 'SHA-384',
  128: 'SHA-512',
};

// Hex with optional preceding label
const HASH_RE = /(?:^|[\s`'"<>(,;:])((?:MD5|SHA[\s\-]?(?:1|224|256|384|512)|BLAKE2(?:b|s)?|BLAKE3)?\s*[:=]?\s*)([0-9a-fA-F]{32,128})(?=[\s`'"<>):,;.!?]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function classifyHash(hex, label) {
  const len = hex.length;
  if (KIND_BY_LEN[len]) return KIND_BY_LEN[len];
  if (label && /BLAKE/i.test(label)) return 'BLAKE';
  return `unknown-${len}`;
}

function emptyByKind() {
  return {};
}

function extractHashes(input) {
  const text = safeText(input);
  if (!text) return { hashes: [], total: 0, byKind: emptyByKind(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const hashes = [];
  const seen = new Set();
  const byKind = emptyByKind();

  for (const m of head.matchAll(HASH_RE)) {
    if (hashes.length >= MAX_PER_FILE) break;
    const label = (m[1] || '').trim();
    const hex = m[2].toLowerCase();
    const kind = classifyHash(hex, label);
    if (byKind[kind] && byKind[kind] >= MAX_PER_KIND) continue;
    const key = `${kind}|${hex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hashes.push({ kind, hex, length: hex.length });
    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  return { hashes, total: hashes.length, byKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHashesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byKind = {};
  for (const f of list) {
    const r = extractHashes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, hashes: r.hashes, byKind: r.byKind });
    aggregate = aggregate.concat(r.hashes.map((h) => ({ ...h, file: name })));
    for (const k of Object.keys(r.byKind)) byKind[k] = (byKind[k] || 0) + r.byKind[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byKind };
}

function renderHash(h, opts = {}) {
  const file = opts.includeFile && h.file ? ` _(${h.file})_` : '';
  const short = h.hex.length > 24 ? `${h.hex.slice(0, 12)}…${h.hex.slice(-8)}` : h.hex;
  return `- [${h.kind}] \`${short}\` (${h.length} hex)${file}`;
}

function renderHashesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byKind = report.byKind || {};
  const breakdown = Object.keys(byKind)
    .filter((k) => byKind[k] > 0)
    .map((k) => `${k}=${byKind[k]}`)
    .join('  ');
  const heading = `## CRYPTOGRAPHIC HASHES
Hex digests detected in the document(s) and classified by length: MD5 (32 hex), SHA-1 (40), SHA-224 (56), SHA-256 (64), SHA-384 (96), SHA-512 (128), BLAKE2/BLAKE3. Hex values are abbreviated (first 12 + last 8 chars) in render for readability. Routes "what's the hash?" / "verify integrity" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const h of only.hashes) sections.push(renderHash(h));
  } else {
    sections.push('### Aggregate hashes across all files');
    for (const h of report.aggregate) sections.push(renderHash(h, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const h of p.hashes) sections.push(renderHash(h));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...hashes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHashes,
  buildHashesForFiles,
  renderHashesBlock,
  _internal: {
    HASH_RE,
    KIND_BY_LEN,
    classifyHash,
  },
};
