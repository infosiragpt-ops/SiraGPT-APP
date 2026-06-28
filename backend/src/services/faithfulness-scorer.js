'use strict';

/**
 * faithfulness-scorer.js
 *
 * Cheap, deterministic faithfulness / hallucination scorer for assistant
 * responses against the user-provided context.
 *
 * Inspired by Anthropic's circuit-tracing finding that hallucinations
 * are driven by a "default-on" answer circuit which gets suppressed when
 * the model has solid grounding. We can't see those circuits, but we can
 * approximate the suppression check at the surface level: every salient
 * claim in the response should be groundable in the context — otherwise
 * it is unsupported and likely a hallucination.
 *
 * The scorer takes:
 *   - response: string the assistant produced
 *   - context : array of { text } (chat turns, attached files, memories,
 *               retrieved chunks, etc.)
 *
 * It returns a JSON-friendly report:
 *   {
 *     score:     0..1 (1 = fully grounded),
 *     grade:     A..F,
 *     supported: [{text, foundIn:[sourceIdx, ...]}],
 *     unsupported: [{text, kind, severity}],
 *     numbers:   [{value, supported, context?}],
 *     entities:  [{name, supported, context?}],
 *     advisory:  string
 *   }
 *
 * No LLM call. Compares numbers, named entities, file/path references,
 * URLs, and surface fact-bearing clauses between response and context.
 */

const conceptExtractor = require('./concept-extractor');

const NUMBER_RE = /\b\d[\d.,]*(?:\s*(?:%|usd|eur|gbp|mxn|km|mi|ms|s|kg|g))?\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const PATH_RE = /\b[\w.-]+\.(?:js|ts|tsx|jsx|json|md|py|java|go|rb|css|html|yml|yaml|sh|sql|csv|xml|pdf|docx|xlsx)\b/gi;
const NAMED_ENTITY_RE = /\b([A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]+){0,2})\b/g;

// ── Helpers ────────────────────────────────────────────────────────────────

function safeText(value, max = 80000) {
  return String(value == null ? '' : value).slice(0, max);
}

