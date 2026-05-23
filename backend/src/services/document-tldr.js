'use strict';

/**
 * document-tldr.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic 3-bullet TL;DR per attached document. Composes signals
 * from existing analyzers without re-extracting them:
 *
 *   - Top 1 sentence by FACT SALIENCE (numbers + entities + dates,
 *     weighted by position-decay so the lede / opener wins ties).
 *   - Top 1 from the deep-analyzer's claim bucket when available.
 *   - Top 1 from the deep-analyzer's action / decision / risk bucket
 *     (in that priority order) when present, otherwise the 2nd
 *     highest-salience sentence.
 *
 * Each bullet stays a verbatim sentence from the source so the model
 * can quote them without hallucinating paraphrase.
 *
 * Bilingual. Deterministic. < 25 ms on 1 MB.
 *
 * Public API:
 *   buildTldrForFiles(files)           → { perFile }
 *   renderTldrBlock(report)            → markdown string ('' OK)
 */

let deepAnalyzerCache = null;
function getDeepAnalyzer() {
  if (deepAnalyzerCache) return deepAnalyzerCache;
  try { deepAnalyzerCache = require('./document-deep-analyzer'); } catch { deepAnalyzerCache = null; }
  return deepAnalyzerCache;
}

const SCAN_HEAD_BYTES = 60_000;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 260;
const MAX_BLOCK_CHARS = 3600;

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
    .filter((s) => s.length >= MIN_SENTENCE_LEN && s.length <= 1200);
}

function salience(sentence, index, totalSentences) {
  const numbers = (sentence.match(/\d+/g) || []).length;
  const percents = (sentence.match(/\d+\s?%/g) || []).length;
  const monies = (sentence.match(/[$€£¥]\s?\d|\bUSD\b|\bEUR\b/g) || []).length;
  const dates = (sentence.match(/\b\d{4}-\d{2}-\d{2}\b|\b(?:Q[1-4]\s+\d{4})\b/g) || []).length;
  const entities = (sentence.match(/\b[A-ZÁÉÍÓÚÑ][\p{L}\p{N}]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}]+){0,3}\b/gu) || []).length;
  const acronyms = (sentence.match(/\b[A-Z]{2,}[A-Z0-9]{0,4}\b/g) || []).length;
  // Position decay: earlier sentences score higher (lede bias).
  const posDecay = 1 - (index / Math.max(1, totalSentences)) * 0.4;
  const raw = numbers * 0.8 + percents * 1.2 + monies * 1.4 + dates * 1.4 + entities * 1.2 + acronyms * 0.8;
  return Number((raw * posDecay).toFixed(3));
}

function rankSentencesBySalience(sentences) {
  return sentences
    .map((s, i) => ({ sentence: s, index: i, score: salience(s, i, sentences.length) }))
    .sort((a, b) => b.score - a.score);
}

function pickClaim(text) {
  const deep = getDeepAnalyzer();
  if (!deep || typeof deep.analyzeText !== 'function') return null;
  try {
    const r = deep.analyzeText(text);
    if (r.claims && r.claims.length > 0) return r.claims[0];
  } catch { /* swallow */ }
  return null;
}

function pickActionable(text) {
  const deep = getDeepAnalyzer();
  if (!deep || typeof deep.analyzeText !== 'function') return null;
  try {
    const r = deep.analyzeText(text);
    if (r.actions && r.actions.length > 0) return { kind: 'action', sentence: r.actions[0] };
    if (r.decisions && r.decisions.length > 0) return { kind: 'decision', sentence: r.decisions[0] };
    if (r.risks && r.risks.length > 0) return { kind: 'risk', sentence: r.risks[0] };
    if (r.openQuestions && r.openQuestions.length > 0) return { kind: 'open-question', sentence: r.openQuestions[0] };
  } catch { /* swallow */ }
  return null;
}

function buildTldrForFile(text) {
  const trimmed = safeText(text);
  if (!trimmed) return { bullets: [] };
  const head = trimmed.length > SCAN_HEAD_BYTES ? trimmed.slice(0, SCAN_HEAD_BYTES) : trimmed;
  const sentences = splitSentences(head);
  if (sentences.length === 0) return { bullets: [] };
  const ranked = rankSentencesBySalience(sentences);
  const usedKeys = new Set();
  const bullets = [];
  const pushBullet = (kind, sentence) => {
    if (!sentence) return;
    const clipped = clip(sentence);
    const k = clipped.toLowerCase().slice(0, 50);
    if (usedKeys.has(k)) return;
    usedKeys.add(k);
    bullets.push({ kind, sentence: clipped });
  };

  // 1. Most salient sentence (factual / numeric anchor).
  if (ranked.length > 0) pushBullet('salient', ranked[0].sentence);
  // 2. Top deep-analyzer claim (verbatim).
  pushBullet('claim', pickClaim(head));
  // 3. Top actionable (action / decision / risk / open question) OR next
  //    salient sentence as a backup.
  const actionable = pickActionable(head);
  if (actionable) pushBullet(actionable.kind, actionable.sentence);
  if (bullets.length < 3 && ranked.length > 1) pushBullet('salient', ranked[1].sentence);
  if (bullets.length < 3 && ranked.length > 2) pushBullet('salient', ranked[2].sentence);
  return { bullets: bullets.slice(0, 3) };
}

function buildTldrForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const r = buildTldrForFile(safeText(f.extractedText));
    if (r.bullets.length === 0) continue;
    perFile.push({ file: safeFileName(f), bullets: r.bullets });
  }
  return { perFile };
}

function renderTldrBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## TL;DR
Three-bullet executive summary per attached document — salient lede + key claim + top actionable / decision / risk. Bullets are verbatim sentences from the source. Use these to open analytical answers; quote them rather than paraphrasing.`;
  const sections = report.perFile.map((entry) => {
    const head = `### ${entry.file}`;
    const lines = entry.bullets.map((b) => `- _[${b.kind}]_ ${b.sentence}`);
    return [head, ...lines].join('\n');
  });
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...TL;DR block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildTldrForFile,
  buildTldrForFiles,
  renderTldrBlock,
  _internal: {
    splitSentences,
    salience,
    rankSentencesBySalience,
    MIN_SENTENCE_LEN,
    MAX_SENTENCE_LEN,
  },
};
