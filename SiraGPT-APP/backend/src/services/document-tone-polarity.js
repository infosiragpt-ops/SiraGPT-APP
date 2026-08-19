'use strict';

/**
 * document-tone-polarity.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes per-document tone polarity via positive/negative word-frequency
 * heuristic. Different from document-sentiment by being a lightweight,
 * dependency-free quick scorer that complements the full sentiment block.
 *
 *   - Counts positive lexicon words: great, excellent, success, gain, etc.
 *   - Counts negative lexicon words: failure, broken, terrible, risk, etc.
 *   - Returns net polarity score (-1.0 to +1.0)
 *   - Classifies as positive / negative / neutral / mixed
 *
 * Routes "what's the tone?" / "is this positive?" to a citeable summary.
 *
 * Public API:
 *   extractTonePolarity(text)         → TonePolarityReport
 *   buildTonePolarityForFiles(files)  → { perFile }
 *   renderTonePolarityBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_BLOCK_CHARS = 4000;
const MIN_TOKENS = 12;

const POSITIVE = new Set([
  'great', 'excellent', 'success', 'successful', 'achieve', 'achieved', 'achievement',
  'gain', 'gains', 'profit', 'profitable', 'positive', 'good', 'best', 'better',
  'improve', 'improved', 'improvement', 'effective', 'efficient', 'powerful',
  'reliable', 'safe', 'secure', 'beneficial', 'benefit', 'benefits',
  'win', 'wins', 'winning', 'strong', 'strongly', 'recommend', 'recommended',
  'love', 'loved', 'amazing', 'fantastic', 'outstanding', 'remarkable',
  'helpful', 'satisfaction', 'satisfied', 'happy', 'glad', 'pleased',
  'innovative', 'breakthrough', 'optimal', 'optimised', 'optimized',
  // Spanish
  'éxito', 'exitoso', 'logro', 'ganancia', 'beneficio', 'positivo', 'bueno', 'mejor',
  'mejorar', 'efectivo', 'eficiente', 'recomiendo', 'excelente', 'fantástico',
  'feliz', 'satisfecho', 'innovador', 'óptimo',
]);

const NEGATIVE = new Set([
  'fail', 'fails', 'failure', 'failed', 'failing',
  'broken', 'break', 'broke', 'bug', 'bugs', 'buggy',
  'error', 'errors', 'issue', 'issues', 'problem', 'problems',
  'risk', 'risks', 'risky', 'danger', 'dangerous', 'hazard',
  'critical', 'severe', 'terrible', 'horrible', 'awful',
  'loss', 'losses', 'lose', 'lost', 'losing',
  'decline', 'declined', 'reduce', 'reduced', 'reduction',
  'weak', 'weakness', 'poor', 'inferior', 'worse', 'worst',
  'concern', 'concerned', 'worry', 'worried', 'warning',
  'crisis', 'disaster', 'catastrophe', 'fatal', 'crash', 'crashed',
  // Spanish
  'fracaso', 'roto', 'falla', 'fallo', 'error', 'problema', 'riesgo',
  'peligro', 'crítico', 'severo', 'terrible', 'pérdida', 'reducir',
  'débil', 'pobre', 'peor', 'preocupación', 'crisis', 'desastre',
  'fatal', 'choque',
]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-záéíóúñüäöß]{2,30}/giu) || [];
}

function classify(score, posCount, negCount) {
  if (posCount + negCount < 3) return 'neutral';
  if (score >= 0.3) return 'positive';
  if (score <= -0.3) return 'negative';
  if (Math.abs(score) < 0.1 && posCount + negCount >= 6) return 'mixed';
  return 'neutral';
}

function extractTonePolarity(input) {
  const text = safeText(input);
  if (!text) return { score: 0, classification: 'neutral', posCount: 0, negCount: 0, tokens: 0 };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tokens = tokenize(head);
  if (tokens.length < MIN_TOKENS) {
    return { score: 0, classification: 'neutral', posCount: 0, negCount: 0, tokens: tokens.length };
  }
  let posCount = 0;
  let negCount = 0;
  for (const t of tokens) {
    if (POSITIVE.has(t)) posCount += 1;
    else if (NEGATIVE.has(t)) negCount += 1;
  }
  const total = posCount + negCount;
  const score = total === 0 ? 0 : Math.round(((posCount - negCount) / total) * 100) / 100;
  const classification = classify(score, posCount, negCount);
  return { score, classification, posCount, negCount, tokens: tokens.length };
}

function buildTonePolarityForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const r = extractTonePolarity(safeText(f.extractedText));
    if (r.posCount + r.negCount === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, ...r });
  }
  return { perFile };
}

function renderEntry(e) {
  const sign = e.score > 0 ? '+' : '';
  return `### File: ${e.file}\n- **${e.classification}** (score=${sign}${e.score})\n- pos=${e.posCount}  neg=${e.negCount}  tokens=${e.tokens}`;
}

function renderTonePolarityBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## TONE POLARITY
Lightweight per-document tone polarity computed from a curated positive/negative word lexicon (English + Spanish). Surfaces a normalised score in [-1, +1] and a classification (positive / negative / neutral / mixed). Complements the full sentiment block. Routes "what's the tone?" / "is this positive?" to a citeable summary.`;
  const sections = report.perFile.map(renderEntry);
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...tone polarity block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTonePolarity,
  buildTonePolarityForFiles,
  renderTonePolarityBlock,
  _internal: {
    POSITIVE,
    NEGATIVE,
    tokenize,
    classify,
  },
};