function normalize(text) {
  return safeText(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalize(text).split(/\s+/).filter(Boolean);
}

function tokenSet(text) { return new Set(tokenize(text)); }

function gatherContextText(context = []) {
  if (!Array.isArray(context)) return '';
  return context
    .map((c) => {
      if (!c) return '';
      if (typeof c === 'string') return c;
      return String(c.text || c.content || c.fact || c.summary || c.name || '');
    })
    .filter(Boolean)
    .join('\n\n');
}

function contextSnippets(context = []) {
  if (!Array.isArray(context)) return [];
  return context.map((c, i) => {
    if (!c) return { idx: i, text: '' };
    if (typeof c === 'string') return { idx: i, text: c };
    return {
      idx: i,
      kind: c.kind || c.role || 'source',
      text: safeText(c.text || c.content || c.fact || c.summary || c.name || ''),
    };
  });
}

function isCommonNumber(value) {
  // 0, 1, 2 etc. are often used as enumerators, not facts.
  const stripped = value.replace(/[^\d.]/g, '');
  if (!stripped) return true;
  const n = Number(stripped);
  if (Number.isNaN(n)) return false;
  return n >= 0 && n <= 5 && !/[.,%]/.test(value);
}

function isStopwordEntity(name) {
  const stop = new Set(['the', 'this', 'that', 'and', 'or', 'but', 'with', 'from', 'into', 'over',
    'el', 'la', 'los', 'las', 'que', 'pero', 'sin', 'con', 'una', 'uno', 'unos', 'unas',
    'first', 'second', 'third', 'next', 'last', 'final', 'best', 'worst']);
  return stop.has(name.toLowerCase());
}

function checkPresence(needle, haystackLower) {
  const n = String(needle || '').toLowerCase().trim();
  if (!n) return true;
  if (haystackLower.includes(n)) return true;
  // Strip punctuation around it for resilience, normalize whitespace.
  const cleaned = n.replace(/[(),.;:!?'"`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return true;
  if (haystackLower.includes(cleaned)) return true;
  // Also try matching against a punctuation-stripped haystack so that
  // "1,234 USD" matches "1234 usd", "1 234 usd", etc.
  const cleanedHay = haystackLower.replace(/[(),.;:!?'"`]/g, ' ').replace(/\s+/g, ' ');
  if (cleanedHay.includes(cleaned)) return true;
  // Numeric tail: if needle starts with digits, also try the numeric core alone.
  const numericCore = cleaned.replace(/[^0-9.]/g, '');
  if (numericCore.length >= 2) {
    const hayNoSpaces = cleanedHay.replace(/[, ]/g, '');
    if (hayNoSpaces.includes(numericCore)) return true;
  }
  return false;
}

// ── Extractors ─────────────────────────────────────────────────────────────

function extractNumbers(text) {
  const safe = safeText(text);
  const out = [];
  const seen = new Set();
  let m;
  while ((m = NUMBER_RE.exec(safe)) !== null) {
    const value = m[0];
    if (isCommonNumber(value)) continue;
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push({ value, index: m.index });
    if (out.length >= 80) break;
  }
  NUMBER_RE.lastIndex = 0;
  return out;
}

function extractNamedEntities(text) {
  const safe = safeText(text);
  const out = [];
  const seen = new Set();
  let m;
  while ((m = NAMED_ENTITY_RE.exec(safe)) !== null) {
    const value = m[1];
    if (isStopwordEntity(value)) continue;
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push({ value, index: m.index });
    if (out.length >= 80) break;
  }
  NAMED_ENTITY_RE.lastIndex = 0;
  return out;
}

function extractUrls(text) { return Array.from(safeText(text).matchAll(URL_RE)).map((m) => m[0]).slice(0, 40); }
function extractEmails(text) { return Array.from(safeText(text).matchAll(EMAIL_RE)).map((m) => m[0]).slice(0, 40); }
function extractPaths(text) { return Array.from(safeText(text).matchAll(PATH_RE)).map((m) => m[0]).slice(0, 40); }

function splitClaims(text) {
  // Very simple sentence splitter that preserves abbreviations.
  return safeText(text)
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 16 && s.length <= 400)
    .slice(0, 60);
}

// ── Scoring ────────────────────────────────────────────────────────────────

function scoreFaithfulness({ response = '', context = [] } = {}) {
  const respText = safeText(response, 80000);
  if (!respText.trim()) {
    return {
      score: 1,
      grade: 'A',
      empty: true,
      supported: [],
      unsupported: [],
      numbers: [],
      entities: [],
      urls: [],
      paths: [],
      emails: [],
      claimCoverage: 1,
      advisory: 'empty response',
    };
  }

  const haystack = normalize(gatherContextText(context));
  const snippets = contextSnippets(context);
  const hasContext = haystack.length > 0;

  // 1. Numbers — every non-trivial number in the response must appear in context.
  const numbers = extractNumbers(respText).map((n) => {
    const stripped = n.value.replace(/[^\d.,%]/g, '');
    const supported = hasContext && (checkPresence(n.value, haystack) || checkPresence(stripped, haystack));
    return { value: n.value, supported };
  });

  // 2. Named entities — same check.
  const entities = extractNamedEntities(respText).map((e) => ({
    value: e.value,
    supported: hasContext && checkPresence(e.value, haystack),
  }));

  // 3. URLs / paths / emails — strict surface match.
  const urls = extractUrls(respText).map((u) => ({ value: u, supported: hasContext && haystack.includes(u.toLowerCase()) }));
  const paths = extractPaths(respText).map((p) => ({ value: p, supported: hasContext && haystack.includes(p.toLowerCase()) }));
  const emails = extractEmails(respText).map((e) => ({ value: e, supported: hasContext && haystack.includes(e.toLowerCase()) }));

  // 4. Sentence-level claim coverage via token overlap.
  const claims = splitClaims(respText);
  const claimReports = claims.map((claim) => {
    const tokens = [...tokenSet(claim)];
    if (!tokens.length) return null;
    let bestIdx = -1;
    let bestOverlap = 0;
    for (const snip of snippets) {
      if (!snip.text) continue;
      const snipTokens = tokenSet(snip.text);
      let hits = 0;
      for (const t of tokens) if (t.length > 3 && snipTokens.has(t)) hits++;
      if (hits > bestOverlap) {
        bestOverlap = hits;
        bestIdx = snip.idx;
      }
    }
    const coverage = tokens.length ? bestOverlap / Math.min(tokens.length, 14) : 0;
    return {
      text: claim,
      coverage: Math.min(1, coverage),
      bestSourceIdx: bestIdx,
    };
  }).filter(Boolean);

  // Aggregate scores.
  const numberScore = ratio(numbers, (n) => n.supported);
  const entityScore = ratio(entities, (e) => e.supported);
  const urlScore = ratio(urls, (u) => u.supported);
  const pathScore = ratio(paths, (p) => p.supported);
  const emailScore = ratio(emails, (e) => e.supported);
  const claimScore = avgOf(claimReports.map((c) => c.coverage));

  const weights = pickWeights({ numbers, entities, urls, paths, emails, claimReports });
  const score =
    weights.numberW * numberScore +
    weights.entityW * entityScore +
    weights.urlW * urlScore +
    weights.pathW * pathScore +
    weights.emailW * emailScore +
    weights.claimW * claimScore;

  const grade = gradeFromScore(score);
  const supported = claimReports.filter((c) => c.coverage >= 0.3);
  const unsupported = [
    ...numbers.filter((n) => !n.supported).map((n) => ({ kind: 'number', text: n.value, severity: 'high' })),
    ...entities.filter((e) => !e.supported).map((e) => ({ kind: 'entity', text: e.value, severity: 'medium' })),
    ...urls.filter((u) => !u.supported).map((u) => ({ kind: 'url', text: u.value, severity: 'high' })),
    ...paths.filter((p) => !p.supported).map((p) => ({ kind: 'path', text: p.value, severity: 'medium' })),
    ...emails.filter((e) => !e.supported).map((e) => ({ kind: 'email', text: e.value, severity: 'high' })),
    ...claimReports.filter((c) => c.coverage < 0.2).map((c) => ({ kind: 'claim', text: c.text.slice(0, 160), severity: 'low' })),
  ].slice(0, 30);

  return {
    score: Math.round(score * 100) / 100,
    grade,
    // Whether any grounding evidence was supplied. When false the score is
    // meaningless (every claim is "unsupported" simply because there was
    // nothing to check against) — callers should not gate on it.
    hasContext,
    supported,
    unsupported,
    numbers,
    entities,
    urls,
    paths,
    emails,
    claimCoverage: Math.round(claimScore * 100) / 100,
    advisory: buildAdvisory({ score, hasContext, unsupported }),
    weights,
  };
}

function ratio(arr, pred) {
  if (!arr || !arr.length) return 1;
  let hits = 0;
  for (const x of arr) if (pred(x)) hits++;
  return hits / arr.length;
}

function avgOf(values) {
  if (!values || !values.length) return 1;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pickWeights({ numbers, entities, urls, paths, emails, claimReports }) {
  // Weight categories proportionally to their presence — keeps the score
  // sensible for short responses without numbers.
  const raw = {
    numberW: numbers.length ? 0.25 : 0,
    entityW: entities.length ? 0.20 : 0,
    urlW: urls.length ? 0.15 : 0,
    pathW: paths.length ? 0.10 : 0,
    emailW: emails.length ? 0.05 : 0,
    claimW: claimReports.length ? 0.35 : 0.6,
  };
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total]));
}

function gradeFromScore(s) {
  if (s >= 0.92) return 'A';
  if (s >= 0.82) return 'B';
  if (s >= 0.70) return 'C';
  if (s >= 0.55) return 'D';
  return 'F';
}

function buildAdvisory({ score, hasContext, unsupported }) {
  if (!hasContext) return 'No grounding context supplied — score reflects internal consistency only.';
  if (score >= 0.9) return 'Response appears well-grounded in the provided context.';
  if (score >= 0.75) return 'Mostly grounded; double-check the flagged items before publishing.';
  if (score >= 0.55) return 'Several ungrounded claims; ask the user to confirm or fetch more context.';
  return `Likely hallucinations (${unsupported.length} items); regenerate with stricter citations.`;
}

function renderFaithfulnessBlock(report, opts = {}) {
  if (!report) return '';
  const lines = [];
  lines.push('## FAITHFULNESS REPORT');
  lines.push(`Score: ${report.score} (grade ${report.grade}) — ${report.advisory}`);
  if (report.unsupported && report.unsupported.length) {
    lines.push(`Ungrounded items (${report.unsupported.length}):`);
    for (const u of report.unsupported.slice(0, 8)) {
      lines.push(`- [${u.kind}/${u.severity}] ${u.text}`);
    }
  }
  const cap = Math.max(400, Number(opts.maxChars) || 1200);
  const out = lines.join('\n');
  if (out.length > cap) return `${out.slice(0, cap - 80).trimEnd()}\n… [faithfulness truncated]`;
  return out;
}

module.exports = {
  scoreFaithfulness,
  renderFaithfulnessBlock,
  extractNumbers,
  extractNamedEntities,
  extractUrls,
  extractPaths,
  extractEmails,
  splitClaims,
};
