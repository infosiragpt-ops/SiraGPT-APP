'use strict';

/**
 * document-decision-records.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Architecture Decision Record (ADR) style fields commonly used in
 * RFCs / design docs / architectural decision logs:
 *
 *   - "Decision: …"        (what was decided)
 *   - "Status: Accepted/Proposed/Superseded"  (lifecycle, narrower than status)
 *   - "Context: …"         (why we needed a decision)
 *   - "Consequences: …"    (impact of decision)
 *   - "Alternatives Considered: …"
 *   - "Trade-offs: …"
 *   - Spanish equivalents (Decisión / Contexto / Consecuencias / Alternativas /
 *     Compensaciones)
 *
 * Different from document-status (lifecycle markers anywhere) by tightly
 * coupling Decision/Context/Consequences into ADR-shaped entries.
 * Routes "what's the decision?", "why was this decided?", "what are
 * the alternatives?" to a citeable record.
 *
 * Public API:
 *   extractDecisionRecords(text)         → ADRReport
 *   buildDecisionRecordsForFiles(files)  → { perFile, aggregate, totals }
 *   renderDecisionRecordsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 5500;
const MAX_VALUE_LEN = 260;

const FIELD_PATTERNS = [
  { field: 'decision',     re: /^[\t ]*(?:#{1,6}\s+)?(?:Decision|Decisi[óo]n)\s*[:\-—]\s*([^\n]+)$/gim },
  { field: 'context',      re: /^[\t ]*(?:#{1,6}\s+)?(?:Context|Contexto)\s*[:\-—]\s*([^\n]+)$/gim },
  { field: 'consequences', re: /^[\t ]*(?:#{1,6}\s+)?(?:Consequences?|Consecuencias?)\s*[:\-—]\s*([^\n]+)$/gim },
  { field: 'alternatives', re: /^[\t ]*(?:#{1,6}\s+)?(?:Alternatives(?:\s+considered)?|Alternativas(?:\s+consideradas?)?)\s*[:\-—]\s*([^\n]+)$/gim },
  { field: 'tradeoffs',    re: /^[\t ]*(?:#{1,6}\s+)?(?:Trade-?offs?|Compensaciones)\s*[:\-—]\s*([^\n]+)$/gim },
  { field: 'rationale',    re: /^[\t ]*(?:#{1,6}\s+)?(?:Rationale|Justificaci[óo]n|Motivaci[óo]n)\s*[:\-—]\s*([^\n]+)$/gim },
];

const FIELDS = ['decision', 'context', 'consequences', 'alternatives', 'tradeoffs', 'rationale'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_VALUE_LEN) return s;
  return `${s.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyByField() {
  const r = {};
  for (const f of FIELDS) r[f] = 0;
  return r;
}

function extractDecisionRecords(input) {
  const text = safeText(input);
  if (!text) return { records: [], total: 0, byField: emptyByField(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const records = [];
  const seen = new Set();
  const byField = emptyByField();

  for (const { field, re } of FIELD_PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (records.length >= MAX_PER_FILE) break;
      const value = clipValue(m[1]);
      if (!value) continue;
      const key = `${field}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ field, value });
      byField[field] += 1;
    }
  }

  return { records, total: records.length, byField, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildDecisionRecordsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byField = emptyByField();
  for (const f of list) {
    const r = extractDecisionRecords(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, records: r.records, byField: r.byField });
    aggregate = aggregate.concat(r.records.map((rec) => ({ ...rec, file: name })));
    for (const k of FIELDS) byField[k] += r.byField[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byField };
}

function renderRecord(r, opts = {}) {
  const file = opts.includeFile && r.file ? ` _(${r.file})_` : '';
  return `- **${r.field}**${file}: ${r.value}`;
}

function renderDecisionRecordsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byField = report.byField || emptyByField();
  const breakdown = FIELDS
    .filter((k) => byField[k] > 0)
    .map((k) => `${k}=${byField[k]}`)
    .join('  ');
  const heading = `## DECISION RECORDS (ADR)
Architecture Decision Record fields detected in the document(s): Decision / Context / Consequences / Alternatives / Trade-offs / Rationale, including Spanish equivalents (Decisión / Contexto / Consecuencias / Alternativas / Compensaciones / Justificación). Different from generic status markers by tightly coupling ADR-shaped fields. Routes "what's the decision?" / "why was this decided?" / "what are the alternatives?" to a citeable record.

**By field:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const r of only.records) sections.push(renderRecord(r));
  } else {
    sections.push('### Aggregate ADR fields across all files');
    for (const r of report.aggregate) sections.push(renderRecord(r, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const r of p.records) sections.push(renderRecord(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...decision records block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDecisionRecords,
  buildDecisionRecordsForFiles,
  renderDecisionRecordsBlock,
  _internal: {
    FIELD_PATTERNS,
    FIELDS,
  },
};
