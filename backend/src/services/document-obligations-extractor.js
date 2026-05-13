'use strict';

/**
 * document-obligations-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls obligation clauses out of contracts, policies, SLAs and any
 * text where parties promise to do (or refrain from doing) something.
 * Different from the deep-analyzer's action bucket — that captures
 * generic deliverables; this module captures BINDING language with
 * modal verbs + subject attribution + (optional) deadline.
 *
 * Detection coverage (deterministic, no LLM, < 15 ms on 1 MB):
 *
 *   - English modals:    shall, must, will, agrees to, is required
 *                        to, undertakes to, is obligated to.
 *   - Spanish modals:    deber(á|án), tiene(n) que, se compromete(n)
 *                        a, debe(r), está obligado a.
 *   - Subject attribution: best-effort capture of the NP before the
 *     modal verb (Provider, Contractor, Tenant, Parte A …).
 *   - Polarity:           positive obligations ("shall deliver") vs
 *                        prohibitions ("shall not disclose").
 *   - Deadline reference: detects trailing "within N days", "by
 *                        2026-06-15", "no later than the closing
 *                        date" and attaches it to the obligation.
 *
 * Bilingual. Each obligation keeps its source sentence intact.
 *
 * Public API:
 *   extractObligations(text)              → ObligationReport
 *   buildObligationsForFiles(files)       → { perFile, aggregate }
 *   renderObligationsBlock(batchReport)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_OBLIGATIONS_PER_FILE = 14;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4400;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const OBLIGATION_MODALS_EN = [
  /\b(shall|must|will|agrees?\s+to|undertakes?\s+to|is\s+(?:required|obligated|obliged)\s+to|hereby\s+(?:agrees?|undertakes?)\s+to|covenants?\s+to|warrants\s+(?:and|that))\b/i,
];

const OBLIGATION_MODALS_ES = [
  /(?:^|[^\p{L}])(deber[áa]n?|tiene[n]?\s+que|se\s+comprometen?\s+a|est[áa]\s+obligad[oa]s?\s+a|se\s+obliga\s+a|deber\s+|queda\s+obligad[oa]|(?:no\s+)?podr[áa]n?|se\s+abstendr[áa]n?\s+de)(?=[^\p{L}]|$)/iu,
];

const PROHIBITION_HINTS = [
  /\b(shall\s+not|must\s+not|may\s+not|will\s+not|is\s+prohibited\s+from|is\s+forbidden\s+from)\b/i,
  /(?:^|[^\p{L}])(no\s+podr[áa]n?|no\s+deber[áa]n?|queda\s+prohibido|est[áa]\s+prohibid[oa]|se\s+abstendr[áa]n?\s+de)(?=[^\p{L}]|$)/iu,
];

const DEADLINE_PATTERNS = [
  /\bwithin\s+(\d{1,4})\s+(business\s+days?|days?|weeks?|months?|years?)\b/i,
  /\bby\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
  /\bno\s+later\s+than\s+([^.]{4,60})/i,
  /\bdentro\s+de\s+(\d{1,4})\s+(d[ií]as\s+h[áa]biles|d[ií]as|semanas|meses|a[ñn]os)/i,
  /\ben\s+un\s+plazo\s+(?:m[áa]ximo\s+)?de\s+(\d{1,4})\s+(d[ií]as|semanas|meses|a[ñn]os)/i,
  /\bantes\s+del?\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
];

const SUBJECT_PATTERNS = [
  /^([A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]+){0,4})\s+(?:shall|must|will|agrees|undertakes|is)\b/u,
  /^(?:The\s+|El\s+|La\s+|Los\s+|Las\s+|Un\s+|Una\s+)?([A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]+){0,3})\s+(?:deber|tiene|se\s+compromete|est[áa]\s+obligad|se\s+obliga|queda\s+obligad)/iu,
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
    .filter((s) => s.length >= MIN_SENTENCE_LEN && s.length <= 1500);
}

function isObligation(sentence) {
  for (const re of OBLIGATION_MODALS_EN) if (re.test(sentence)) return true;
  for (const re of OBLIGATION_MODALS_ES) if (re.test(sentence)) return true;
  return false;
}

function detectProhibition(sentence) {
  return PROHIBITION_HINTS.some((re) => re.test(sentence));
}

function detectDeadline(sentence) {
  for (const re of DEADLINE_PATTERNS) {
    const m = sentence.match(re);
    if (m) {
      if (m[2]) return `${m[1]} ${m[2]}`.trim();
      return (m[1] || '').trim();
    }
  }
  return null;
}

function detectSubject(sentence) {
  for (const re of SUBJECT_PATTERNS) {
    const m = sentence.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function extractObligations(input) {
  const text = safeText(input);
  if (!text) return { obligations: [], total: 0, prohibitions: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const obligations = [];
  const seen = new Set();
  for (const s of sentences) {
    if (obligations.length >= MAX_OBLIGATIONS_PER_FILE) break;
    if (!isObligation(s)) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    obligations.push({
      sentence: clipped,
      polarity: detectProhibition(s) ? 'prohibition' : 'positive',
      subject: detectSubject(s),
      deadline: detectDeadline(s),
    });
  }
  const prohibitions = obligations.filter((o) => o.polarity === 'prohibition').length;
  return { obligations, total: obligations.length, prohibitions, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildObligationsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractObligations(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.obligations.map((o) => ({ ...o, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderObligationLine(o, opts = {}) {
  const tag = o.polarity === 'prohibition' ? 'PROHIBITION' : 'OBLIGATION';
  const subj = o.subject ? `**${o.subject}** ` : '';
  const deadline = o.deadline ? ` _(deadline: ${o.deadline})_` : '';
  const fileTag = opts.includeFile && o.file ? ` _(${o.file})_` : '';
  return `- [**${tag}**]${fileTag} ${subj}${o.sentence}${deadline}`;
}

function renderObligationsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## DOCUMENT OBLIGATIONS
Binding clauses surfaced from the attached document(s), tagged as positive obligation or prohibition, with subject attribution when detectable and any explicit deadline. Use this block to answer "who is on the hook for what?" — quote the source sentence verbatim before claiming an obligation is firm.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const o of only.report.obligations) sections.push(renderObligationLine(o));
  } else {
    sections.push('### Aggregate obligations across all files');
    for (const o of batchReport.aggregate) sections.push(renderObligationLine(o, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const o of p.report.obligations) sections.push(renderObligationLine(o));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...obligations block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractObligations,
  buildObligationsForFiles,
  renderObligationsBlock,
  _internal: {
    splitSentences,
    isObligation,
    detectProhibition,
    detectDeadline,
    detectSubject,
    OBLIGATION_MODALS_EN,
    OBLIGATION_MODALS_ES,
    PROHIBITION_HINTS,
  },
};
