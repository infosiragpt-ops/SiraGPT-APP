'use strict';

/**
 * document-deep-analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deep-analysis layer that sits ALONGSIDE document-professional-analyzer.js.
 * Where the professional analyzer classifies the doc and emits a domain
 * recipe, and the insights-engine extracts entities/numbers, this module
 * extracts *intent-bearing* sentences:
 *
 *   - claims          declarative statements with evidential weight
 *   - actions         imperative / deliverable / deadline sentences
 *   - decisions       past-tense resolutions ("decided", "approved")
 *   - openQuestions   "?", "TBD", "pending", "por definir"
 *   - risks           risk / threat / failure / contingency language
 *
 * Bilingual (Spanish / English), deterministic, no LLM, < 15 ms on a 1 MB
 * document. The chat route concatenates the rendered block AFTER the
 * insights block and BEFORE the directive so the model reads:
 *
 *    profile → outline → glossary → readability → insights → consistency
 *    → comparison → quality → DEEP ANALYSIS → directive
 *
 * That ordering puts factual ground (numbers/entities/contradictions)
 * before the higher-order semantics (claims/decisions/actions) and keeps
 * the directive last so the model commits to a structure after seeing
 * the evidence.
 *
 * Public API:
 *   analyzeText(text, opts)              → DeepReport
 *   buildDeepAnalysisForFiles(files)     → { perFile, aggregate }
 *   renderDeepAnalysisBlock(report)      → markdown string ('' when empty)
 */

const MAX_BLOCK_CHARS = 4500;
const MAX_PER_BUCKET = 6;
const MAX_SENT_CHARS = 240;
const MIN_SENT_CHARS = 12;

/**
 * Lower-cased keyword roots. Matched against the lower-cased sentence so we
 * don't have to enumerate diacritics. Order doesn't matter; first hit wins.
 */
const ACTION_PATTERNS = [
  // Spanish imperatives & deliverable cues
  /\b(debe|deber[áa]n?|debemos|hay que|tenemos que|se requiere|se necesita|implementar|entregar|preparar|enviar|definir|coordinar|agendar|programar|asignar|priorizar|completar|finalizar|revisar|aprobar|publicar)\b/,
  /\b(acci[óo]n|accionable|pendiente|por hacer|to[- ]?do|tarea|entregable|deadline|fecha l[íi]mite|plazo)\b/,
  // English imperatives
  /\b(must|should|shall|need to|needs to|have to|todo|action item|deliverable|deadline|due by|by end of|eta)\b/,
];

// Note on word boundaries: JS `\b` is ASCII-only, so a trailing `\b` after a
// non-ASCII char like `ó` never matches. We anchor the LEFT side with `\b`
// (or a space) and let the right side end at any non-letter via lookahead.
const DECISION_PATTERNS = [
  /\b(se (acord[óo]|decidi[óo]|aprob[óo]|resolvi[óo]|determin[óo])|qued[óo] aprobad[oa]|se ratific[óo])/,
  /\b(decision|decided|approved|resolved|ratified|agreed|signed off|sign[- ]off)\b/,
];

const QUESTION_PATTERNS = [
  /\b(tbd|pendiente de definir|por definir|por confirmar|to be determined|to be decided|por aclarar|por resolver|unclear|no claro)\b/,
];

const RISK_PATTERNS = [
  // Spanish — trailing `\b` would fail after `ó`/`í`; use a prefix anchor
  // and rely on stem matching (`vulnerab`, `incumpl`) for variants.
  /\b(riesgos?|amenazas?|vulnerab\w*|brechas?|fallos?|fallas?|incidentes?|exposici[óo]n|contingencias?|p[ée]rdidas?|sanci[óo]n(?:es)?|multas?|incumpl\w*)/i,
  /\b(risks?|threats?|vulnerab\w*|breach(?:es)?|failures?|exposure|liabilit\w*|penalt\w*|non[- ]?compliance|disruptions?|outages?|degradation|attack vector)\b/i,
];

const CLAIM_HEDGES = [
  // Anti-claims: sentences that look declarative but are wishy-washy.
  /\b(quiz[áa]s?|tal vez|posiblemente|podr[íi]a|al parecer|aparentemente)\b/,
  /\b(maybe|perhaps|possibly|might|could be|seems to|appears to)\b/,
];

