'use strict';

/**
 * document-fact-density.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-section fact-density scorer. Splits each document into sections
 * (or paragraph blocks for unstructured input), counts verifiable
 * anchors (numbers, dates, currency amounts, percentages, named
 * entities, citations) and emits a ranked map the chat reads so it
 * cites the densest sections first.
 *
 * Why this exists:
 *   - The outline-generator surfaces headings (structure).
 *   - The insights-engine pulls entities + numbers (content).
 *   - But neither tells the model "section X is 4× denser than
 *     section Y so cite X first when answering numeric questions".
 *     That's what this module is for.
 *
 * Deterministic, no LLM, < 20 ms on 1 MB. Bilingual heading detector.
 *
 * Public API:
 *   scoreFactDensity(text, opts)        → DensityReport
 *   buildDensityForFiles(files)         → { perFile, aggregate }
 *   renderDensityBlock(batchReport)     → markdown string
 */

const SCAN_HEAD_BYTES = 90_000;
const MIN_SECTION_LEN = 40;
const MAX_SECTIONS_RANKED = 8;
const MAX_BLOCK_CHARS = 3800;

const HEADING_RES = [
  /^#{1,6}\s+(.{3,90})$/gm,                            // markdown #-headings
  /^(\d+(?:\.\d+){0,3})\s+([^\n]{3,90})$/gm,           // "1.2 Section title"
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s,.:;()/-]{4,70})$/gm,   // ALL-CAPS heading line
];

const NUMBER_RE = /(?<![\w.])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(?![\w])/g;
const PERCENT_RE = /\d{1,3}(?:[.,]\d+)?\s?%/g;
const MONEY_RE = /([$€£¥]|US\$|MX\$|R\$|S\/\.?|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CHF)\s?\d/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|Q[1-4]\s+\d{4}|\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4})\b/g;
const ENTITY_RE = /\b([\p{Lu}][\p{L}\p{N}'\-]{2,}(?:\s+[\p{Lu}][\p{L}\p{N}'\-]+){0,3})\b/gu;
const ACRONYM_RE = /\b([A-Z]{2,}[A-Z0-9]{0,6})\b/g;
const CITATION_RE = /\(([A-ZÁÉÍÓÚÑ][\w'-]+(?:\s+(?:y|and|&|et al\.?))?(?:\s+[A-ZÁÉÍÓÚÑ][\w'-]+)*,?\s+(?:19|20)\d{2}[a-z]?)\)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }
function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = 80) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function countMatches(text, regex) {
  let count = 0;
  for (const _ of text.matchAll(regex)) count++;
  return count;
}

function detectHeadings(text) {
  const indices = new Set();
  const out = [];
  for (const re of HEADING_RES) {
    const cloned = new RegExp(re.source, re.flags);
    for (const m of text.matchAll(cloned)) {
      const idx = m.index ?? 0;
      if (indices.has(idx)) continue;
      indices.add(idx);
      const title = (m[2] || m[1] || '').trim().replace(/\s+/g, ' ');
      out.push({ index: idx, title });
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * Split text into sections delimited by detected headings. Falls back to
 * paragraph groups when no headings are present.
 */
function splitIntoSections(text) {
  const headings = detectHeadings(text);
  if (headings.length === 0) {
    const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length >= MIN_SECTION_LEN);
    return blocks.slice(0, 24).map((block, i) => ({
      title: `Block ${i + 1}`,
      body: block,
    }));
  }
  const out = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (body.length < MIN_SECTION_LEN) continue;
    out.push({ title: clip(headings[i].title), body });
  }
  return out.slice(0, 24);
}

function scoreSectionFacts(section) {
  const body = section.body || '';
  const numbers = countMatches(body, new RegExp(NUMBER_RE.source, NUMBER_RE.flags));
  const percents = countMatches(body, new RegExp(PERCENT_RE.source, PERCENT_RE.flags));
  const monies = countMatches(body, new RegExp(MONEY_RE.source, MONEY_RE.flags));
  const dates = countMatches(body, new RegExp(DATE_RE.source, DATE_RE.flags));
  const entities = countMatches(body, new RegExp(ENTITY_RE.source, ENTITY_RE.flags));
  const acronyms = countMatches(body, new RegExp(ACRONYM_RE.source, ACRONYM_RE.flags));
  const citations = countMatches(body, new RegExp(CITATION_RE.source, CITATION_RE.flags));
  const facts = numbers + percents + monies + dates + entities + acronyms + citations;
  const lengthKb = Math.max(1, body.length / 1024);
  const density = Number((facts / lengthKb).toFixed(2));
  return {
    title: section.title,
    facts: { numbers, percents, monies, dates, entities, acronyms, citations },
    factTotal: facts,
    chars: body.length,
    density,
  };
}

function scoreFactDensity(input) {
  const text = safeText(input);
  if (!text) return { sections: [], totalFacts: 0, truncated: false, sectionCount: 0 };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sections = splitIntoSections(head).map(scoreSectionFacts);
  const ranked = [...sections].sort((a, b) => b.density - a.density);
  const totalFacts = sections.reduce((acc, s) => acc + s.factTotal, 0);
  return {
    sections: ranked.slice(0, MAX_SECTIONS_RANKED),
    sectionCount: sections.length,
    totalFacts,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildDensityForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = scoreFactDensity(safeText(f.extractedText));
    if (r.sectionCount === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.sections.map((s) => ({ ...s, file: name })));
  }
  aggregate.sort((a, b) => b.density - a.density);
  aggregate = aggregate.slice(0, MAX_SECTIONS_RANKED);
  return { perFile, aggregate };
}

function renderSectionLine(s, opts = {}) {
  const fileTag = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  const composition = [];
  if (s.facts.numbers) composition.push(`${s.facts.numbers} numbers`);
  if (s.facts.percents) composition.push(`${s.facts.percents} percents`);
  if (s.facts.monies) composition.push(`${s.facts.monies} amounts`);
  if (s.facts.dates) composition.push(`${s.facts.dates} dates`);
  if (s.facts.entities) composition.push(`${s.facts.entities} entities`);
  if (s.facts.acronyms) composition.push(`${s.facts.acronyms} acronyms`);
  if (s.facts.citations) composition.push(`${s.facts.citations} citations`);
  const breakdown = composition.length ? ` — ${composition.join(', ')}` : '';
  return `- **${s.title}**${fileTag}: density=${s.density} facts/KB (${s.factTotal} facts in ${s.chars} chars)${breakdown}`;
}

function renderDensityBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## FACT DENSITY MAP
Sections ranked by verifiable-anchor density (numbers, dates, monies, percents, entities, acronyms, citations per KB). When the user asks a numeric or evidentiary question, cite from the highest-density sections first — they carry the most ground-truth anchors per character.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file} — ${only.report.totalFacts} facts across ${only.report.sectionCount} sections`);
    for (const s of only.report.sections) sections.push(renderSectionLine(s));
  } else {
    sections.push('### Top sections across all files');
    for (const s of batchReport.aggregate) sections.push(renderSectionLine(s, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file} — ${p.report.totalFacts} facts across ${p.report.sectionCount} sections`);
      for (const s of p.report.sections) sections.push(renderSectionLine(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...fact density block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  scoreFactDensity,
  buildDensityForFiles,
  renderDensityBlock,
  _internal: {
    detectHeadings,
    splitIntoSections,
    scoreSectionFacts,
    countMatches,
    MIN_SECTION_LEN,
    MAX_SECTIONS_RANKED,
  },
};
