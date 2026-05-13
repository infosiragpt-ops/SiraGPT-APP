'use strict';

/**
 * document-metadata-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls authoring / version metadata that the document itself stamps
 * (header lines, signatures, version labels). Helps the chat answer
 * "when was this written?", "who signed it?", "what version is this?"
 * without re-scanning raw text.
 *
 * Detected fields (deterministic, bilingual, < 12 ms on 1 MB):
 *
 *   - version         "Version 2.1" / "Versión 3" / "v1.0" / "Rev. 4"
 *   - effective_date  "Effective Date: 2026-05-12" / "Fecha de
 *                     vigencia: …" / "Effective as of …"
 *   - issued_date     "Issued: 2026-05-12" / "Emitido: …"
 *   - revision_date   "Last updated: 2026-05-12" /
 *                     "Última revisión: …" / "Revised: …"
 *   - author          "Author: Jane Smith" / "Autor: …" /
 *                     "Prepared by: …"
 *   - signed_by       "Signed by: …" / "Firmado por: …"
 *   - reference_no    "Document No: ABC-123" / "Referencia: …" /
 *                     "Ticket: …"
 *
 * Public API:
 *   extractMetadata(text)                → MetadataReport
 *   buildMetadataForFiles(files)         → { perFile }
 *   renderMetadataBlock(report)          → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 16_000; // Metadata almost always lives near the top.
const MAX_BLOCK_CHARS = 3000;
const MAX_VALUE_LEN = 120;

const FIELDS = [
  {
    key: 'version',
    patterns: [
      /\b(?:version|versi[oó]n|rev(?:ision)?|revisi[oó]n)\s*[:#-]?\s*([A-Za-z0-9._-]{1,40})/i,
      /\b(?:^|[\s\(])(v\d+(?:\.\d+){0,2}|r\d+(?:\.\d+)?)\b/i,
    ],
  },
  {
    key: 'effective_date',
    patterns: [
      /\b(?:effective\s+date|fecha\s+de\s+vigencia|effective\s+as\s+of|en\s+vigor\s+desde|vigente\s+desde)\s*[:.-]?\s*([0-9A-Za-zÁÉÍÓÚÑáéíóúñ ,\/-]{4,40})/i,
    ],
  },
  {
    key: 'issued_date',
    patterns: [
      /\b(?:issued|emitido|emisi[oó]n|fecha\s+de\s+emisi[oó]n|date\s+of\s+issue)\s*[:.-]?\s*([0-9A-Za-zÁÉÍÓÚÑáéíóúñ ,\/-]{4,40})/i,
    ],
  },
  {
    key: 'revision_date',
    patterns: [
      /\b(?:last\s+(?:updated|revised|modified)|revised|modified|[uú]ltima\s+(?:revisi[oó]n|actualizaci[oó]n|modificaci[oó]n))\s*[:.-]?\s*([0-9A-Za-zÁÉÍÓÚÑáéíóúñ ,\/-]{4,40})/i,
    ],
  },
  {
    key: 'author',
    patterns: [
      /\b(?:author|autor(?:es)?|prepared\s+by|preparado\s+por|written\s+by|escrito\s+por)\s*[:.-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ. ,&]{3,80})/i,
    ],
  },
  {
    key: 'signed_by',
    patterns: [
      /\b(?:signed\s+by|firmado\s+por)\s*[:.-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ. ,&]{3,80})/i,
    ],
  },
  {
    key: 'reference_no',
    patterns: [
      /\b(?:document\s+(?:no\.?|number|n[uú]mero)|reference(?:\s+(?:no\.?|number))?|ref(?:erencia)?(?:\s*n[uú]m\.?)?|ticket|case\s+(?:id|number))\s*[:.-]?\s*([A-Z0-9][A-Z0-9\-_/\.]{0,40})/i,
    ],
  },
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_VALUE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function clean(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').replace(/^[:.\-=#,;]+|[:.\-=#,;]+$/g, '').trim();
}

function extractMetadata(input) {
  const text = safeText(input);
  if (!text) return {};
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const out = {};
  for (const { key, patterns } of FIELDS) {
    for (const re of patterns) {
      const m = head.match(re);
      if (m && m[1]) {
        const val = clean(m[1]);
        if (val.length === 0) continue;
        out[key] = clip(val, MAX_VALUE_LEN);
        break;
      }
    }
  }
  return out;
}

function buildMetadataForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const meta = extractMetadata(safeText(f.extractedText));
    if (Object.keys(meta).length === 0) continue;
    perFile.push({ file: safeFileName(f), metadata: meta });
  }
  return { perFile };
}

function renderMetadataLine(file, meta) {
  const order = ['version', 'effective_date', 'issued_date', 'revision_date', 'author', 'signed_by', 'reference_no'];
  const parts = [];
  for (const k of order) {
    if (meta[k]) parts.push(`${k}: **${meta[k]}**`);
  }
  if (parts.length === 0) return '';
  return `- _${file}_ — ${parts.join(' · ')}`;
}

function renderMetadataBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## DOCUMENT METADATA
Authoring stamps surfaced from each attached document — version, effective / issued / revision dates, author / signer / reference number — when stated by the document itself. Use this to anchor the chat's answer in the document's stated provenance ("the v2.1 version effective 2026-05-12 by Jane Smith says …"). Empty fields mean the document didn't state them.`;
  const lines = report.perFile.map((p) => renderMetadataLine(p.file, p.metadata)).filter(Boolean);
  if (lines.length === 0) return '';
  let combined = `${heading}\n\n${lines.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...metadata block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMetadata,
  buildMetadataForFiles,
  renderMetadataBlock,
  _internal: {
    clean,
    FIELDS,
    SCAN_HEAD_BYTES,
    MAX_VALUE_LEN,
  },
};
