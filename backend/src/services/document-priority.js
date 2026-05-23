'use strict';

/**
 * document-priority.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects priority / severity tags surfaced anywhere in document text:
 * P0–P4, SEV-1–SEV-5, severity Critical/High/Medium/Low, Blocker/Major/Minor/Trivial,
 * Urgency (Urgent/Normal/Low), priority labels with prefixes like "Priority: …".
 *
 * Output classifies into a normalised score (critical/high/medium/low/trivial)
 * so the chat can route "what are the critical items?" / "show me high priority"
 * to a citeable list of source spans.
 *
 * Different from document-risk-register (risk likelihood/impact)
 * and document-deep-analysis (general assessment).
 *
 * Public API:
 *   extractPriorities(text)          → PriorityReport
 *   buildPrioritiesForFiles(files)   → { perFile, aggregate, totals }
 *   renderPrioritiesBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 25;
const MAX_AGGREGATE = 40;
const MAX_BLOCK_CHARS = 6000;
const MAX_CONTEXT_LEN = 220;

const LEVELS = ['critical', 'high', 'medium', 'low', 'trivial'];

// Tag patterns — each captures a token + maps to a normalised level.
const TAG_PATTERNS = [
  // P0..P4 (ITIL-style)
  { re: /(?:^|[^\p{L}\p{N}])P0(?=[^\p{L}\p{N}]|$)/giu,  label: 'P0',  level: 'critical' },
  { re: /(?:^|[^\p{L}\p{N}])P1(?=[^\p{L}\p{N}]|$)/giu,  label: 'P1',  level: 'high'     },
  { re: /(?:^|[^\p{L}\p{N}])P2(?=[^\p{L}\p{N}]|$)/giu,  label: 'P2',  level: 'medium'   },
  { re: /(?:^|[^\p{L}\p{N}])P3(?=[^\p{L}\p{N}]|$)/giu,  label: 'P3',  level: 'low'      },
  { re: /(?:^|[^\p{L}\p{N}])P4(?=[^\p{L}\p{N}]|$)/giu,  label: 'P4',  level: 'trivial'  },
  // SEV-N / SEV N / Severity N
  { re: /\bSEV[\s\-_]?1\b/gi,  label: 'SEV-1',  level: 'critical' },
  { re: /\bSEV[\s\-_]?2\b/gi,  label: 'SEV-2',  level: 'high'     },
  { re: /\bSEV[\s\-_]?3\b/gi,  label: 'SEV-3',  level: 'medium'   },
  { re: /\bSEV[\s\-_]?4\b/gi,  label: 'SEV-4',  level: 'low'      },
  { re: /\bSEV[\s\-_]?5\b/gi,  label: 'SEV-5',  level: 'trivial'  },
  // Atlassian-style words (Blocker / Critical / Major / Minor / Trivial)
  { re: /\bBlocker\b/gi,       label: 'Blocker',  level: 'critical' },
  { re: /\bCritical\b/gi,      label: 'Critical', level: 'critical' },
  { re: /\bMajor\b/gi,         label: 'Major',    level: 'high'     },
  { re: /\bMinor\b/gi,         label: 'Minor',    level: 'low'      },
  { re: /\bTrivial\b/gi,       label: 'Trivial',  level: 'trivial'  },
  // Urgency words
  { re: /\bUrgent\b/gi,        label: 'Urgent',   level: 'high'     },
  // Spanish equivalents
  { re: /\bCr[íi]tico\b/giu,   label: 'Crítico',  level: 'critical' },
  { re: /\bAlto\b/giu,         label: 'Alto',     level: 'high'     },
  { re: /\bMedio\b/giu,        label: 'Medio',    level: 'medium'   },
  { re: /\bBajo\b/giu,         label: 'Bajo',     level: 'low'      },
  { re: /\bUrgente\b/giu,      label: 'Urgente',  level: 'high'     },
];

// Labeled lines like "Priority: High" / "Severity: P1" / "Prioridad: Alta"
const LABELED_LINE_RE = /^[\t ]*(Priority|Severity|Urgency|Prioridad|Severidad|Urgencia)\s*[:\-—]\s*([^\n]+)$/gim;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function normaliseLevel(token) {
  const t = (token || '').toLowerCase().trim();
  if (/\b(blocker|cr[íi]tico|critical|p0|sev[\s\-_]?1)\b/iu.test(t)) return 'critical';
  if (/\b(major|alta?|alto|high|urgent|urgente|p1|sev[\s\-_]?2)\b/iu.test(t)) return 'high';
  if (/\b(medium|medio|media|normal|p2|sev[\s\-_]?3)\b/iu.test(t)) return 'medium';
  if (/\b(minor|baja?|bajo|low|p3|sev[\s\-_]?4)\b/iu.test(t)) return 'low';
  if (/\b(trivial|p4|sev[\s\-_]?5)\b/iu.test(t)) return 'trivial';
  return null;
}

function contextFor(text, idx, len) {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len + 100);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function extractPriorities(input) {
  const text = safeText(input);
  if (!text) return { tags: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tags = [];
  const seen = new Set();

  for (const { re, label, level } of TAG_PATTERNS) {
    for (const m of head.matchAll(re)) {
      if (tags.length >= MAX_PER_FILE) break;
      const tokenIdx = m.index + m[0].search(/[^\s\W]|[A-Z]/) || m.index;
      const ctx = contextFor(head, m.index, m[0].length);
      const key = `${label}|${ctx.slice(0, 80).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push({ label, level, context: ctx });
    }
  }

  for (const m of head.matchAll(LABELED_LINE_RE)) {
    if (tags.length >= MAX_PER_FILE) break;
    const raw = (m[2] || '').trim();
    const level = normaliseLevel(raw);
    if (!level) continue;
    const label = `${m[1]}: ${raw.split(/\s+/).slice(0, 4).join(' ')}`;
    const ctx = contextFor(head, m.index, m[0].length);
    const key = `LABELED|${label.toLowerCase()}|${ctx.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push({ label, level, context: ctx, labeled: true });
  }

  const totals = countTotals(tags);
  return { tags, total: tags.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function emptyTotals() {
  return { critical: 0, high: 0, medium: 0, low: 0, trivial: 0 };
}

function countTotals(tags) {
  const t = emptyTotals();
  for (const tag of tags) {
    if (LEVELS.includes(tag.level)) t[tag.level] += 1;
  }
  return t;
}

function buildPrioritiesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractPriorities(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, tags: r.tags, totals: r.totals });
    aggregate = aggregate.concat(r.tags.map((t) => ({ ...t, file: name })));
    for (const k of LEVELS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderTag(tag, opts = {}) {
  const file = opts.includeFile && tag.file ? ` _(${tag.file})_` : '';
  return `- [${tag.level}] **${tag.label}**${file} — ${tag.context}`;
}

function renderPrioritiesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const totalsLine = LEVELS
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## PRIORITY / SEVERITY TAGS
Priority and severity markers detected verbatim in the document(s): P0–P4, SEV-1 through SEV-5, severity adjectives (Critical / Major / Minor / Trivial / Blocker), urgency markers (Urgent / Urgente), Spanish equivalents (Crítico / Alto / Medio / Bajo / Urgente), and labeled lines ("Priority: …", "Severidad: …"). Routes "what are the critical items?" or "show me P0 work" to a structured citeable list.

**Totals:** ${totalsLine}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const tag of only.tags) sections.push(renderTag(tag));
  } else {
    sections.push('### Aggregate priority tags across all files');
    for (const tag of report.aggregate) sections.push(renderTag(tag, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const tag of p.tags) sections.push(renderTag(tag));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...priority block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractPriorities,
  buildPrioritiesForFiles,
  renderPrioritiesBlock,
  _internal: {
    TAG_PATTERNS,
    LABELED_LINE_RE,
    normaliseLevel,
    LEVELS,
  },
};
