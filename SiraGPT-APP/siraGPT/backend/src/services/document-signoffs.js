'use strict';

/**
 * document-signoffs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects closing salutations / sign-offs in emails, letters, memos:
 *
 *   - "Sincerely," "Best regards," "Best," "Kind regards,"
 *   - "Cheers," "Thanks," "Thank you,"
 *   - Spanish: "Saludos cordiales,", "Atentamente,", "Un saludo,"
 *   - Optional following name + role line
 *
 * Routes "who signed?", "what's the closing?" to a citeable list.
 * Different from document-ownership (DRI / Assignee in RFCs) by
 * focusing on letter/email epistolary structure.
 *
 * Public API:
 *   extractSignoffs(text)          → SignoffReport
 *   buildSignoffsForFiles(files)   → { perFile, aggregate, totals }
 *   renderSignoffsBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 40_000;
const MAX_PER_FILE = 8;
const MAX_AGGREGATE = 12;
const MAX_BLOCK_CHARS = 3500;
const MAX_NAME_LEN = 80;

const SIGNOFF_PHRASES = [
  'Sincerely', 'Best regards', 'Best', 'Kind regards', 'Warm regards', 'Regards',
  'Cheers', 'Thanks', 'Thank you', 'Many thanks', 'With thanks',
  'Yours truly', 'Yours sincerely', 'Yours faithfully', 'Respectfully',
  'Cordially', 'Warmly',
  'Saludos cordiales', 'Atentamente', 'Un saludo', 'Saludos', 'Cordialmente',
  'Atte', 'Atte.',
];

const SIGNOFF_RE = new RegExp(
  '(?:^|\\n)\\s*(' + SIGNOFF_PHRASES.map((s) => s.replace(/[.+\\-]/g, '\\$&')).join('|') + ')[,.!]?[ \\t]*(?:\\n+[ \\t]*([^\\n]{1,80}))?',
  'gim'
);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_NAME_LEN) return t;
  return `${t.slice(0, MAX_NAME_LEN - 1)}…`;
}

function isLikelyName(s) {
  if (!s) return false;
  // Reject if it looks like a header / next paragraph (starts with #, -, *, has too much punctuation)
  if (/^[#\-*>]/.test(s)) return false;
  if (s.length > 80) return false;
  // Must contain at least one letter
  return /[A-Za-zÀ-ÿ]/.test(s);
}

function extractSignoffs(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: { signoff: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const m of head.matchAll(SIGNOFF_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const phrase = m[1].trim();
    const candidateName = m[2] ? clipName(m[2]) : null;
    const name = isLikelyName(candidateName) ? candidateName : null;
    const key = `${phrase.toLowerCase()}|${(name || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ phrase, name });
  }

  return { entries, total: entries.length, totals: { signoff: entries.length }, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildSignoffsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  let total = 0;
  for (const f of list) {
    const r = extractSignoffs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    total += r.total;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals: { signoff: total } };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  const name = e.name ? ` — ${e.name}` : '';
  return `- **${e.phrase}**${name}${file}`;
}

function renderSignoffsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## SIGN-OFFS / CLOSING SALUTATIONS
Letter / email closings detected in the document(s): English (Sincerely / Best regards / Cheers / Thanks / Respectfully …) and Spanish (Saludos cordiales / Atentamente / Un saludo / Cordialmente …). Includes the following name/role line where present. Routes "who signed?" / "what's the closing?" to a citeable list.

**Total sign-offs:** ${report.totals?.signoff || 0}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate sign-offs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...sign-offs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSignoffs,
  buildSignoffsForFiles,
  renderSignoffsBlock,
  _internal: {
    SIGNOFF_RE,
    SIGNOFF_PHRASES,
    isLikelyName,
  },
};
