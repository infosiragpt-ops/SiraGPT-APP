'use strict';

/**
 * document-file-sizes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects file/data size references in docs (release notes, perf reports,
 * runbooks, capacity plans):
 *
 *   - "1.5 GB", "500 MB", "100KB", "2.3 TiB"
 *   - SI vs IEC: KB/MB/GB/TB (decimal 1000-based) and KiB/MiB/GiB/TiB
 *     (binary 1024-based)
 *   - Bytes/bits: 500 bytes, 100 bits
 *   - Spanish "GB" / "MiB" usage same as English
 *
 * Different from document-cross-numeric (generic units) by focusing on
 * byte-related units + parsed value. Routes "how big?" / "what size?" /
 * "what's the capacity?" to a citeable list.
 *
 * Public API:
 *   extractFileSizes(text)         → FileSizeReport
 *   buildFileSizesForFiles(files)  → { perFile, aggregate, totals }
 *   renderFileSizesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 40;

// Decimal SI: B (with leading number), KB, MB, GB, TB, PB
// Binary IEC: KiB, MiB, GiB, TiB, PiB
// Bits with explicit b: Kb, Mb, Gb, Kbit, Mbit
const SIZE_RE = /(?:^|[\s`'"<>(,;:])(\d{1,4}(?:[.,]\d{1,4})?)\s*((?:K|M|G|T|P|E)i?B|(?:K|M|G|T)i?bit|(?:K|M|G|T)bps|bytes?|bits?)\b/gi;

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

function normaliseUnit(u) {
  const s = String(u || '').trim();
  // Keep original casing but unify "bytes" → "B", "bits" → "b"
  if (/^bytes?$/i.test(s)) return 'B';
  if (/^bits?$/i.test(s)) return 'b';
  return s;
}

function unitFamily(u) {
  const s = normaliseUnit(u);
  if (/^(K|M|G|T|P|E)iB$/.test(s) || /^B$/.test(s)) return 'bytes';
  if (/^(K|M|G|T|P|E)B$/.test(s)) return 'bytes';
  if (/^(K|M|G|T)i?bit$/i.test(s) || s === 'b') return 'bits';
  if (/^(K|M|G|T)bps$/i.test(s)) return 'bandwidth';
  return 'other';
}

function isBinary(u) {
  return /i(B|bit)$/i.test(u);
}

function emptyTotals() {
  return { bytes: 0, bits: 0, bandwidth: 0, other: 0 };
}

function extractFileSizes(input) {
  const text = safeText(input);
  if (!text) return { sizes: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sizes = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const m of head.matchAll(SIZE_RE)) {
    if (sizes.length >= MAX_PER_FILE) break;
    const value = clipValue(m[1]);
    const unit = normaliseUnit(m[2]);
    const family = unitFamily(unit);
    const binary = isBinary(unit);
    const key = `${value}|${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push({ value, unit, family, binary });
    totals[family] = (totals[family] || 0) + 1;
  }

  return { sizes, total: sizes.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildFileSizesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractFileSizes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, sizes: r.sizes, totals: r.totals });
    aggregate = aggregate.concat(r.sizes.map((s) => ({ ...s, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k] || 0;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderSize(s, opts = {}) {
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  const bin = s.binary ? ' _(binary)_' : '';
  return `- **${s.value} ${s.unit}**${bin} [${s.family}]${file}`;
}

function renderFileSizesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## FILE / DATA SIZES
Byte / bit size references detected in the document(s): SI decimal (KB / MB / GB / TB / PB / EB) and IEC binary (KiB / MiB / GiB / TiB / PiB), plus bandwidth units (Kbit / Mbps / Gbit). Tagged with family (bytes / bits / bandwidth) and binary flag. Routes "how big?" / "what size?" / "what's the capacity?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.sizes) sections.push(renderSize(s));
  } else {
    sections.push('### Aggregate sizes across all files');
    for (const s of report.aggregate) sections.push(renderSize(s, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.sizes) sections.push(renderSize(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...file sizes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFileSizes,
  buildFileSizesForFiles,
  renderFileSizesBlock,
  _internal: {
    SIZE_RE,
    normaliseUnit,
    unitFamily,
    isBinary,
  },
};
