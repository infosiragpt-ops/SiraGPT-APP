'use strict';

/**
 * document-checklists.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects markdown CHECKLIST items (- [ ] / - [x] / - [X]) in
 * attached documents and groups them under their nearest preceding
 * heading. Routes "what's still pending?" / "what's been done?" to a
 * checkable list with done/pending status.
 *
 * Different from document-action-dashboard (composes deep-analyzer
 * actions + temporal deadlines into a punch list): this module
 * surfaces EXPLICIT checkbox markers that the source already maintains.
 *
 * Public API:
 *   extractChecklists(text)              → ChecklistReport
 *   buildChecklistsForFiles(files)       → { perFile, aggregate }
 *   renderChecklistsBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_GROUPS_PER_FILE = 8;
const MAX_ITEMS_PER_GROUP = 12;
const MAX_AGGREGATE_ITEMS = 30;
const MAX_BLOCK_CHARS = 4200;
const MAX_ITEM_LEN = 200;

// - [ ] item / - [x] item / * [X] item / + [-] item (indeterminate)
const CHECKBOX_RE = /^(\s*)(?:[-*+])\s+\[([\sxX\-/?])\]\s+(.+)$/;

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

function classifyStatus(mark) {
  if (mark === 'x' || mark === 'X') return 'done';
  if (mark === '/' || mark === '-') return 'in-progress';
  if (mark === '?') return 'unclear';
  return 'pending';
}

function isHeading(line) {
  if (!line) return false;
  if (/^\s*#{1,6}\s+/.test(line)) return true;
  if (/^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s,.:;()/-]{4,80}$/.test(line.trim())) return true;
  if (/^\*\*[^*]+\*\*\s*$/.test(line.trim())) return true;
  return false;
}

function stripHeading(line) {
  return String(line || '').trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .trim();
}

function extractChecklists(input) {
  const text = safeText(input);
  if (!text) return { groups: [], totals: { done: 0, pending: 0, 'in-progress': 0, unclear: 0 }, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const lines = head.split('\n');
  const groups = [];
  let lastHeading = null;
  let currentGroup = null;
  const totals = { done: 0, pending: 0, 'in-progress': 0, unclear: 0 };
  for (const raw of lines) {
    if (isHeading(raw)) {
      lastHeading = stripHeading(raw);
      currentGroup = null;
      continue;
    }
    const m = raw.match(CHECKBOX_RE);
    if (!m) continue;
    const status = classifyStatus(m[2]);
    const body = clip((m[3] || '').trim(), MAX_ITEM_LEN);
    if (!body) continue;
    totals[status] = (totals[status] || 0) + 1;
    if (!currentGroup) {
      if (groups.length >= MAX_GROUPS_PER_FILE) break;
      currentGroup = { heading: lastHeading || 'Untitled checklist', items: [] };
      groups.push(currentGroup);
    }
    if (currentGroup.items.length < MAX_ITEMS_PER_GROUP) {
      currentGroup.items.push({ status, body });
    }
  }
  const total = totals.done + totals.pending + totals['in-progress'] + totals.unclear;
  return { groups, totals, total, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildChecklistsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractChecklists(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    for (const g of r.groups) {
      for (const item of g.items) {
        aggregate.push({ ...item, heading: g.heading, file: name });
      }
    }
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE_ITEMS);
  return { perFile, aggregate };
}

function statusMark(status) {
  switch (status) {
    case 'done':         return '[x]';
    case 'in-progress':  return '[/]';
    case 'unclear':      return '[?]';
    default:             return '[ ]';
  }
}

function renderGroup(group) {
  const lines = [`**${group.heading}**`];
  for (const item of group.items) lines.push(`- ${statusMark(item.status)} ${item.body}`);
  return lines.join('\n');
}

function renderChecklistsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## CHECKLISTS & TODOs
Checkable items surfaced from the attached document(s) grouped under their nearest preceding heading. Done items are marked [x]; pending [ ]; in-progress [/]; unclear [?]. Use this block to answer "what's still pending?" / "what's been done?" — quote the bullet verbatim.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file} — ${only.report.totals.done} done, ${only.report.totals.pending} pending, ${only.report.totals['in-progress']} in-progress`);
    for (const g of only.report.groups) sections.push(renderGroup(g));
  } else {
    for (const p of report.perFile) {
      sections.push(`### File: ${p.file}`);
      for (const g of p.report.groups) sections.push(renderGroup(g));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...checklists block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractChecklists,
  buildChecklistsForFiles,
  renderChecklistsBlock,
  _internal: {
    classifyStatus,
    isHeading,
    stripHeading,
    statusMark,
    CHECKBOX_RE,
  },
};