const NUMBER_RE = /(?:\$|€|£|US\$|MX\$|USD|EUR|GBP|MXN|COP|ARS)\s?\d|(?:\d+(?:[.,]\d+)+)|\b\d{2,}\b|\b\d+\s?%/;
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\b(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|apr|aug|dec)[a-záéíóú]*\b\s+\d{1,2},?\s+\d{2,4})\b/i;

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Split text into sentences while keeping the original sentence so we can
 * quote it back verbatim. Splits on terminal punctuation followed by
 * whitespace + capital letter / digit, or on hard newlines.
 */
function splitSentences(text) {
  const norm = String(text).replace(/\r\n?/g, '\n');
  // Bullet/numbered lists count as sentence boundaries.
  const out = [];
  for (const block of norm.split(/\n{2,}/)) {
    // Within a block, split on `. `, `! `, `? `, or hard newlines.
    const parts = block
      .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ0-9])|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      if (p.length >= MIN_SENT_CHARS && p.length <= 600) out.push(p);
    }
  }
  return out;
}

function anyMatch(patterns, hay) {
  for (const re of patterns) if (re.test(hay)) return true;
  return false;
}

function truncSent(s) {
  if (s.length <= MAX_SENT_CHARS) return s;
  return `${s.slice(0, MAX_SENT_CHARS - 1)}…`;
}

/**
 * Score a sentence as a potential "claim":
 *   +2 contains a number or money or %
 *   +1 contains a date
 *   +1 contains an attribution verb ("according to", "según", "afirma", "reports")
 *   −2 hedged language
 *   +1 starts with a noun-phrase pattern (the/la/el + word) — proxy for declarative
 * Anything ≥ 2 qualifies.
 */
function claimScore(s) {
  const low = s.toLowerCase();
  let score = 0;
  if (NUMBER_RE.test(s)) score += 2;
  if (DATE_RE.test(s)) score += 1;
  if (/\b(seg[úu]n|de acuerdo (a|con)|afirma|sostiene|reporta|indica|seg[úu]n el|according to|reports?|states?|notes?|finds?|shows?)\b/.test(low)) {
    score += 1;
  }
  if (anyMatch(CLAIM_HEDGES, low)) score -= 2;
  if (/^(the|a|an|el|la|los|las|un|una|este|esta|estos|estas)\b/i.test(s)) score += 1;
  return score;
}

function dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    // Strip terminal punctuation so "foo." and "foo!" dedupe together.
    const k = x
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.!?…]+$/u, '')
      .trim()
      .slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * Core extractor. Returns a structured report; rendering is separate so
 * callers can consume the data programmatically (e.g. surface action items
 * in a sidebar) without re-parsing markdown.
 *
 * @param {string} text
 * @param {{ maxPerBucket?: number }} [opts]
 */
function analyzeText(text, opts = {}) {
  const max = Math.max(1, Math.min(MAX_PER_BUCKET * 2, opts.maxPerBucket || MAX_PER_BUCKET));
  const empty = {
    claims: [], actions: [], decisions: [], openQuestions: [], risks: [],
    totals: { claims: 0, actions: 0, decisions: 0, openQuestions: 0, risks: 0 },
    sentenceCount: 0,
  };
  const raw = safeStr(text);
  if (!raw || raw.length < MIN_SENT_CHARS) return empty;

  const sentences = splitSentences(raw);
  if (sentences.length === 0) return empty;

  const claimsRaw = [];
  const actions = [];
  const decisions = [];
  const openQuestions = [];
  const risks = [];

  for (const s of sentences) {
    const low = s.toLowerCase();
    if (anyMatch(ACTION_PATTERNS, low)) actions.push(s);
    if (anyMatch(DECISION_PATTERNS, low)) decisions.push(s);
    if (s.endsWith('?') || anyMatch(QUESTION_PATTERNS, low)) openQuestions.push(s);
    if (anyMatch(RISK_PATTERNS, low)) risks.push(s);
    const score = claimScore(s);
    if (score >= 2) claimsRaw.push({ s, score });
  }

  // Claims: rank by score (desc), then by original order. Dedupe by leading
  // 80-char fingerprint so paraphrases don't crowd out distinct claims.
  claimsRaw.sort((a, b) => b.score - a.score);
  const claims = dedupeKeepOrder(claimsRaw.map((c) => c.s));

  return {
    claims: claims.slice(0, max).map(truncSent),
    actions: dedupeKeepOrder(actions).slice(0, max).map(truncSent),
    decisions: dedupeKeepOrder(decisions).slice(0, max).map(truncSent),
    openQuestions: dedupeKeepOrder(openQuestions).slice(0, max).map(truncSent),
    risks: dedupeKeepOrder(risks).slice(0, max).map(truncSent),
    totals: {
      claims: claims.length,
      actions: actions.length,
      decisions: decisions.length,
      openQuestions: openQuestions.length,
      risks: risks.length,
    },
    sentenceCount: sentences.length,
  };
}

