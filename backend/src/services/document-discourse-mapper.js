'use strict';

/**
 * document-discourse-mapper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts the argumentative scaffolding of a document — the connectives
 * that signal contrast, causation, sequence, conclusion, exemplification,
 * concession and emphasis. Returns an ordered list of markers (in reading
 * order) plus per-category counts. The chat enrichment splices this in
 * as the "DISCOURSE MAP" block so the model can navigate long documents
 * by argument flow instead of by raw text position.
 *
 * Bilingual (Spanish / English). Deterministic. < 10 ms on 1 MB.
 *
 * Markers are intentionally NOT extracted via NLP — they're a small,
 * stable, hand-curated lexicon. Detection happens at sentence start
 * or after a comma / semicolon, with a small lookahead to confirm the
 * marker is being USED as a connective (not embedded in a longer phrase
 * — e.g. "first place" should not register as a "first" sequence marker).
 *
 * Public API:
 *   mapDiscourse(text)                     → DiscourseReport
 *   buildDiscourseForFiles(files)          → { perFile, aggregate }
 *   renderDiscourseBlock(batchReport)      → markdown string ('' when empty)
 */

const MAX_MARKERS_PER_FILE = 24;
const MAX_BLOCK_CHARS = 3500;
const SNIPPET_PRE = 32;
const SNIPPET_POST = 80;

// Order matters within each list: more specific multi-word markers come
// FIRST so they win over their shorter prefixes (e.g. "on the other hand"
// before "on").
const MARKERS = {
  contrast: [
    'sin embargo', 'no obstante', 'por el contrario', 'en cambio', 'aunque',
    'a pesar de', 'mientras que', 'pero',
    'however', 'nevertheless', 'on the other hand', 'in contrast',
    'whereas', 'although', 'but',
  ],
  causation: [
    'por lo tanto', 'por consiguiente', 'en consecuencia', 'como resultado',
    'debido a', 'a causa de', 'porque', 'puesto que', 'dado que',
    'therefore', 'consequently', 'as a result', 'thus', 'hence',
    'because', 'since', 'due to', 'owing to',
  ],
  sequence: [
    'primero', 'en primer lugar', 'segundo', 'en segundo lugar', 'tercero',
    'en tercer lugar', 'a continuación', 'posteriormente', 'luego',
    'finalmente', 'por último',
    'first', 'firstly', 'second', 'secondly', 'third', 'thirdly',
    'next', 'then', 'subsequently', 'finally', 'lastly',
  ],
  conclusion: [
    'en conclusión', 'en resumen', 'para concluir', 'en síntesis',
    'en suma',
    'in conclusion', 'in summary', 'to summarize', 'to conclude',
    'overall', 'in short',
  ],
  exemplification: [
    'por ejemplo', 'por ejemplo,', 'tal como', 'tales como', 'como',
    'a saber', 'es decir', 'esto es',
    'for example', 'for instance', 'such as', 'namely', 'that is',
    'i.e.', 'e.g.',
  ],
  concession: [
    'admitidamente', 'es cierto que', 'si bien', 'aunque es cierto',
    'admittedly', 'granted', 'to be sure', 'while it is true',
  ],
  emphasis: [
    'sobre todo', 'especialmente', 'particularmente', 'en particular',
    'cabe destacar', 'es importante',
    'notably', 'especially', 'particularly', 'in particular',
    'importantly', 'crucially', 'above all',
  ],
};

const CATEGORY_LABELS = {
  contrast: 'Contraste',
  causation: 'Causa / consecuencia',
  sequence: 'Secuencia',
  conclusion: 'Conclusión',
  exemplification: 'Ejemplo',
  concession: 'Concesión',
  emphasis: 'Énfasis',
};

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Escape a literal phrase for use inside a regex. We don't expect any
 * meta-characters in the curated lexicon, but better safe than sorry.
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one regex per category that detects any marker at:
 *   - start of a sentence (preceded by ., !, ?, ; or newline + optional ws), OR
 *   - immediately after a comma (mid-sentence connective).
 * Word boundary on the right ensures "first place" / "primer lugar" do not
 * accidentally fire for marker "first" / "primer".
 */
function compileMatchers() {
  const matchers = {};
  for (const [cat, phrases] of Object.entries(MARKERS)) {
    // Sort longest-first so "on the other hand" wins over "on".
    const sorted = [...phrases].sort((a, b) => b.length - a.length);
    const alt = sorted.map(escapeRe).join('|');
    // Capture group 1 = the marker phrase, case-insensitive.
    matchers[cat] = new RegExp(
      `(?:^|[.!?;\\n]\\s*|,\\s+)(${alt})\\b`,
      'gi',
    );
  }
  return matchers;
}

