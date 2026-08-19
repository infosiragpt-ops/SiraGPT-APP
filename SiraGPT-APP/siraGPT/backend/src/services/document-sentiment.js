'use strict';

/**
 * document-sentiment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-section sentiment scorer. Bilingual lexicon-based (no LLM,
 * no external dependency). Each section earns a polarity score in
 * [-1, +1] derived from positive vs negative term frequencies, then
 * is bucketed into:
 *
 *   - very-positive   ≥ +0.30
 *   - positive        ≥ +0.10
 *   - neutral         -0.10 < score < +0.10
 *   - negative        ≤ -0.10
 *   - very-negative   ≤ -0.30
 *
 * Hedges and intensifiers shift weight (e.g. "very risky" carries
 * more negative weight than "risky" alone). Negations within ±3
 * tokens flip the polarity contribution of the immediately following
 * sentiment word.
 *
 * Public API:
 *   scoreText(text)              → SectionScores
 *   buildSentimentForFiles(files) → { perFile, aggregate }
 *   renderSentimentBlock(report)  → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MIN_SECTION_LEN = 25;
const MAX_BLOCK_CHARS = 3600;
const MAX_SECTIONS_PER_FILE = 8;
const MAX_AGGREGATE_SECTIONS = 14;

const POSITIVE_TERMS = new Set([
  // English
  'excellent', 'outstanding', 'great', 'good', 'positive', 'success', 'successful',
  'improve', 'improved', 'improvement', 'increase', 'increased', 'grow', 'grew', 'growth',
  'achieve', 'achieved', 'win', 'wins', 'winning', 'gain', 'gained', 'gain',
  'opportunity', 'opportunities', 'strong', 'robust', 'reliable', 'efficient',
  'innovative', 'innovation', 'beneficial', 'profit', 'profitable', 'breakthrough',
  'milestone', 'celebrated', 'recommend', 'recommended', 'praised', 'support',
  'supported', 'collaborative', 'optimistic', 'thriving', 'leader', 'leading',
  // Spanish
  'excelente', 'sobresaliente', 'positivo', 'positiva', 'éxito', 'exitoso', 'exitosa',
  'mejor', 'mejorar', 'mejorado', 'mejorada', 'mejoría', 'aumentar', 'aumentó',
  'crecer', 'creció', 'crecimiento', 'lograr', 'logrado', 'ganar', 'ganó', 'ganancia',
  'oportunidad', 'oportunidades', 'fuerte', 'robusto', 'confiable', 'eficiente',
  'innovador', 'innovación', 'beneficioso', 'beneficio', 'rentable', 'celebrado',
  'recomendado', 'recomendada', 'recomendar', 'apoyado', 'colaborativo', 'optimista',
  'próspero', 'líder', 'lideró',
]);

const NEGATIVE_TERMS = new Set([
  // English
  'poor', 'bad', 'worse', 'worst', 'terrible', 'failure', 'failed', 'lose', 'loss',
  'losses', 'decline', 'declined', 'decrease', 'decreased', 'drop', 'dropped',
  'risk', 'risks', 'risky', 'concern', 'concerned', 'concerning', 'issue', 'issues',
  'problem', 'problems', 'critical', 'severe', 'breach', 'breaches', 'outage',
  'outages', 'crisis', 'collapse', 'collapsed', 'shortfall', 'delay', 'delayed',
  'unstable', 'volatile', 'liability', 'liabilities', 'fine', 'fines', 'penalty',
  'lawsuit', 'lawsuits', 'mistake', 'mistakes', 'error', 'errors', 'wrong',
  // Spanish
  'pobre', 'mal', 'malo', 'mala', 'peor', 'pésimo', 'terrible', 'fracaso', 'fracasó',
  'falla', 'fallido', 'perder', 'perdió', 'pérdida', 'pérdidas', 'declive', 'declinó',
  'disminuir', 'disminuyó', 'baja', 'bajó', 'cayó', 'riesgo', 'riesgos', 'riesgoso',
  'preocupación', 'preocupado', 'problema', 'problemas', 'crítico', 'severo',
  'brecha', 'caída', 'crisis', 'colapso', 'colapsó', 'retraso', 'retrasado',
  'inestable', 'volátil', 'responsabilidad', 'multa', 'multas', 'demanda', 'demandas',
  'error', 'errores', 'equivocación', 'incorrecto',
]);

const INTENSIFIERS = new Set([
  'very', 'extremely', 'highly', 'significantly', 'substantially', 'remarkably',
  'critically', 'severely', 'absolutely', 'completely', 'totally',
  'muy', 'extremadamente', 'altamente', 'significativamente', 'sumamente',
  'completamente', 'totalmente', 'críticamente', 'absolutamente',
]);

const NEGATIONS = new Set([
  'not', 'never', 'no', 'nor', "n't",
  'no', 'nunca', 'jamás', 'tampoco', 'sin',
]);

const HEADING_RES = [
  /^#{1,6}\s+(.{3,90})$/gm,
  /^(\d+(?:\.\d+){0,3})\s+([^\n]{3,90})$/gm,
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s,.:;()/-]{4,70})$/gm,
];

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

function detectHeadings(text) {
  const taken = new Set();
  const out = [];
  for (const re of HEADING_RES) {
    const cloned = new RegExp(re.source, re.flags);
    for (const m of text.matchAll(cloned)) {
      const idx = m.index ?? 0;
      if (taken.has(idx)) continue;
      taken.add(idx);
      out.push({ index: idx, title: (m[2] || m[1] || '').trim().replace(/\s+/g, ' ') });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function splitIntoSections(text) {
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const headings = detectHeadings(head);
  if (headings.length === 0) {
    return head
      .split(/\n{2,}/)
      .map((b, i) => ({ title: `Block ${i + 1}`, body: b.trim() }))
      .filter((s) => s.body.length >= MIN_SECTION_LEN)
      .slice(0, 20);
  }
  const out = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : head.length;
    const body = head.slice(start, end).trim();
    if (body.length < MIN_SECTION_LEN) continue;
    out.push({ title: clip(headings[i].title), body });
  }
  return out.slice(0, 20);
}

function scoreText(text) {
  if (!text) return { score: 0, label: 'neutral', positives: 0, negatives: 0 };
  const tokens = text.toLowerCase().match(/[\p{L}'-]+/gu) || [];
  let positives = 0;
  let negatives = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const intensity = i > 0 && INTENSIFIERS.has(tokens[i - 1]) ? 1.6 : 1;
    let polarity = 0;
    if (POSITIVE_TERMS.has(tok)) polarity = 1;
    else if (NEGATIVE_TERMS.has(tok)) polarity = -1;
    if (polarity !== 0) {
      // Check ±3 prior tokens for a negation that flips the polarity.
      const start = Math.max(0, i - 3);
      let negated = false;
      for (let j = start; j < i; j++) {
        if (NEGATIONS.has(tokens[j])) { negated = true; break; }
      }
      const final = negated ? -polarity : polarity;
      if (final > 0) positives += intensity;
      else negatives += intensity;
    }
  }
  const total = positives + negatives;
  const score = total === 0 ? 0 : Number(((positives - negatives) / total).toFixed(3));
  let label = 'neutral';
  if (score >= 0.3) label = 'very-positive';
  else if (score >= 0.1) label = 'positive';
  else if (score <= -0.3) label = 'very-negative';
  else if (score <= -0.1) label = 'negative';
  return { score, label, positives: Number(positives.toFixed(2)), negatives: Number(negatives.toFixed(2)) };
}

function buildSentimentForFile(text) {
  const sections = splitIntoSections(text);
  const scored = sections.map((s) => ({ title: s.title, ...scoreText(s.body) }));
  // Sort sections by absolute polarity so the rendered block leads with
  // the strongest signals; keep only top N.
  scored.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return scored.slice(0, MAX_SECTIONS_PER_FILE);
}

function buildSentimentForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const sections = buildSentimentForFile(text);
    if (sections.length === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, sections });
    aggregate = aggregate.concat(sections.map((s) => ({ ...s, file: name })));
  }
  aggregate.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  aggregate = aggregate.slice(0, MAX_AGGREGATE_SECTIONS);
  return { perFile, aggregate };
}

function renderSectionLine(s, opts = {}) {
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  return `- **${s.title}**${file} → ${s.label} (score ${s.score}, +${s.positives}/-${s.negatives})`;
}

function renderSentimentBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## DOCUMENT SENTIMENT
Per-section polarity surfaced from positive vs negative lexicon signals. Use this to detect tone shifts within a document (e.g. neutral intro → very-negative risks → positive conclusion) — values are heuristic, not a moral judgement.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.sections) sections.push(renderSectionLine(s));
  } else {
    sections.push('### Strongest-polarity sections across all files');
    for (const s of report.aggregate) sections.push(renderSectionLine(s, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.sections) sections.push(renderSectionLine(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...sentiment block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  scoreText,
  buildSentimentForFile,
  buildSentimentForFiles,
  renderSentimentBlock,
  _internal: {
    detectHeadings,
    splitIntoSections,
    POSITIVE_TERMS,
    NEGATIVE_TERMS,
    INTENSIFIERS,
    NEGATIONS,
    MAX_SECTIONS_PER_FILE,
  },
};
