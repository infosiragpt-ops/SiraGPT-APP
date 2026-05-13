'use strict';

/**
 * document-modals.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects modal verbs and their strength/normativity:
 *
 *   - Strong: must, shall, required to, deberá, tendrá
 *   - Recommended: should, ought to, debería
 *   - Permitted: may, can, podrá, puede
 *   - Possibility: could, might, podría
 *   - Prohibited: must not, shall not, no deberá
 *
 * Different from document-obligations (full clause extraction) by surfacing
 * the modal verb + strength. Different from document-conditional-clauses
 * (if/unless prose) by focusing on modal vocabulary. Routes "what's
 * required vs allowed?" to a citeable list.
 *
 * Public API:
 *   extractModals(text)         → ModalReport
 *   buildModalsForFiles(files)  → { perFile, aggregate, totals }
 *   renderModalsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 180;

const B = '(?<![A-Za-zÀ-ÿ0-9_])';
const E = '(?![A-Za-zÀ-ÿ0-9_])';

const MODAL_GROUPS = {
  strong: [new RegExp(`${B}must${E}`, 'gi'), new RegExp(`${B}shall${E}`, 'gi'), new RegExp(`${B}required\\s+to${E}`, 'gi'), new RegExp(`${B}deber[áa]${E}`, 'giu'), new RegExp(`${B}tendr[áa]${E}`, 'giu'), new RegExp(`${B}ha\\s+de${E}`, 'gi'), new RegExp(`${B}es\\s+obligatorio${E}`, 'gi')],
  recommended: [new RegExp(`${B}should${E}`, 'gi'), new RegExp(`${B}ought\\s+to${E}`, 'gi'), new RegExp(`${B}deber[íi]a${E}`, 'giu'), new RegExp(`${B}es\\s+recomendable${E}`, 'gi'), new RegExp(`${B}es\\s+recomendado${E}`, 'gi')],
  permitted: [new RegExp(`${B}may${E}`, 'gi'), new RegExp(`${B}can${E}`, 'gi'), new RegExp(`${B}podr[áa]${E}`, 'giu'), new RegExp(`${B}puede${E}`, 'gi'), new RegExp(`${B}es\\s+permitido${E}`, 'gi'), new RegExp(`${B}es\\s+aceptable${E}`, 'gi')],
  possibility: [new RegExp(`${B}could${E}`, 'gi'), new RegExp(`${B}might${E}`, 'gi'), new RegExp(`${B}podr[íi]a${E}`, 'giu'), new RegExp(`${B}puede\\s+que${E}`, 'gi'), new RegExp(`${B}quiz[áa]s?${E}`, 'giu')],
  prohibited: [new RegExp(`${B}must\\s+not${E}`, 'gi'), new RegExp(`${B}shall\\s+not${E}`, 'gi'), new RegExp(`${B}cannot${E}`, 'gi'), new RegExp(`${B}may\\s+not${E}`, 'gi'), new RegExp(`${B}no\\s+deber[áa]${E}`, 'giu'), new RegExp(`${B}no\\s+podr[áa]${E}`, 'giu'), new RegExp(`${B}es\\s+prohibido${E}`, 'gi'), new RegExp(`${B}se\\s+proh[íi]be${E}`, 'giu')],
};

const KINDS = Object.keys(MODAL_GROUPS);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 80);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractModals(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  // Process prohibited first to avoid "must not" being eaten by "must"
  const orderedKinds = ['prohibited', ...KINDS.filter((k) => k !== 'prohibited')];
  const claimedPositions = [];
  for (const kind of orderedKinds) {
    for (const re of MODAL_GROUPS[kind]) {
      re.lastIndex = 0;
      for (const m of head.matchAll(re)) {
        if (entries.length >= MAX_PER_FILE) break;
        // Skip if this position is already claimed by a prohibited match
        if (kind !== 'prohibited' && claimedPositions.some(([s, e]) => m.index >= s && m.index < e)) continue;
        const word = m[0].toLowerCase().trim().replace(/\s+/g, ' ');
        const ctx = clipContext(head, m.index, m[0].length);
        const key = `${kind}|${m.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ kind, word, context: ctx });
        totals[kind] += 1;
        if (kind === 'prohibited') claimedPositions.push([m.index, m.index + m[0].length]);
      }
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildModalsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractModals(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] **${e.word}**${file} — ${e.context}`;
}

function renderModalsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## MODAL VERBS / NORMATIVITY
Modal verb usage detected in the document(s), classified by normative strength:
- **strong**: must / shall / required to / deberá / tendrá
- **recommended**: should / ought to / debería
- **permitted**: may / can / podrá / puede
- **possibility**: could / might / podría / quizás
- **prohibited**: must not / shall not / cannot / no deberá / se prohíbe

Different from full obligation/conditional clause extraction by focusing on modal vocabulary. Routes "what's required?" / "what's allowed?" / "what's forbidden?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate modals across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...modals block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractModals,
  buildModalsForFiles,
  renderModalsBlock,
  _internal: {
    MODAL_GROUPS,
    KINDS,
  },
};