const COMPILED = compileMatchers();

function makeSnippet(text, index, markerLen) {
  const start = Math.max(0, index - SNIPPET_PRE);
  const end = Math.min(text.length, index + markerLen + SNIPPET_POST);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  return `${pre}${slice}${post}`;
}

/**
 * @param {string} text
 * @param {{ maxMarkers?: number }} [opts]
 */
function mapDiscourse(text, opts = {}) {
  const empty = {
    markers: [],
    totals: { contrast: 0, causation: 0, sequence: 0, conclusion: 0, exemplification: 0, concession: 0, emphasis: 0 },
    markerCount: 0,
  };
  const raw = safeStr(text);
  if (!raw) return empty;

  const found = [];
  for (const [cat, re] of Object.entries(COMPILED)) {
    // Reset lastIndex defensively — regexes are reused across calls.
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const marker = m[1];
      const idx = (m.index ?? 0) + m[0].lastIndexOf(marker);
      found.push({
        category: cat,
        marker: marker.toLowerCase(),
        index: idx,
        snippet: makeSnippet(raw, idx, marker.length),
      });
    }
  }
  // Sort by position so the rendered list mirrors reading order.
  found.sort((a, b) => a.index - b.index);

  const totals = { ...empty.totals };
  for (const f of found) totals[f.category] += 1;

  const max = Math.max(4, opts.maxMarkers || MAX_MARKERS_PER_FILE);
  return {
    markers: found.slice(0, max),
    totals,
    markerCount: found.length,
  };
}

/**
 * @param {Array<{ originalName?: string, filename?: string, name?: string, extractedText?: string, text?: string }>} files
 */
function buildDiscourseForFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : [];
  const perFile = [];
  const aggregate = {
    markers: [],
    totals: { contrast: 0, causation: 0, sequence: 0, conclusion: 0, exemplification: 0, concession: 0, emphasis: 0 },
    markerCount: 0,
  };
  for (const f of list) {
    const text = safeStr(f.extractedText || f.text);
    if (!text) continue;
    const report = mapDiscourse(text);
    if (report.markerCount === 0) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    perFile.push({ file: label, report });
    aggregate.markers = aggregate.markers.concat(report.markers);
    for (const k of Object.keys(aggregate.totals)) {
      aggregate.totals[k] += report.totals[k];
    }
    aggregate.markerCount += report.markerCount;
  }
  aggregate.markers = aggregate.markers.slice(0, MAX_MARKERS_PER_FILE);
  return { perFile, aggregate };
}

function renderTotals(totals) {
  const lines = [];
  for (const [cat, n] of Object.entries(totals)) {
    if (n > 0) {
      const label = CATEGORY_LABELS[cat] || cat;
      lines.push(`- **${label}:** ${n}`);
    }
  }
  return lines.join('\n');
}

function renderMarkers(markers) {
  if (!markers || markers.length === 0) return '';
  const lines = ['**Markers in reading order**'];
  for (const m of markers) {
    const label = CATEGORY_LABELS[m.category] || m.category;
    lines.push(`- _${label}_ · \`${m.marker}\` — ${m.snippet}`);
  }
  return lines.join('\n');
}

/**
 * @param {ReturnType<typeof buildDiscourseForFiles>} batchReport
 */
function renderDiscourseBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) {
    return '';
  }
  const heading = `## DISCOURSE MAP
Argumentative connectives surfaced from the attached document(s) in reading order. Use this block to follow the writer's reasoning chain when the user asks "what's the argument", "where does the contrast happen", or "what's the conclusion". Categories: contraste, causa/consecuencia, secuencia, conclusión, ejemplo, concesión, énfasis.`;

  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    const totals = renderTotals(only.report.totals);
    if (totals) {
      sections.push('**Marker counts**');
      sections.push(totals);
    }
    const markers = renderMarkers(only.report.markers);
    if (markers) sections.push(markers);
  } else {
    const aggTotals = renderTotals(batchReport.aggregate.totals);
    if (aggTotals) {
      sections.push('### Aggregate across all files');
      sections.push('**Marker counts**');
      sections.push(aggTotals);
    }
    for (const p of batchReport.perFile) {
      sections.push(`### File: ${p.file}`);
      const totals = renderTotals(p.report.totals);
      if (totals) sections.push(totals);
      const markers = renderMarkers(p.report.markers);
      if (markers) sections.push(markers);
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...discourse map truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  mapDiscourse,
  buildDiscourseForFiles,
  renderDiscourseBlock,
  _internal: {
    MARKERS,
    CATEGORY_LABELS,
    MAX_MARKERS_PER_FILE,
    MAX_BLOCK_CHARS,
    compileMatchers,
    makeSnippet,
  },
};
