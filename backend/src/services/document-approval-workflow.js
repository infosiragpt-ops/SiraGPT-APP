'use strict';

/**
 * document-approval-workflow.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects APPROVAL-WORKFLOW stages stamped on documents — "Drafted
 * by", "Reviewed by", "Approved by", "Signed by", "Released by",
 * with the named individual / role and optional date. Different from
 * document-signature-block (tail signature rows for legal sign-off):
 * this captures workflow STAGES that often appear in version blocks,
 * change-control headers, or document footers.
 *
 * Public API:
 *   extractApprovalStages(text)            → ApprovalReport
 *   buildApprovalsForFiles(files)          → { perFile, aggregate }
 *   renderApprovalsBlock(report)           → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 8_000;
const TAIL_SCAN_BYTES = 8_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 3800;

const STAGE_PATTERNS = [
  { stage: 'drafted',  re: /\b(?:Drafted|Authored|Prepared|Written)\s+by\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/im },
  { stage: 'drafted',  re: /(?:^|[^\p{L}])(?:Redactado|Redactada|Preparado|Preparada|Escrito|Escrita|Elaborado|Elaborada)\s+por\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/imu },
  { stage: 'reviewed', re: /\b(?:Reviewed|Revised)\s+by\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/im },
  { stage: 'reviewed', re: /(?:^|[^\p{L}])(?:Revisado|Revisada)\s+por\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/imu },
  { stage: 'approved', re: /\b(?:Approved|Authorised|Authorized)\s+by\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/im },
  { stage: 'approved', re: /(?:^|[^\p{L}])(?:Aprobado|Aprobada|Autorizado|Autorizada)\s+por\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/imu },
  { stage: 'released', re: /\b(?:Released|Published|Issued)\s+by\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/im },
  { stage: 'released', re: /(?:^|[^\p{L}])(?:Lanzado|Lanzada|Publicado|Publicada|Emitido|Emitida)\s+por\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/imu },
  { stage: 'signed',   re: /\b(?:Signed)\s+by\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/im },
  { stage: 'signed',   re: /(?:^|[^\p{L}])(?:Firmado|Firmada)\s+por\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s&]{3,80})(?=\n|$|\s*Date|\s*Fecha)/imu },
];

const DATE_NEAR_RE = /\bDate\s*[:\-]?\s*([0-9A-Za-zÁÉÍÓÚÑáéíóúñ ,\/-]{4,40})/i;
const FECHA_NEAR_RE = /\bFecha\s*[:\-]?\s*([0-9A-Za-zÁÉÍÓÚÑáéíóúñ ,\/-]{4,40})/i;

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

function cleanName(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').replace(/[,;]+$/g, '').trim();
}

function getScanWindow(text) {
  if (!text) return '';
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const tail = text.length > TAIL_SCAN_BYTES ? text.slice(-TAIL_SCAN_BYTES) : '';
  return `${head}\n${tail}`;
}

function findNearbyDate(text, idx) {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + 200);
  const window = text.slice(start, end);
  const en = window.match(DATE_NEAR_RE);
  if (en && en[1]) return cleanName(en[1]);
  const es = window.match(FECHA_NEAR_RE);
  if (es && es[1]) return cleanName(es[1]);
  return null;
}

function extractApprovalStages(input) {
  const text = safeText(input);
  if (!text) return { stages: [], total: 0 };
  const window = getScanWindow(text);
  const stages = [];
  const seen = new Set();
  for (const { stage, re } of STAGE_PATTERNS) {
    if (stages.length >= MAX_PER_FILE) break;
    const cloned = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of window.matchAll(cloned)) {
      if (stages.length >= MAX_PER_FILE) break;
      const name = cleanName(m[1] || '');
      if (!name || name.length < 3) continue;
      const date = findNearbyDate(window, (m.index || 0) + (m[0]?.length || 0));
      const key = `${stage}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stages.push({ stage, name: clip(name, 80), date });
    }
  }
  return { stages, total: stages.length };
}

function buildApprovalsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractApprovalStages(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, stages: r.stages });
    aggregate = aggregate.concat(r.stages.map((s) => ({ ...s, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(s, opts = {}) {
  const date = s.date ? ` _(date: ${s.date})_` : '';
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  return `- **${s.stage.toUpperCase()}** by **${s.name}**${file}${date}`;
}

function renderApprovalsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## APPROVAL WORKFLOW
Workflow-stage stamps surfaced from the head / tail of each attached document — Drafted by / Reviewed by / Approved by / Released by / Signed by + the named person/role and the nearest date. Useful for change-control and document-governance questions.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.stages) sections.push(renderLine(s));
  } else {
    sections.push('### Aggregate approvals across all files');
    for (const s of report.aggregate) sections.push(renderLine(s, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.stages) sections.push(renderLine(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...approvals block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractApprovalStages,
  buildApprovalsForFiles,
  renderApprovalsBlock,
  _internal: {
    cleanName,
    findNearbyDate,
    STAGE_PATTERNS,
    SCAN_HEAD_BYTES,
    TAIL_SCAN_BYTES,
  },
};
