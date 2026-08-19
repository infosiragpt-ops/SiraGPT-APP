'use strict';

/**
 * document-signature-block.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SIGNATURE BLOCKS in attached documents — formal sign-off
 * sections at the end of a contract / SOW / memo. Different from
 * document-metadata-extractor (single "Signed by:" line near the
 * top): this module captures the structured signatory block with
 * Name / Title / Date / Company / Witness rows.
 *
 * Heuristic: scans the TAIL portion of the document for a span that
 * contains either a horizontal line of underscores ("____________")
 * OR the literal "Signature:", AND at least one of "Name:", "Title:",
 * "Date:", "By:", "Witnessed by:" / their Spanish equivalents.
 *
 * Each captured block carries the lines verbatim so the chat can echo
 * them when asked "who signed this and on behalf of whom?".
 *
 * Public API:
 *   extractSignatureBlocks(text)         → SignatureReport
 *   buildSignaturesForFiles(files)       → { perFile, aggregate }
 *   renderSignaturesBlock(report)        → markdown string ('' OK)
 */

const TAIL_SCAN_BYTES = 8_000;
const MAX_BLOCKS_PER_FILE = 6;
const MAX_BLOCK_CHARS = 3600;
const MIN_BLOCK_LINES = 2;
const MAX_BLOCK_LINES = 14;
const MAX_LINE_LEN = 140;

const ANCHOR_PATTERNS = [
  /(?:^|\n)\s*_{6,}\s*$/m,                  // long underscore line
  /^\s*Signature\s*:/im,
  /^\s*Firma\s*:/im,
  /^\s*By\s*:/im,
  /^\s*Por\s*:/im,
];

const FIELD_PATTERNS = [
  /\bName\s*:/i,
  /\bNombre\s*:/i,
  /\bTitle\s*:/i,
  /\bCargo\s*:/i,
  /\bDate\s*:/i,
  /\bFecha\s*:/i,
  /\bCompany\s*:/i,
  /\bEmpresa\s*:/i,
  /\bWitnessed\s+by\s*:/i,
  /\bTestigo\s*:/i,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_LINE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function hasAnchor(snippet) {
  return ANCHOR_PATTERNS.some((re) => re.test(snippet));
}

function fieldHitCount(snippet) {
  let hits = 0;
  for (const re of FIELD_PATTERNS) if (re.test(snippet)) hits++;
  return hits;
}

function gatherBlocks(text) {
  const tail = text.length > TAIL_SCAN_BYTES ? text.slice(-TAIL_SCAN_BYTES) : text;
  const lines = tail.split(/\r?\n/).map((l) => l.trimEnd());
  const blocks = [];
  let buffer = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const empty = line.trim().length === 0;
    if (empty) {
      if (buffer.length >= MIN_BLOCK_LINES && buffer.length <= MAX_BLOCK_LINES) {
        blocks.push(buffer.slice());
      }
      buffer = [];
    } else {
      buffer.push(line);
    }
    if (buffer.length > MAX_BLOCK_LINES) buffer.shift();
  }
  if (buffer.length >= MIN_BLOCK_LINES) blocks.push(buffer);
  return blocks;
}

function extractSignatureBlocks(input) {
  const text = safeText(input);
  if (!text) return { blocks: [], total: 0 };
  const rawBlocks = gatherBlocks(text);
  const captured = [];
  for (const lines of rawBlocks) {
    if (captured.length >= MAX_BLOCKS_PER_FILE) break;
    const snippet = lines.join('\n');
    if (!hasAnchor(snippet) && fieldHitCount(snippet) < 2) continue;
    captured.push({
      lines: lines.map((l) => clip(l)),
      fieldHits: fieldHitCount(snippet),
      hasAnchor: hasAnchor(snippet),
    });
  }
  return { blocks: captured, total: captured.length };
}

function buildSignaturesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractSignatureBlocks(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, blocks: r.blocks });
    aggregate = aggregate.concat(r.blocks.map((b) => ({ ...b, file: name })));
  }
  return { perFile, aggregate };
}

function renderBlock(b, opts = {}) {
  const fileTag = opts.includeFile && b.file ? ` _(${b.file})_` : '';
  const body = b.lines.map((l) => `  > ${l}`).join('\n');
  return `**Signature block${fileTag}** _(${b.fieldHits} field hit${b.fieldHits === 1 ? '' : 's'}, anchor: ${b.hasAnchor ? 'yes' : 'no'})_:\n${body}`;
}

function renderSignaturesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## SIGNATURE BLOCKS
Sign-off sections detected near the tail of the attached document(s) — Name / Title / Date / Company / Witness rows. Use this block to answer "who signed this and on behalf of whom?" — quote the verbatim lines before claiming a signature was effective.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const b of only.blocks) sections.push(renderBlock(b));
  } else {
    for (const p of report.perFile) {
      sections.push(`### File: ${p.file}`);
      for (const b of p.blocks) sections.push(renderBlock(b));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...signature block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSignatureBlocks,
  buildSignaturesForFiles,
  renderSignaturesBlock,
  _internal: {
    hasAnchor,
    fieldHitCount,
    gatherBlocks,
    ANCHOR_PATTERNS,
    FIELD_PATTERNS,
    TAIL_SCAN_BYTES,
  },
};