/**
 * Batch wrapper matching the buildXForFiles(files) convention used by the
 * other analyzer modules in this directory.
 *
 * @param {Array<{ originalName?: string, filename?: string, name?: string, extractedText?: string, text?: string }>} files
 */
function buildDeepAnalysisForFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : [];
  const perFile = [];
  const aggregate = {
    claims: [], actions: [], decisions: [], openQuestions: [], risks: [],
    totals: { claims: 0, actions: 0, decisions: 0, openQuestions: 0, risks: 0 },
    sentenceCount: 0,
  };
  for (const f of list) {
    const text = safeStr(f.extractedText || f.text);
    if (!text) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    const report = analyzeText(text);
    if (report.sentenceCount === 0) continue;
    perFile.push({ file: label, report });
    for (const k of ['claims', 'actions', 'decisions', 'openQuestions', 'risks']) {
      aggregate[k] = aggregate[k].concat(report[k]);
      aggregate.totals[k] += report.totals[k];
    }
    aggregate.sentenceCount += report.sentenceCount;
  }
  // Dedupe aggregate per bucket so multi-file uploads with repeated boilerplate
  // (e.g. cover page across PDFs) don't blow up the block.
  for (const k of ['claims', 'actions', 'decisions', 'openQuestions', 'risks']) {
    aggregate[k] = dedupeKeepOrder(aggregate[k]).slice(0, MAX_PER_BUCKET);
  }
  return { perFile, aggregate };
}

function renderBuckets(report, opts = {}) {
  const lines = [];
  const sections = [
    ['Key claims', report.claims, 'Each claim is a sentence-level assertion grounded in numbers, dates, or attribution. Verify before quoting.'],
    ['Action items', report.actions, 'Imperative / deliverable language. Treat as candidate TODOs, not commitments.'],
    ['Decisions', report.decisions, 'Statements presented as resolutions. The document asserts they happened.'],
    ['Open questions', report.openQuestions, 'Explicitly unresolved. Surface to the user as gaps before answering definitively.'],
    ['Risks & red flags', report.risks, 'Risk / threat / failure language. Cross-reference with the CONSISTENCY block if present.'],
  ];
  for (const [title, items, hint] of sections) {
    if (!items || items.length === 0) continue;
    lines.push(`### ${title}`);
    if (opts.hints !== false) lines.push(`_${hint}_`);
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Render the DEEP DOCUMENT ANALYSIS markdown block. Returns '' when there is
 * nothing worth surfacing — callers splice the result unconditionally.
 *
 * @param {ReturnType<buildDeepAnalysisForFiles>} batchReport
 */
function renderDeepAnalysisBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) {
    return '';
  }
  const hasAnything = batchReport.perFile.some((p) => {
    const t = p.report.totals;
    return t.claims + t.actions + t.decisions + t.openQuestions + t.risks > 0;
  });
  if (!hasAnything) return '';

  const heading = `## DEEP DOCUMENT ANALYSIS
Sentence-level extraction of claims, actions, decisions, open questions and risks across the attached document(s). These are CANDIDATES surfaced from the raw text — quote verbatim only after confirming the surrounding context. Prefer this block over inventing new claims when the user asks "what does it say about…".`;

  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    const body = renderBuckets(only.report);
    if (body) sections.push(body);
  } else {
    const agg = renderBuckets(batchReport.aggregate);
    if (agg) {
      sections.push('### Aggregate across all files');
      sections.push(agg);
    }
    for (const p of batchReport.perFile) {
      const body = renderBuckets(p.report, { hints: false });
      if (!body) continue;
      sections.push(`### File: ${p.file}`);
      sections.push(body);
    }
  }

  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...deep analysis block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  analyzeText,
  buildDeepAnalysisForFiles,
  renderDeepAnalysisBlock,
  _internal: {
    splitSentences,
    claimScore,
    dedupeKeepOrder,
    ACTION_PATTERNS,
    DECISION_PATTERNS,
    QUESTION_PATTERNS,
    RISK_PATTERNS,
    MAX_BLOCK_CHARS,
    MAX_PER_BUCKET,
  },
};
