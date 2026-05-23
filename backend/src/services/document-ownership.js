'use strict';

/**
 * document-ownership.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ownership / DRI (Directly Responsible Individual) attributions in
 * documents — RFCs, design docs, planning docs, runbooks, tickets:
 *
 *   - "Owner: …" / "DRI: …" / "Assignee: …" / "Reporter: …"
 *   - "Author: …" / "Authors: …" / "Maintainer(s): …"
 *   - "Approved by: …" / "Reviewed by: …" / "Responsable: …"
 *   - "@username" mentions when in an assignee-y context
 *   - "Stakeholder: …", "Lead: …", "Driver: …" (DACI)
 *
 * Routes "who owns this?", "who's the DRI?", "who's the reviewer?"
 * to a structured citeable list — different from
 * document-stakeholder-map (which catalogs parties/groups) by
 * focusing on per-document role attribution.
 *
 * Public API:
 *   extractOwnership(text)          → OwnershipReport
 *   buildOwnershipForFiles(files)   → { perFile, aggregate, byRole }
 *   renderOwnershipBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5500;
const MAX_VALUE_LEN = 160;

// Labeled-line patterns: ROLE: name
const LABELED_LINE_RE = /^[\t ]*(Owner|DRI|Assignee|Assigned[\s-]?to|Reporter|Reported[\s-]?by|Author|Authors|Maintainer|Maintainers|Approved[\s-]?by|Reviewed[\s-]?by|Reviewer|Reviewers|Stakeholder|Stakeholders|Lead|Tech[\s-]?Lead|Driver|Approver|Consulted|Informed|Responsable|Propietario|Autor|Autores|Asignado[\s-]?a|Revisado[\s-]?por|Aprobado[\s-]?por)\s*[:\-—]\s*([^\n]+)$/gim;

// Roles normalised → canonical bucket
const ROLE_MAP = {
  owner: 'owner',
  dri: 'owner',
  responsable: 'owner',
  propietario: 'owner',

  assignee: 'assignee',
  'assigned to': 'assignee',
  'assigned-to': 'assignee',
  'asignado a': 'assignee',
  'asignado-a': 'assignee',

  reporter: 'reporter',
  'reported by': 'reporter',
  'reported-by': 'reporter',

  author: 'author',
  authors: 'author',
  autor: 'author',
  autores: 'author',
  maintainer: 'author',
  maintainers: 'author',

  reviewer: 'reviewer',
  reviewers: 'reviewer',
  'reviewed by': 'reviewer',
  'reviewed-by': 'reviewer',
  'revisado por': 'reviewer',
  'revisado-por': 'reviewer',

  'approved by': 'approver',
  'approved-by': 'approver',
  approver: 'approver',
  'aprobado por': 'approver',
  'aprobado-por': 'approver',

  stakeholder: 'stakeholder',
  stakeholders: 'stakeholder',
  consulted: 'stakeholder',
  informed: 'stakeholder',

  lead: 'lead',
  'tech lead': 'lead',
  'tech-lead': 'lead',
  driver: 'lead',
};

const ROLES = ['owner', 'assignee', 'reporter', 'author', 'reviewer', 'approver', 'stakeholder', 'lead'];

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

function normaliseRole(label) {
  const key = (label || '').toLowerCase().trim().replace(/[_]/g, ' ');
  return ROLE_MAP[key] || null;
}

function extractOwnership(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, byRole: emptyByRole(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const m of head.matchAll(LABELED_LINE_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const rawLabel = (m[1] || '').toLowerCase().replace(/[-]/g, ' ').trim();
    const role = normaliseRole(rawLabel);
    if (!role) continue;
    const value = clipValue(m[2]);
    if (!value) continue;
    const key = `${role}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ role, label: m[1].trim(), value });
  }

  const byRole = countByRole(entries);
  return { entries, total: entries.length, byRole, truncated: text.length > SCAN_HEAD_BYTES };
}

function emptyByRole() {
  const r = {};
  for (const k of ROLES) r[k] = 0;
  return r;
}

function countByRole(entries) {
  const r = emptyByRole();
  for (const e of entries) {
    if (ROLES.includes(e.role)) r[e.role] += 1;
  }
  return r;
}

function buildOwnershipForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byRole = emptyByRole();
  for (const f of list) {
    const r = extractOwnership(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, byRole: r.byRole });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of ROLES) byRole[k] += r.byRole[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byRole };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- **${e.role}**${file} (${e.label}): ${e.value}`;
}

function renderOwnershipBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byRole = report.byRole || emptyByRole();
  const breakdown = ROLES
    .filter((k) => byRole[k] > 0)
    .map((k) => `${k}=${byRole[k]}`)
    .join('  ');
  const heading = `## OWNERSHIP / DRI
Per-document role attributions: Owner / DRI, Assignee, Reporter, Author(s) / Maintainer(s), Reviewer(s), Approver, Stakeholder, Lead/Driver (DACI / RACI / RFC conventions). Includes Spanish equivalents (Responsable / Propietario / Autor / Asignado a / Revisado por / Aprobado por). Routes "who owns this?" / "who's the DRI?" to a citeable list.

**By role:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate ownership across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...ownership block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractOwnership,
  buildOwnershipForFiles,
  renderOwnershipBlock,
  _internal: {
    LABELED_LINE_RE,
    ROLE_MAP,
    ROLES,
    normaliseRole,
  },
};
