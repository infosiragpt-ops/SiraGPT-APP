'use strict';

/**
 * document-fact-vs-opinion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Classifies sentences as FACT (objective claim grounded in numbers /
 * dates / named entities) vs OPINION (hedged / subjective / personal-
 * stance language) so the chat can answer "what's verifiable here?"
 * vs "what's the author's view?". Different from the deep-analyzer
 * (claim extraction) — this is a binary classifier on each sentence
 * with confidence levels.
 *
 * Bilingual (English / Spanish). Deterministic. < 18 ms on 1 MB.
 *
 * Heuristics:
 *   - FACT signals: numbers / percents / dates / proper-noun entities
 *     and report-style verbs (reported / increased / measured /
 *     reportó / aumentó / midió).
 *   - OPINION signals: hedges (may / might / could / believe / think /
 *     in our view / parece / creemos / pensamos / a nuestro juicio /
 *     posiblemente / probablemente).
 *   - Sentences with strong OPINION markers are tagged OPINION; with
 *     strong FACT markers and no opinion markers are FACT; else
 *     UNCLASSIFIED (skipped).
 *
 * Public API:
 *   classifySentences(text)            → { facts, opinions, totals }
 *   buildClassificationForFiles(files) → { perFile, aggregate }
 *   renderClassificationBlock(report)  → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_BUCKET_PER_FILE = 10;
const MAX_AGGREGATE_PER_BUCKET = 14;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 280;

const OPINION_PATTERNS = [
  /\b(may|might|could|seems\s+to|appears\s+to|suggests?\s+that|we\s+(?:believe|think|feel|argue|contend)|in\s+our\s+(?:view|opinion)|i\s+(?:believe|think)|likely\s+(?:to|that))\b/i,
  /(?:^|[^\p{L}])(quiz[áa]s?|posiblemente|probablemente|parece(?:r[íi]a)?|al\s+parecer|creemos|pensamos|opinamos|a\s+nuestro\s+(?:juicio|parecer)|en\s+nuestra\s+(?:opini[oó]n|visi[óo]n))(?=[^\p{L}]|$)/iu,
];

const FACT_VERBS = [
  /\b(reported|measured|increased|decreased|grew|fell|rose|equaled|recorded|achieved|delivered|received|paid|signed|approved|launched|ranked|published)\b/i,
  /(?:^|[^\p{L}])(report(?:[óo]|aron)|midi[óo]|midieron|aument(?:[óo]|aron)|disminuy(?:[óo]|eron)|creci(?:[óo]|eron)|recibi(?:[óo]|eron)|pag(?:[óo]|aron)|firmaron?|aprob(?:[óo]|aron)|alcanz(?:[óo]|aron)|registr(?:[óo]|aron)|public(?:[óo]|aron))(?=[^\p{L}]|$)/iu,
];

const NUMBER_RE = /(?<![\w.])\d{1,3}(?:[.,]\d+)?(?![\w])/;
const PERCENT_RE = /\d{1,3}(?:[.,]\d+)?\s?%/;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}|\bQ[1-4]\s+\d{4}/;
const ENTITY_RE = /\b[A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]+){0,3}\b/u;

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

function hasOpinion(sentence) {
  for (const re of OPINION_PATTERNS) if (re.test(sentence)) return true;
  return false;
}

function factScore(sentence) {
  let score = 0;
  if (NUMBER_RE.test(sentence)) score += 1;
  if (PERCENT_RE.test(sentence)) score += 1;
  if (DATE_RE.test(sentence)) score += 1;
  if (ENTITY_RE.test(sentence)) score += 1;
  for (const re of FACT_VERBS) if (re.test(sentence)) { score += 1; break; }
  return score;
}

function classifySentence(sentence) {
  const opinion = hasOpinion(sentence);
  const facts = factScore(sentence);
  if (opinion) return 'opinion';
  if (facts >= 2) return 'fact';
  return null;
}

function classifySentences(input) {
  const text = safeText(input);
  if (!text) return { facts: [], opinions: [], totals: { fact: 0, opinion: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const facts = [];
  const opinions = [];
  const seenFact = new Set();
  const seenOp = new Set();
  for (const s of sentences) {
    if (facts.length >= MAX_PER_BUCKET_PER_FILE && opinions.length >= MAX_PER_BUCKET_PER_FILE) break;
    const label = classifySentence(s);
    if (!label) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (label === 'fact' && facts.length < MAX_PER_BUCKET_PER_FILE && !seenFact.has(key)) {
      seenFact.add(key);
      facts.push({ sentence: clipped });
    } else if (label === 'opinion' && opinions.length < MAX_PER_BUCKET_PER_FILE && !seenOp.has(key)) {
      seenOp.add(key);
      opinions.push({ sentence: clipped });
    }
  }
  return {
    facts,
    opinions,
    totals: { fact: facts.length, opinion: opinions.length },
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildClassificationForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = { facts: [], opinions: [] };
  for (const f of list) {
    const r = classifySentences(safeText(f.extractedText));
    if (r.facts.length === 0 && r.opinions.length === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate.facts = aggregate.facts.concat(r.facts.map((x) => ({ ...x, file: name })));
    aggregate.opinions = aggregate.opinions.concat(r.opinions.map((x) => ({ ...x, file: name })));
  }
  aggregate.facts = aggregate.facts.slice(0, MAX_AGGREGATE_PER_BUCKET);
  aggregate.opinions = aggregate.opinions.slice(0, MAX_AGGREGATE_PER_BUCKET);
  return { perFile, aggregate };
}

function renderLine(item, kind, opts = {}) {
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**${kind.toUpperCase()}**]${file} ${item.sentence}`;
}

function renderClassificationBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## FACT vs OPINION
Sentences classified as either FACT (objective claim grounded in numbers / dates / named entities) or OPINION (hedged / subjective / personal-stance language). Use this block to answer "what's verifiable here?" vs "what's the author's view?". Skipped sentences had no concrete anchor either way.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    if (only.report.facts.length) {
      sections.push('**Facts**');
      for (const x of only.report.facts) sections.push(renderLine(x, 'fact'));
    }
    if (only.report.opinions.length) {
      sections.push('\n**Opinions**');
      for (const x of only.report.opinions) sections.push(renderLine(x, 'opinion'));
    }
  } else {
    if (batchReport.aggregate.facts.length) {
      sections.push('### Aggregate facts');
      for (const x of batchReport.aggregate.facts) sections.push(renderLine(x, 'fact', { includeFile: true }));
    }
    if (batchReport.aggregate.opinions.length) {
      sections.push('\n### Aggregate opinions');
      for (const x of batchReport.aggregate.opinions) sections.push(renderLine(x, 'opinion', { includeFile: true }));
    }
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      if (p.report.facts.length) {
        sections.push('**Facts**');
        for (const x of p.report.facts) sections.push(renderLine(x, 'fact'));
      }
      if (p.report.opinions.length) {
        sections.push('**Opinions**');
        for (const x of p.report.opinions) sections.push(renderLine(x, 'opinion'));
      }
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...fact-vs-opinion block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  classifySentences,
  classifySentence,
  buildClassificationForFiles,
  renderClassificationBlock,
  _internal: {
    splitSentences,
    hasOpinion,
    factScore,
    OPINION_PATTERNS,
    FACT_VERBS,
  },
};
