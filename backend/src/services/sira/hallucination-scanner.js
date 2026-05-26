'use strict';

/**
 * hallucination-scanner — deterministic claim/support checker for the
 * textual answer about to be delivered.
 *
 * Why this exists:
 *  The existing self-rag-critic + nli-faithfulness modules are LLM-based:
 *  high signal, but a few hundred ms per call and only used in the
 *  research pipeline. Most chat turns ship without any "did the model
 *  make this number up?" check. This scanner runs in <5 ms even on long
 *  answers, with zero LLM/network cost, and is meant to gate the
 *  response right before delivery (and feed the answer-validator).
 *
 * What it detects:
 *  - **Unsupported numeric claims**: percentages, currency amounts and
 *    large numbers that appear in the answer but NOWHERE in the evidence
 *    pool (= user message + retrieved passages + attached documents).
 *  - **Fabricated quoted statements**: anything in straight or curly
 *    quotes inside the answer that doesn't appear in the evidence pool.
 *  - **Fabricated named entities**: persons / organisations the model
 *    introduces by name when no evidence contains them — surfaced as a
 *    warning rather than a hard failure because it false-positives on
 *    well-known public entities.
 *  - **Citation drift**: when the answer cites [1], [2] etc., does the
 *    document just before the citation contain content related to the
 *    cited source's keywords? (Loose check; warning-grade.)
 *
 * Design constraints:
 *  - Pure, deterministic, zero deps. No LLM, no network.
 *  - Resilient to null inputs and oddly-shaped evidence.
 *  - Bounded cost: scans the first 64 KB of evidence and the first
 *    32 KB of the answer.
 *
 * Public API:
 *   scanAnswerForHallucinations({ answer, evidence, options? }) → report
 *
 * Return shape:
 *   {
 *     unsupportedNumbers:   string[],
 *     fabricatedQuotes:     string[],
 *     suspectEntities:      string[],
 *     citationDrift:        Array<{ ref, reason }>,
 *     overallRisk:          'low' | 'medium' | 'high',
 *     totalFlags:           number,
 *   }
 */

const SCAN_ANSWER_BYTES = 32_000;
const SCAN_EVIDENCE_BYTES = 64_000;
const MAX_FLAGGED_PER_TYPE = 12;

// ─── Evidence flattening ────────────────────────────────────────────

function flattenEvidence(evidence) {
  if (!evidence) return '';
  if (typeof evidence === 'string') return evidence.slice(0, SCAN_EVIDENCE_BYTES);
  if (Array.isArray(evidence)) {
    const out = [];
    let budget = SCAN_EVIDENCE_BYTES;
    for (const item of evidence) {
      if (!item || budget <= 0) break;
      const text = typeof item === 'string'
        ? item
        : (item.text || item.content || item.passage || item.snippet || item.extractedText || '');
      const next = String(text).slice(0, budget);
      if (next) { out.push(next); budget -= next.length; }
    }
    return out.join('\n');
  }
  if (typeof evidence === 'object') {
    return String(
      evidence.text || evidence.content || evidence.passage
      || evidence.snippet || evidence.extractedText || '',
    ).slice(0, SCAN_EVIDENCE_BYTES);
  }
  return '';
}

// ─── Normalisation helpers ─────────────────────────────────────────

function normalizeNumber(token) {
  // Strip currency symbols + spaces + thousand separators + percent
  // to compare numbers structurally rather than textually.
  return String(token)
    .replace(/[$€£¥%]/g, '')
    .replace(/\s+/g, '')
    .replace(/^US|R|MX|Bs\.?$/i, '')
    .replace(/[A-Z]{1,4}$/i, '')
    .replace(/,/g, '');
}

function normalizeQuote(text) {
  return String(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ─── Detectors ──────────────────────────────────────────────────────

const PERCENT_RE = /\b\d{1,3}(?:[.,]\d+)?\s?%/g;
const MONEY_RE = /(?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|Bs\.?)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?:\s?(?:millones?|millions?|billions?|thousands?|m|k|bn))?\b|\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s?(?:USD|EUR|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CAD|AUD)\b/gi;
const LARGE_NUM_RE = /\b\d{1,3}(?:[.,]\d{3}){2,}(?:[.,]\d+)?\b/g;
const STRAIGHT_QUOTE_RE = /"([^"\n]{12,180})"/g;
const CURLY_QUOTE_RE = /[“]([^”\n]{12,180})[”]/g;
const SQUARE_CITATION_RE = /\[(\d{1,3})\]/g;

