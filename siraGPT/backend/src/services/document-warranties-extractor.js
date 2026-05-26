'use strict';

/**
 * document-warranties-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures explicit WARRANTY and REPRESENTATION clauses from
 * commercial / legal documents. Lets the chat answer "what does each
 * party warrant?" / "what representations are made?" with the source
 * sentence intact.
 *
 * Different from document-obligations-extractor (positive obligation /
 * prohibition with deadlines): warranties are STATEMENTS of fact that
 * a party is asserting to be true — and disclaimers of warranty that
 * deny them.
 *
 * Detection coverage (deterministic, bilingual, < 15 ms on 1 MB):
 *
 *   - English:
 *       "warrants and represents", "represents and warrants",
 *       "warrants that", "represents that", "covenants that",
 *       "express warranty", "implied warranty", "as-is", "without
 *       warranty", "disclaim(s|s any) warranty".
 *   - Spanish:
 *       "garantiza que", "declara y garantiza", "manifiesta que",
 *       "asegura que", "se otorga sin garantía", "sin garantía",
 *       "renuncia a (toda|cualquier) garantía".
 *
 * Each entry is tagged "warranty" or "disclaimer".
 *
 * Public API:
 *   extractWarranties(text)               → WarrantyReport
 *   buildWarrantiesForFiles(files)        → { perFile, aggregate }
 *   renderWarrantiesBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const WARRANTY_PATTERNS_EN = [
  /\b(warrants?\s+and\s+represents?|represents?\s+and\s+warrants?|warrants?\s+that|represents?\s+that|covenants?\s+that|guarantees?\s+that|express(?:ly)?\s+warrants?|implied\s+warrant(?:y|ies))\b/i,
];

const WARRANTY_PATTERNS_ES = [
  /(?:^|[^\p{L}])(garantiza(?:n)?\s+que|declara(?:n)?\s+y\s+garantiza(?:n)?|garantiza(?:n)?\s+y\s+declara(?:n)?|manifiesta(?:n)?\s+que|asegura(?:n)?\s+que|otorga(?:n)?\s+garant[ií]a)(?=[^\p{L}]|$)/iu,
];

const DISCLAIMER_PATTERNS_EN = [
  /\b(disclaims?\s+(?:any|all)?\s*warrant(?:y|ies)|without\s+warrant(?:y|ies)|"?as[\s-]is"?|as[\s-]is\s+basis|no\s+warrant(?:y|ies)|no\s+express\s+or\s+implied\s+warrant(?:y|ies))\b/i,
];

const DISCLAIMER_PATTERNS_ES = [
  /(?:^|[^\p{L}])(sin\s+garant[ií]a|renuncia\s+a\s+(?:toda|cualquier)\s+garant[ií]a|"?tal\s+cual"?|en\s+su\s+estado\s+actual|sin\s+garant[ií]as\s+expresas\s+o\s+impl[ií]citas)(?=[^\p{L}]|$)/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function matchAny(sentence, patterns) {
  for (const re of patterns) if (re.test(sentence)) return true;
  return false;
}

function extractWarranties(input) {
  const text = safeText(input);
  if (!text) return { warranties: [], disclaimers: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const warranties = [];
  const disclaimers = [];
  const seen = new Set();
  for (const s of sentences) {
    if (warranties.length >= MAX_PER_FILE && disclaimers.length >= MAX_PER_FILE) break;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    // Disclaimers checked first so "without warranty" doesn't get classified
    // as a positive warranty just because it contains "warranty".
    if (matchAny(s, DISCLAIMER_PATTERNS_EN) || matchAny(s, DISCLAIMER_PATTERNS_ES)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (disclaimers.length < MAX_PER_FILE) disclaimers.push({ sentence: clipped, kind: 'disclaimer' });
      continue;
    }
    if (matchAny(s, WARRANTY_PATTERNS_EN) || matchAny(s, WARRANTY_PATTERNS_ES)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (warranties.length < MAX_PER_FILE) warranties.push({ sentence: clipped, kind: 'warranty' });
    }
  }
  return {
    warranties,
    disclaimers,
    total: warranties.length + disclaimers.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildWarrantiesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = { warranties: [], disclaimers: [] };
  for (const f of list) {
    const r = extractWarranties(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate.warranties = aggregate.warranties.concat(r.warranties.map((w) => ({ ...w, file: name })));
    aggregate.disclaimers = aggregate.disclaimers.concat(r.disclaimers.map((w) => ({ ...w, file: name })));
  }
  aggregate.warranties = aggregate.warranties.slice(0, MAX_AGGREGATE);
  aggregate.disclaimers = aggregate.disclaimers.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const tag = item.kind === 'disclaimer' ? 'DISCLAIMER' : 'WARRANTY';
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**${tag}**]${file} ${item.sentence}`;
}

function renderWarrantiesBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## WARRANTIES & DISCLAIMERS
Express warranties and warranty disclaimers surfaced from the attached document(s). Use this block to answer "what does each party warrant?" / "what disclaimers apply?" — quote the source sentence verbatim before claiming a warranty is enforceable.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    if (only.report.warranties.length) {
      sections.push('**Warranties**');
      for (const w of only.report.warranties) sections.push(renderLine(w));
    }
    if (only.report.disclaimers.length) {
      sections.push('\n**Disclaimers**');
      for (const w of only.report.disclaimers) sections.push(renderLine(w));
    }
  } else {
    if (batchReport.aggregate.warranties.length) {
      sections.push('### Aggregate warranties');
      for (const w of batchReport.aggregate.warranties) sections.push(renderLine(w, { includeFile: true }));
    }
    if (batchReport.aggregate.disclaimers.length) {
      sections.push('\n### Aggregate disclaimers');
      for (const w of batchReport.aggregate.disclaimers) sections.push(renderLine(w, { includeFile: true }));
    }
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      if (p.report.warranties.length) {
        sections.push('**Warranties**');
        for (const w of p.report.warranties) sections.push(renderLine(w));
      }
      if (p.report.disclaimers.length) {
        sections.push('**Disclaimers**');
        for (const w of p.report.disclaimers) sections.push(renderLine(w));
      }
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...warranties block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractWarranties,
  buildWarrantiesForFiles,
  renderWarrantiesBlock,
  _internal: {
    splitSentences,
    matchAny,
    WARRANTY_PATTERNS_EN,
    WARRANTY_PATTERNS_ES,
    DISCLAIMER_PATTERNS_EN,
    DISCLAIMER_PATTERNS_ES,
  },
};
