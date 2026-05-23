'use strict';

/**
 * document-status.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects document lifecycle / status markers: Status: Draft / Approved /
 * Deprecated / Active / Archived / In Review, Stage: Discovery / Build /
 * Beta / GA, RFC lifecycle (Proposed / Accepted / Rejected / Withdrawn /
 * Superseded), feature flag states (enabled / disabled / canary / rollout).
 *
 * Routes "what's the status?", "is this approved?", "is this still active?"
 * to a structured citeable signal — different from document-priority
 * (urgency/severity) and document-ownership (who owns it).
 *
 * Public API:
 *   extractStatus(text)             → StatusReport
 *   buildStatusForFiles(files)      → { perFile, aggregate, byBucket }
 *   renderStatusBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 120;

// Labeled status lines: "Status: …"
const LABELED_LINE_RE = /^[\t ]*(Status|State|Lifecycle|Stage|Estado|Etapa|Fase)\s*[:\-—]\s*([^\n]+)$/gim;

// Status values → bucketed lifecycle
const STATUS_BUCKETS = {
  draft: 'draft',
  borrador: 'draft',
  wip: 'draft',
  'work in progress': 'draft',
  'in progress': 'draft',
  proposed: 'draft',
  propuesto: 'draft',

  'in review': 'review',
  review: 'review',
  reviewing: 'review',
  'pending review': 'review',
  'en revisión': 'review',
  'en revision': 'review',
  revisando: 'review',
  rfc: 'review',

  approved: 'approved',
  accepted: 'approved',
  aprobado: 'approved',
  aceptado: 'approved',
  ratified: 'approved',
  signed: 'approved',
  firmado: 'approved',

  active: 'active',
  activo: 'active',
  live: 'active',
  ga: 'active',
  released: 'active',
  publicado: 'active',
  shipped: 'active',
  production: 'active',
  producción: 'active',
  produccion: 'active',

  rejected: 'rejected',
  rechazado: 'rejected',
  declined: 'rejected',
  denied: 'rejected',
  withdrawn: 'rejected',
  cancelled: 'rejected',
  cancelado: 'rejected',
  canceled: 'rejected',

  deprecated: 'deprecated',
  obsoleto: 'deprecated',
  superseded: 'deprecated',
  superseeded: 'deprecated',
  retired: 'deprecated',
  sunset: 'deprecated',

  archived: 'archived',
  archivado: 'archived',
  closed: 'archived',
  cerrado: 'archived',
  done: 'archived',
  completed: 'archived',
  completado: 'archived',
  resolved: 'archived',

  // Release stages
  alpha: 'pre-release',
  beta: 'pre-release',
  preview: 'pre-release',
  canary: 'pre-release',
  experimental: 'pre-release',
  discovery: 'pre-release',
  build: 'pre-release',
  exploration: 'pre-release',
};

const BUCKETS = ['draft', 'review', 'approved', 'active', 'rejected', 'deprecated', 'archived', 'pre-release'];

// Inline single-word callouts like "[DEPRECATED]" / "(DRAFT)" / "DEPRECATED:" at start of line
const INLINE_CALLOUT_RE = /(?:^|\n|\s)\[?\(?\b(DRAFT|DEPRECATED|ARCHIVED|ACTIVE|APPROVED|REJECTED|BETA|ALPHA|CANARY|SUPERSEDED|OBSOLETO|BORRADOR|ACEPTADO|RECHAZADO|APROBADO)\b\)?\]?(?:[:\s\-]|$)/g;

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

function bucketFor(value) {
  const v = (value || '').toLowerCase().trim();
  if (STATUS_BUCKETS[v]) return STATUS_BUCKETS[v];
  // First-token fallback (e.g. "Draft (last updated 2024)")
  const firstToken = v.split(/\s+/)[0];
  if (STATUS_BUCKETS[firstToken]) return STATUS_BUCKETS[firstToken];
  // Multi-token try (e.g. "in review")
  for (const key of Object.keys(STATUS_BUCKETS)) {
    if (key.includes(' ') && v.startsWith(key)) return STATUS_BUCKETS[key];
  }
  return null;
}

function extractStatus(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, byBucket: emptyBuckets(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const m of head.matchAll(LABELED_LINE_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const value = clipValue(m[2]);
    if (!value) continue;
    const bucket = bucketFor(value);
    if (!bucket) continue;
    const key = `${bucket}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ bucket, label: m[1].trim(), value, kind: 'labeled' });
  }

  for (const m of head.matchAll(INLINE_CALLOUT_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const token = (m[1] || '').toLowerCase();
    const bucket = STATUS_BUCKETS[token];
    if (!bucket) continue;
    const key = `${bucket}|${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ bucket, label: 'inline', value: m[1], kind: 'callout' });
  }

  return { entries, total: entries.length, byBucket: countBuckets(entries), truncated: text.length > SCAN_HEAD_BYTES };
}

function emptyBuckets() {
  const r = {};
  for (const k of BUCKETS) r[k] = 0;
  return r;
}

function countBuckets(entries) {
  const r = emptyBuckets();
  for (const e of entries) {
    if (BUCKETS.includes(e.bucket)) r[e.bucket] += 1;
  }
  return r;
}

function buildStatusForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byBucket = emptyBuckets();
  for (const f of list) {
    const r = extractStatus(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, byBucket: r.byBucket });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of BUCKETS) byBucket[k] += r.byBucket[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byBucket };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.bucket}]${file} **${e.label}**: ${e.value}`;
}

function renderStatusBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byBucket = report.byBucket || emptyBuckets();
  const breakdown = BUCKETS
    .filter((k) => byBucket[k] > 0)
    .map((k) => `${k}=${byBucket[k]}`)
    .join('  ');
  const heading = `## DOCUMENT STATUS / LIFECYCLE
Lifecycle markers detected in the document(s): Status / Stage / Lifecycle / State lines, plus inline callouts ([DRAFT], (DEPRECATED), SUPERSEDED:). Normalised into buckets — draft / review / approved / active / rejected / deprecated / archived / pre-release — and aggregated. Includes Spanish equivalents (Borrador / En revisión / Aprobado / Activo / Rechazado / Obsoleto / Archivado). Routes "is this approved?" / "what's the status?" / "is this still active?" to a citeable signal.

**By bucket:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate status across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...status block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractStatus,
  buildStatusForFiles,
  renderStatusBlock,
  _internal: {
    LABELED_LINE_RE,
    INLINE_CALLOUT_RE,
    STATUS_BUCKETS,
    BUCKETS,
    bucketFor,
  },
};