function extractCandidateNumbers(text) {
  const head = text.slice(0, SCAN_ANSWER_BYTES);
  const items = new Set();
  let m;
  while ((m = PERCENT_RE.exec(head)) !== null) items.add(m[0]);
  PERCENT_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(head)) !== null) items.add(m[0]);
  MONEY_RE.lastIndex = 0;
  while ((m = LARGE_NUM_RE.exec(head)) !== null) items.add(m[0]);
  LARGE_NUM_RE.lastIndex = 0;
  return Array.from(items);
}

function numberSupportedByEvidence(num, evidenceText) {
  const needle = normalizeNumber(num);
  if (!needle) return false;
  // Try direct contains
  if (evidenceText.includes(num)) return true;
  // Try normalised contains (handles "$1,200,000" vs "1200000 USD")
  const normalisedEvidence = evidenceText.replace(/[,$€£¥%\s]/g, '');
  if (normalisedEvidence.includes(needle)) return true;
  return false;
}

function extractCandidateQuotes(text) {
  const head = text.slice(0, SCAN_ANSWER_BYTES);
  const quotes = new Set();
  let m;
  while ((m = STRAIGHT_QUOTE_RE.exec(head)) !== null) quotes.add(m[1]);
  STRAIGHT_QUOTE_RE.lastIndex = 0;
  while ((m = CURLY_QUOTE_RE.exec(head)) !== null) quotes.add(m[1]);
  CURLY_QUOTE_RE.lastIndex = 0;
  return Array.from(quotes);
}

function quoteSupportedByEvidence(quote, evidenceText) {
  const needle = normalizeQuote(quote);
  if (needle.length < 12) return true; // very short → ambiguous, skip
  const haystack = normalizeQuote(evidenceText);
  if (haystack.includes(needle)) return true;
  // Soft check: split into significant words and require ≥70% overlap
  // with a 200-char rolling window in the evidence.
  const words = needle.split(/\s+/).filter(w => w.length > 3);
  if (words.length < 4) return false;
  const required = Math.ceil(words.length * 0.7);
  const windows = Math.max(1, haystack.length - 200);
  // Cheap word-set check across the whole evidence — windows aren't
  // strictly necessary for soft match.
  let hits = 0;
  for (const w of words) {
    if (haystack.includes(w)) hits++;
    if (hits >= required) return true;
  }
  void windows;
  return false;
}

function extractNamedEntities(text) {
  // Two-or-more capitalised tokens in a row, length 2-50 chars total.
  // Same regex family the insights engine uses; reused locally here so the
  // scanner stays standalone.
  const head = text.slice(0, SCAN_ANSWER_BYTES);
  const found = new Set();
  const re = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3})\b/g;
  let m;
  while ((m = re.exec(head)) !== null) {
    const entity = m[1].trim();
    if (entity.length <= 50) found.add(entity);
  }
  return Array.from(found);
}

function entitySupportedByEvidence(entity, evidenceText) {
  if (evidenceText.includes(entity)) return true;
  // Try lower-case fallback (evidence might have casing differences)
  if (evidenceText.toLowerCase().includes(entity.toLowerCase())) return true;
  return false;
}

function detectCitationDrift({ answer, evidenceList }) {
  // For each [N] citation in the answer, get the sentence around it and
  // check the keywords appear in the N-th evidence item.
  const drift = [];
  if (!Array.isArray(evidenceList) || evidenceList.length === 0) return drift;
  const head = answer.slice(0, SCAN_ANSWER_BYTES);
  let m;
  while ((m = SQUARE_CITATION_RE.exec(head)) !== null) {
    const ref = Number(m[1]);
    if (!Number.isFinite(ref) || ref < 1 || ref > evidenceList.length) {
      drift.push({ ref: m[0], reason: `out-of-range citation (only ${evidenceList.length} sources available)` });
      continue;
    }
    const sourceText = String(
      evidenceList[ref - 1]?.text
      || evidenceList[ref - 1]?.content
      || evidenceList[ref - 1]?.passage
      || evidenceList[ref - 1]?.snippet
      || (typeof evidenceList[ref - 1] === 'string' ? evidenceList[ref - 1] : ''),
    ).toLowerCase();
    if (!sourceText) {
      drift.push({ ref: m[0], reason: 'cited source has no extractable text' });
      continue;
    }
    // Window: 80 chars before the citation
    const windowStart = Math.max(0, m.index - 120);
    const windowEnd = Math.min(head.length, m.index + 40);
    const window = head.slice(windowStart, windowEnd).toLowerCase();
    const windowTokens = (window.match(/[\p{L}\p{N}]{4,}/gu) || []);
    if (windowTokens.length < 4) continue; // not enough context to judge
    const hits = windowTokens.filter(t => sourceText.includes(t)).length;
    const ratio = hits / windowTokens.length;
    if (ratio < 0.2) {
      drift.push({
        ref: m[0],
        reason: `cited source has weak lexical overlap with the surrounding sentence (${(ratio * 100).toFixed(0)}%)`,
      });
    }
  }
  SQUARE_CITATION_RE.lastIndex = 0;
  return drift;
}

