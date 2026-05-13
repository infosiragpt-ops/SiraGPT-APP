'use strict';

/**
 * document-data-classification.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects DATA-CLASSIFICATION labels stamped on attached documents
 * — Confidential / PII / PHI / Public / Internal Use Only /
 * Restricted / Sensitive / Trade Secret / TLP-Red/Amber/Green/White.
 * Routes "is this document confidential?" / "what's the
 * classification?" to citeable labels without inference.
 *
 * Different from document-pii-detector (which finds PII inside body
 * text): this surfaces the DOCUMENT-LEVEL classification label.
 *
 * Public API:
 *   extractClassification(text)            → ClassificationReport
 *   buildClassificationForFiles(files)     → { perFile, aggregate }
 *   renderClassificationBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 6_000; // Labels live at top/bottom; scan small window.
const TAIL_SCAN_BYTES = 6_000;
const MAX_BLOCK_CHARS = 3000;

const LABELS = [
  { kind: 'confidential', patterns: [
    /\bCONFIDENTIAL\b/,
    /\bCONFIDENCIAL\b/,
  ] },
  { kind: 'restricted', patterns: [
    /\bRESTRICTED\b/,
    /\bRESTRINGIDO\b/,
  ] },
  { kind: 'public', patterns: [
    /\bPUBLIC\b/,
    /\bP[UÚ]BLICO\b/,
  ] },
  { kind: 'internal-only', patterns: [
    /\bINTERNAL\s+(?:USE\s+)?ONLY\b/i,
    /\bUSO\s+INTERNO(?:\s+ÚNICAMENTE)?\b/i,
  ] },
  { kind: 'sensitive', patterns: [
    /\bSENSITIVE\b/,
    /\bSENSIBLE\b/,
  ] },
  { kind: 'trade-secret', patterns: [
    /\b(TRADE\s+SECRET|PROPIETARIO)\b/i,
    /\b(SECRETO\s+(?:INDUSTRIAL|COMERCIAL))\b/i,
  ] },
  { kind: 'pii', patterns: [
    /\b(PII|PERSONALLY\s+IDENTIFIABLE\s+INFORMATION|INFORMACI[OÓ]N\s+PERSONAL\s+IDENTIFICABLE)\b/i,
  ] },
  { kind: 'phi', patterns: [
    /\b(PHI|PROTECTED\s+HEALTH\s+INFORMATION|INFORMACI[OÓ]N\s+M[EÉ]DICA\s+PROTEGIDA)\b/i,
  ] },
  { kind: 'tlp-red', patterns: [
    /\bTLP[:\s-]+RED\b/i,
  ] },
  { kind: 'tlp-amber', patterns: [
    /\bTLP[:\s-]+AMBER\b/i,
  ] },
  { kind: 'tlp-green', patterns: [
    /\bTLP[:\s-]+GREEN\b/i,
  ] },
  { kind: 'tlp-white', patterns: [
    /\bTLP[:\s-]+(?:WHITE|CLEAR)\b/i,
  ] },
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function getScanWindow(text) {
  if (!text) return '';
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const tail = text.length > TAIL_SCAN_BYTES ? text.slice(-TAIL_SCAN_BYTES) : '';
  return `${head}\n${tail}`;
}

function extractClassification(input) {
  const text = safeText(input);
  if (!text) return { labels: [], total: 0 };
  const window = getScanWindow(text);
  const found = new Map();
  for (const { kind, patterns } of LABELS) {
    for (const re of patterns) {
      if (re.test(window)) {
        found.set(kind, (found.get(kind) || 0) + 1);
      }
    }
  }
  const labels = Array.from(found.entries()).map(([kind, count]) => ({ kind, mentions: count }));
  return { labels, total: labels.length };
}

function buildClassificationForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  const aggregateCounts = new Map();
  for (const f of list) {
    const r = extractClassification(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, labels: r.labels });
    for (const l of r.labels) aggregateCounts.set(l.kind, (aggregateCounts.get(l.kind) || 0) + l.mentions);
  }
  const aggregate = Array.from(aggregateCounts.entries())
    .map(([kind, mentions]) => ({ kind, mentions }))
    .sort((a, b) => b.mentions - a.mentions);
  return { perFile, aggregate };
}

function renderLine(file, labels) {
  const items = labels.map((l) => `${l.kind} (${l.mentions})`).join(', ');
  return `- _${file}_: ${items}`;
}

function renderClassificationBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## DATA CLASSIFICATION LABELS
Document-level classification stamps surfaced from the head / tail of each attached file — Confidential, Restricted, Public, Internal Use Only, PII, PHI, Trade Secret, TLP Red / Amber / Green / White, etc. Treat these as the source's own handling-policy label and respect their implications (e.g. do not echo PHI or TLP-Red details without authorisation).`;
  const lines = report.perFile.map((p) => renderLine(p.file, p.labels));
  if (report.aggregate.length) {
    lines.unshift(`_Aggregate: ${report.aggregate.map((a) => `${a.kind} (${a.mentions})`).join(', ')}_`);
  }
  let combined = `${heading}\n\n${lines.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...classification block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractClassification,
  buildClassificationForFiles,
  renderClassificationBlock,
  _internal: {
    getScanWindow,
    LABELS,
    SCAN_HEAD_BYTES,
    TAIL_SCAN_BYTES,
  },
};
