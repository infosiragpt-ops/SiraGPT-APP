'use strict';

/**
 * document-qa-pairs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects explicit question + answer pairs in attached documents
 * (FAQs, runbooks, knowledge-base articles, customer-support docs).
 * Lets the chat answer "where does it cover question X?" or "what
 * does the FAQ say?" with the source pair verbatim.
 *
 * Coverage (deterministic, bilingual, < 12 ms on 1 MB):
 *
 *   - "Q: …\nA: …" pairs (common FAQ shorthand)
 *   - "Question: …\nAnswer: …"
 *   - "Pregunta: …\nRespuesta: …"
 *   - Numbered FAQs: "1. How do I X?\nYou X by …"
 *   - Markdown-style: "**How do I X?**\nText follows."
 *
 * Each pair is emitted as { question, answer } with the answer
 * clipped to MAX_ANSWER_LEN so the block stays within budget.
 *
 * Public API:
 *   extractQaPairs(text)                → QaReport
 *   buildQaForFiles(files)              → { perFile, aggregate }
 *   renderQaBlock(report)               → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PAIRS_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4200;
const MAX_QUESTION_LEN = 180;
const MAX_ANSWER_LEN = 280;

const QA_PATTERNS = [
  // "Q: foo? A: bar."
  /(?:^|\n)\s*Q\s*[.:)\-]\s*([^\n?!]{6,180}\??)\s*\n\s*A\s*[.:)\-]\s*([^\n]{6,500})/gi,
  // "Question: foo? Answer: bar."
  /(?:^|\n)\s*Question\s*[.:)\-]\s*([^\n?!]{6,180}\??)\s*\n\s*Answer\s*[.:)\-]\s*([^\n]{6,500})/gi,
  // "Pregunta: foo? Respuesta: bar."
  /(?:^|\n)\s*Pregunta\s*[.:)\-]\s*([^\n?!]{6,180}\??)\s*\n\s*Respuesta\s*[.:)\-]\s*([^\n]{6,500})/gi,
  // Numbered FAQ: "1. How do I X?\nText follows."
  /(?:^|\n)\s*\d+[.)]\s+([A-Z¿][^\n?!]{6,180}\??)\s*\n([^\n]{12,500})/g,
  // Markdown-style: "**How do I X?**\nText follows."
  /\*\*([A-Z¿][^\n?!]{6,180}\??)\*\*\s*\n([^\n]{12,500})/g,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function clean(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function looksLikeQuestion(s) {
  const stripped = String(s || '').trim();
  if (stripped.endsWith('?') || stripped.endsWith('？') || stripped.startsWith('¿')) return true;
  return /^(how|what|where|why|when|who|which|does|do|can|is|are|will|should|could|may|might|c[oó]mo|qu[eé]|d[oó]nde|por\s+qu[eé]|cu[áa]ndo|qui[eé]n|cu[áa]l|puedo|puede|debe|ser[áa])(?=[^\p{L}]|$)/iu.test(stripped);
}

function extractQaPairs(input) {
  const text = safeText(input);
  if (!text) return { pairs: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const pairs = [];
  const seen = new Set();
  for (const re of QA_PATTERNS) {
    if (pairs.length >= MAX_PAIRS_PER_FILE) break;
    const cloned = new RegExp(re.source, re.flags);
    for (const m of head.matchAll(cloned)) {
      if (pairs.length >= MAX_PAIRS_PER_FILE) break;
      const question = clean(m[1] || '');
      const answer = clean(m[2] || '');
      if (!question || !answer) continue;
      if (!looksLikeQuestion(question)) continue;
      const key = `${question.toLowerCase().slice(0, 60)}|${answer.toLowerCase().slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        question: clip(question, MAX_QUESTION_LEN),
        answer: clip(answer, MAX_ANSWER_LEN),
      });
    }
  }
  return { pairs, total: pairs.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildQaForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractQaPairs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, pairs: r.pairs });
    aggregate = aggregate.concat(r.pairs.map((p) => ({ ...p, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderPair(p, opts = {}) {
  const file = opts.includeFile && p.file ? ` _(${p.file})_` : '';
  return `- **Q**${file}: ${p.question}\n  **A**: ${p.answer}`;
}

function renderQaBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## Q&A PAIRS
Explicit question + answer pairs surfaced from the attached document(s) (FAQs, runbooks, knowledge-base articles). Use this block when the user's question semantically matches one of the captured questions — quote the answer verbatim before adding any synthesis.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const p of only.pairs) sections.push(renderPair(p));
  } else {
    sections.push('### Aggregate Q&A pairs across all files');
    for (const p of report.aggregate) sections.push(renderPair(p, { includeFile: true }));
    for (const file of report.perFile) {
      sections.push(`\n### File: ${file.file}`);
      for (const p of file.pairs) sections.push(renderPair(p));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...Q&A block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractQaPairs,
  buildQaForFiles,
  renderQaBlock,
  _internal: {
    looksLikeQuestion,
    clean,
    QA_PATTERNS,
    MAX_PAIRS_PER_FILE,
  },
};