// ─── Public API ─────────────────────────────────────────────────────

function scanAnswerForHallucinations({ answer = '', evidence = null, options = {} } = {}) {
  const safeAnswer = typeof answer === 'string' ? answer : '';
  const evidenceText = flattenEvidence(evidence);
  const evidenceList = Array.isArray(evidence)
    ? evidence
    : (evidence && typeof evidence === 'object' ? [evidence] : []);

  const numbers = extractCandidateNumbers(safeAnswer);
  const unsupportedNumbers = numbers
    .filter(n => !numberSupportedByEvidence(n, evidenceText))
    .slice(0, MAX_FLAGGED_PER_TYPE);

  const quotes = extractCandidateQuotes(safeAnswer);
  const fabricatedQuotes = quotes
    .filter(q => !quoteSupportedByEvidence(q, evidenceText))
    .slice(0, MAX_FLAGGED_PER_TYPE);

  let suspectEntities = [];
  if (options.includeEntities !== false) {
    const entities = extractNamedEntities(safeAnswer);
    suspectEntities = entities
      .filter(e => !entitySupportedByEvidence(e, evidenceText))
      .slice(0, MAX_FLAGGED_PER_TYPE);
  }

  const citationDrift = detectCitationDrift({ answer: safeAnswer, evidenceList })
    .slice(0, MAX_FLAGGED_PER_TYPE);

  const totalFlags
    = unsupportedNumbers.length
    + fabricatedQuotes.length
    + (options.includeEntities === false ? 0 : suspectEntities.length)
    + citationDrift.length;

  let overallRisk = 'low';
  // Numbers and quotes are strict; entities are advisory only. Threshold
  // tuned so 4+ hard flags = high (any combination of fabricated number,
  // quote, or out-of-range citation that adds to 4 is unambiguous abuse).
  const hardFlags = unsupportedNumbers.length + fabricatedQuotes.length + citationDrift.length;
  if (hardFlags >= 4) overallRisk = 'high';
  else if (hardFlags >= 2) overallRisk = 'medium';
  else if (totalFlags >= 4 && hardFlags >= 1) overallRisk = 'medium';

  return {
    unsupportedNumbers,
    fabricatedQuotes,
    suspectEntities,
    citationDrift,
    overallRisk,
    totalFlags,
  };
}

// ─── Markdown rendering (optional) ─────────────────────────────────

function renderHallucinationReport(report, opts = {}) {
  if (!report) return '';
  const { unsupportedNumbers, fabricatedQuotes, suspectEntities, citationDrift, overallRisk, totalFlags } = report;
  if (totalFlags === 0) return '';
  const title = opts.title || 'HALLUCINATION SCAN';
  const lines = [];
  lines.push(`## ${title}`);
  lines.push(`**Risk:** ${overallRisk.toUpperCase()} · ${totalFlags} flag${totalFlags === 1 ? '' : 's'} across categories.`);
  if (unsupportedNumbers.length) {
    lines.push('### Unsupported numeric claims');
    lines.push(unsupportedNumbers.map(n => `- \`${n}\``).join('\n'));
  }
  if (fabricatedQuotes.length) {
    lines.push('### Fabricated quoted statements');
    lines.push(fabricatedQuotes.map(q => `- "${q.slice(0, 120)}${q.length > 120 ? '…' : ''}"`).join('\n'));
  }
  if (citationDrift.length) {
    lines.push('### Citation drift');
    lines.push(citationDrift.map(d => `- ${d.ref} — ${d.reason}`).join('\n'));
  }
  if (suspectEntities.length) {
    lines.push('### Named entities not present in evidence');
    lines.push(`_(advisory — high false-positive rate on public entities)_\n${suspectEntities.slice(0, 6).map(e => `- ${e}`).join('\n')}`);
  }
  return lines.join('\n\n');
}

module.exports = {
  scanAnswerForHallucinations,
  renderHallucinationReport,
  _internal: {
    flattenEvidence,
    extractCandidateNumbers,
    numberSupportedByEvidence,
    extractCandidateQuotes,
    quoteSupportedByEvidence,
    extractNamedEntities,
    entitySupportedByEvidence,
    detectCitationDrift,
    normalizeNumber,
    normalizeQuote,
  },
};
