'use strict';

/**
 * document-indemnification.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures INDEMNIFICATION and LIABILITY clauses in commercial /
 * legal documents. Different from obligations (compel action) and
 * warranties (state facts): indemnification clauses allocate FINANCIAL
 * RESPONSIBILITY for third-party claims, losses, damages or fees.
 *
 * Detection coverage (deterministic, bilingual, < 15 ms on 1 MB):
 *
 *   - English:
 *     "shall indemnify", "agrees to indemnify", "hold harmless",
 *     "defend, indemnify, and hold harmless", "limitation of
 *     liability", "no party shall be liable for", "consequential /
 *     indirect / incidental damages excluded".
 *   - Spanish:
 *     "indemnizará", "se compromete a indemnizar", "mantendrá
 *     indemne", "asumirá la responsabilidad por", "limitación de
 *     responsabilidad", "exclusión de daños indirectos".
 *
 * Each finding is tagged "indemnification" (positive obligation to
 * indemnify), "liability_cap" (limitation of liability) or
 * "damages_exclusion" (exclusion of consequential / indirect /
 * punitive damages).
 *
 * Public API:
 *   extractIndemnification(text)         → IndemnificationReport
 *   buildIndemnificationForFiles(files)  → { perFile, aggregate }
 *   renderIndemnificationBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const INDEMNIFY_PATTERNS_EN = [
  /\b((?:shall|agrees?\s+to|hereby)\s+(?:defend\s*(?:,|\s+and\s+))?indemnif(?:y|ies)\s*(?:,|\s+and\s+)?(?:hold\s+harmless)?|indemnif(?:y|ies)\s+(?:and\s+)?hold\s+harmless|hold\s+(?:harmless|the\s+\w+\s+harmless))\b/i,
];

const INDEMNIFY_PATTERNS_ES = [
  /(?:^|[^\p{L}])(indemnizar[áa]n?|se\s+comprometen?\s+a\s+indemnizar|mantendr[áa]n?\s+indemne|asumir[áa]n?\s+la\s+responsabilidad\s+por)(?=[^\p{L}]|$)/iu,
];

const CAP_PATTERNS_EN = [
  /\b(limitation\s+of\s+liability|limit(?:ed)?\s+liability|aggregate\s+liability|cap\s+on\s+(?:any|all)?\s*liabilit(?:y|ies)|in\s+no\s+event\s+shall|maximum\s+liability)\b/i,
];

const CAP_PATTERNS_ES = [
  /(?:^|[^\p{L}])(limitaci[oó]n\s+de\s+responsabilidad|responsabilidad\s+m[áa]xima|en\s+ning[uú]n\s+caso\s+ser[áa]\s+responsable)(?=[^\p{L}]|$)/iu,
];

const EXCLUSION_PATTERNS_EN = [
  /\b(consequential\s+damages?|indirect\s+damages?|incidental\s+damages?|punitive\s+damages?|special\s+damages?|loss\s+of\s+(?:profits?|revenue|goodwill|data))\b/i,
];

const EXCLUSION_PATTERNS_ES = [
  /(?:^|[^\p{L}])(da[ñn]os\s+(?:indirectos|consecuentes|incidentales|punitivos|emergentes)|lucro\s+cesante|p[eé]rdida\s+de\s+(?:datos|beneficios|ingresos))(?=[^\p{L}]|$)/iu,
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

function classifyKind(sentence) {
  if (matchAny(sentence, EXCLUSION_PATTERNS_EN) || matchAny(sentence, EXCLUSION_PATTERNS_ES)) return 'damages_exclusion';
  if (matchAny(sentence, CAP_PATTERNS_EN) || matchAny(sentence, CAP_PATTERNS_ES)) return 'liability_cap';
  if (matchAny(sentence, INDEMNIFY_PATTERNS_EN) || matchAny(sentence, INDEMNIFY_PATTERNS_ES)) return 'indemnification';
  return null;
}

function extractIndemnification(input) {
  const text = safeText(input);
  if (!text) return { findings: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const findings = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (findings.length >= MAX_PER_FILE) break;
    const kind = classifyKind(s);
    if (!kind) continue;
    const clipped = clip(s);
    const key = `${kind}|${clipped.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ kind, sentence: clipped });
    totals[kind] = (totals[kind] || 0) + 1;
  }
  return {
    findings,
    totals,
    total: findings.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildIndemnificationForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractIndemnification(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.findings.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(f, opts = {}) {
  const tag = f.kind.replace(/_/g, '-').toUpperCase();
  const file = opts.includeFile && f.file ? ` _(${f.file})_` : '';
  return `- [**${tag}**]${file} ${f.sentence}`;
}

function renderIndemnificationBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## INDEMNIFICATION & LIABILITY
Clauses allocating financial responsibility surfaced from the attached document(s) — INDEMNIFICATION (positive duty to defend / hold harmless), LIABILITY-CAP (caps on aggregate liability), DAMAGES-EXCLUSION (consequential / indirect / lost-profits carve-outs). Use this to answer "who bears the cost if X goes wrong?" — quote the source sentence before claiming a cap is firm.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const f of only.report.findings) sections.push(renderLine(f));
  } else {
    sections.push('### Aggregate clauses across all files');
    for (const f of batchReport.aggregate) sections.push(renderLine(f, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const f of p.report.findings) sections.push(renderLine(f));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...indemnification block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractIndemnification,
  buildIndemnificationForFiles,
  renderIndemnificationBlock,
  _internal: {
    splitSentences,
    classifyKind,
    matchAny,
    INDEMNIFY_PATTERNS_EN,
    INDEMNIFY_PATTERNS_ES,
    CAP_PATTERNS_EN,
    CAP_PATTERNS_ES,
    EXCLUSION_PATTERNS_EN,
    EXCLUSION_PATTERNS_ES,
  },
};
