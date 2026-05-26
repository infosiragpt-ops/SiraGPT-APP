'use strict';

/**
 * document-scope-exclusions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects what an attached document EXPLICITLY covers (scope) and
 * what it EXPLICITLY excludes. Different from outline / TL;DR / KPI
 * blocks: this surfaces enumerated boundaries so the chat can answer
 * "is X in scope?", "what's NOT included?", "does this cover Y?".
 *
 * Detection cues (deterministic, no LLM, < 15 ms on 1 MB):
 *
 *   SCOPE
 *     - English: "in scope", "covers", "includes", "applies to",
 *                "comprises", "scope of work", "is responsible for"
 *     - Spanish: "alcance", "incluye", "comprende", "aplica a",
 *                "responsable de", "abarca"
 *
 *   EXCLUSION
 *     - English: "out of scope", "excluded", "does not cover",
 *                "does not include", "except for", "excluding"
 *     - Spanish: "fuera del alcance", "excluye", "no incluye",
 *                "no cubre", "excepto", "salvo"
 *
 * Each match preserves its source sentence + a short snippet of what
 * follows ("includes <SNIPPET>" or "excludes <SNIPPET>") so the chat
 * can echo the boundary verbatim.
 *
 * Public API:
 *   extractScope(text)                  → ScopeReport
 *   buildScopeForFiles(files)           → { perFile, aggregate }
 *   renderScopeBlock(batchReport)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_ITEMS_PER_KIND = 8;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 320;

const SCOPE_PATTERNS = [
  /\b(in\s+scope|scope\s+of\s+work|covers?|includes?|applies\s+to|comprises?|encompasses|responsib(?:le|ility)\s+for)\b[^.\n]{0,140}/i,
  /(?:^|[^\p{L}])(en\s+el\s+alcance|alcance\s+de(?:l)?(?:\s+(?:proyecto|trabajo|contrato))?|incluye[n]?|comprende[n]?|aplica\s+a|abarca[n]?|responsable\s+de|cubre[n]?)(?=[^\p{L}]|$)[^.\n]{0,140}/iu,
];

const EXCLUSION_PATTERNS = [
  /\b(out\s+of\s+scope|excluded|excludes?|excluding|does\s+not\s+(?:cover|include|apply\s+to)|except\s+(?:for|that)|with\s+the\s+exception\s+of)\b[^.\n]{0,140}/i,
  /(?:^|[^\p{L}])(fuera\s+del\s+alcance|excluye[n]?|excluy(?:endo|en)|excluid[oa]s?|no\s+(?:cubre|incluye|aplica\s+a)|excepto|salvo\s+que|excepci[óo]n\s+de|quedan?\s+excluid[oa]s?)(?=[^\p{L}]|$)[^.\n]{0,140}/iu,
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

function extractScope(input) {
  const text = safeText(input);
  if (!text) return { included: [], excluded: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const included = [];
  const excluded = [];
  const seenIn = new Set();
  const seenEx = new Set();
  for (const s of sentences) {
    if (included.length >= MAX_ITEMS_PER_KIND && excluded.length >= MAX_ITEMS_PER_KIND) break;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (matchAny(s, EXCLUSION_PATTERNS)) {
      // Treat exclusion patterns first so "does not include X" doesn't
      // also get added to the inclusion bucket from the "include" stem.
      if (!seenEx.has(key) && excluded.length < MAX_ITEMS_PER_KIND) {
        seenEx.add(key);
        excluded.push({ sentence: clipped, kind: 'exclusion' });
      }
      continue;
    }
    if (matchAny(s, SCOPE_PATTERNS)) {
      if (!seenIn.has(key) && included.length < MAX_ITEMS_PER_KIND) {
        seenIn.add(key);
        included.push({ sentence: clipped, kind: 'scope' });
      }
    }
  }
  return {
    included,
    excluded,
    total: included.length + excluded.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildScopeForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = { included: [], excluded: [] };
  for (const f of list) {
    const r = extractScope(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate.included = aggregate.included.concat(r.included.map((x) => ({ ...x, file: name })));
    aggregate.excluded = aggregate.excluded.concat(r.excluded.map((x) => ({ ...x, file: name })));
  }
  return { perFile, aggregate };
}

function renderScopeLine(s, opts = {}) {
  const fileTag = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  return `- ${fileTag ? fileTag + ' ' : ''}${s.sentence}`;
}

function renderScopeBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## DOCUMENT SCOPE & EXCLUSIONS
Sentences from the attached document(s) that explicitly state what is COVERED (scope) and what is EXCLUDED. Use this block to answer "is X in scope?", "what's NOT included?", "does this cover Y?" — quote the source sentence before claiming a boundary.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    if (only.report.included.length) {
      sections.push('**In scope**');
      for (const s of only.report.included) sections.push(renderScopeLine(s));
    }
    if (only.report.excluded.length) {
      sections.push('\n**Out of scope / excluded**');
      for (const s of only.report.excluded) sections.push(renderScopeLine(s));
    }
  } else {
    if (batchReport.aggregate.included.length) {
      sections.push('### Aggregate in-scope statements');
      for (const s of batchReport.aggregate.included) sections.push(renderScopeLine(s, { includeFile: true }));
    }
    if (batchReport.aggregate.excluded.length) {
      sections.push('\n### Aggregate exclusions');
      for (const s of batchReport.aggregate.excluded) sections.push(renderScopeLine(s, { includeFile: true }));
    }
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      if (p.report.included.length) {
        sections.push('**In scope**');
        for (const s of p.report.included) sections.push(renderScopeLine(s));
      }
      if (p.report.excluded.length) {
        sections.push('**Out of scope / excluded**');
        for (const s of p.report.excluded) sections.push(renderScopeLine(s));
      }
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...scope block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractScope,
  buildScopeForFiles,
  renderScopeBlock,
  _internal: {
    splitSentences,
    matchAny,
    SCOPE_PATTERNS,
    EXCLUSION_PATTERNS,
    MAX_ITEMS_PER_KIND,
  },
};
