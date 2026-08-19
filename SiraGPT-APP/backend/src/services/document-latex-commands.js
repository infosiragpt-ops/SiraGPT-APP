'use strict';

/**
 * document-latex-commands.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects LaTeX commands and environment usage in .tex / .Rnw documents:
 *
 *   - structural: \section{...}, \subsection{...}, \chapter{...}
 *   - bibliography: \cite{key}, \citep{}, \citet{}, \ref{...}
 *   - environments: \begin{equation} ... \end{equation}
 *   - inline math: $...$ or \(...\)
 *   - display math: $$...$$ or \[...\]
 *
 * Public API:
 *   extractLatexCommands(text)             → { entries, totals, total }
 *   buildLatexCommandsForFiles(files)      → { perFile, aggregate, totals }
 *   renderLatexCommandsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 100_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const STRUCTURAL_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{([^}\n]{1,150})\}/g;
const CITE_RE = /\\(cite[ptn]?|nocite|citep|citet|citeauthor|citeyear|fullcite)\*?\s*(?:\[[^\]]{0,80}\])?\s*\{([^}\n]{1,200})\}/g;
const REF_RE = /\\(ref|eqref|pageref|autoref|label|cref|Cref|nameref)\*?\s*\{([^}\n]{1,80})\}/g;
const ENV_RE = /\\begin\{([a-z][a-z0-9*]{1,30})\}/gi;
const INLINE_MATH_RE = /(?<!\\)\$([^$\n]{1,80})\$/g;
const DISPLAY_MATH_RE = /\\\[([\s\S]{2,300}?)\\\]/g;
const PACKAGE_RE = /\\usepackage(?:\[[^\]]{0,80}\])?\s*\{([a-z][a-z0-9,-]{2,80})\}/gi;

function extractLatexCommands(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { structural: 0, citation: 0, reference: 0, environment: 0, math: 0, package: 0 };

  function push(kind, cmd, value) {
    const key = `${kind}:${cmd}:${value || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, cmd, value });
    if (totals[kind] != null) totals[kind] += 1;
  }

  STRUCTURAL_RE.lastIndex = 0;
  let m;
  while ((m = STRUCTURAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('structural', m[1], m[2].slice(0, 60));
  }
  if (entries.length < MAX_PER_FILE) {
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('citation', m[1], m[2].slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('reference', m[1], m[2].slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('environment', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PACKAGE_RE.lastIndex = 0;
    while ((m = PACKAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('package', 'usepackage', m[1].slice(0, 60));
    }
  }
  // Math counts
  let inlineMath = 0;
  INLINE_MATH_RE.lastIndex = 0;
  while (INLINE_MATH_RE.exec(body) && inlineMath < 50) inlineMath += 1;
  let displayMath = 0;
  DISPLAY_MATH_RE.lastIndex = 0;
  while (DISPLAY_MATH_RE.exec(body) && displayMath < 50) displayMath += 1;
  if (inlineMath || displayMath) {
    push('math', `inline=${inlineMath},display=${displayMath}`, null);
  }

  return { entries, totals, total: entries.length };
}

function buildLatexCommandsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { structural: 0, citation: 0, reference: 0, environment: 0, math: 0, package: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractLatexCommands(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.cmd}:${e.value || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderLatexCommandsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## LATEX COMMANDS & ENVIRONMENTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const v = e.value ? ` ${e.value}` : '';
      lines.push(`- [${e.kind}] \\\\${e.cmd}${v}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractLatexCommands,
  buildLatexCommandsForFiles,
  renderLatexCommandsBlock,
};
