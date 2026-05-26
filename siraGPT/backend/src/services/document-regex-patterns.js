'use strict';

/**
 * document-regex-patterns.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects regular-expression literals referenced in tech docs / specs:
 *
 *   - JS-style: /pattern/flags  (with valid flag chars only)
 *   - Backtick-wrapped regex strings: `^foo.*bar$`
 *   - Python re.compile(r"pattern")
 *   - Java/Perl-style /pattern/
 *
 * Filters out URLs and division operators by requiring at least one
 * regex-y construct (anchors, character classes, quantifiers, escapes).
 *
 * Public API:
 *   extractRegexPatterns(text)         → RegexReport
 *   buildRegexPatternsForFiles(files)  → { perFile, aggregate, totals }
 *   renderRegexPatternsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_PATTERN_LEN = 120;

const SLASH_REGEX_RE = /(?:^|[\s`'"<>(=,;:])(\/(?:[^/\\\n]|\\.){2,150}\/)([gimsuy]{0,6})(?=[\s`'"<>):,;.!?]|$)/g;
const RE_COMPILE_RE = /\bre\.compile\s*\(\s*r?["']([^"'\n]{2,150})["']/gi;
const RAW_BACKTICK_RE = /`([\^$].{1,148}[+*?$])`/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipPattern(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_PATTERN_LEN) return t;
  return `${t.slice(0, MAX_PATTERN_LEN - 1)}…`;
}

function looksLikeRegex(p) {
  if (!p || p.length < 2) return false;
  // Require at least one regex construct
  return /[\^$.|*+?\[\]()\\{}]|\\[wdbsBDSnt]/.test(p);
}

function emptyTotals() {
  return { slash: 0, recompile: 0, backtick: 0 };
}

function extractRegexPatterns(input) {
  const text = safeText(input);
  if (!text) return { patterns: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const patterns = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, pattern, flags) {
    if (patterns.length >= MAX_PER_FILE) return;
    const p = clipPattern(pattern);
    if (!looksLikeRegex(p)) return;
    const key = `${kind}|${p}|${flags || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    patterns.push({ kind, pattern: p, flags: flags || '' });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(SLASH_REGEX_RE)) {
    const raw = m[1];
    const flags = m[2];
    // Strip leading/trailing slashes
    const inner = raw.slice(1, -1);
    add('slash', inner, flags);
  }
  for (const m of head.matchAll(RE_COMPILE_RE)) {
    add('recompile', m[1]);
  }
  for (const m of head.matchAll(RAW_BACKTICK_RE)) {
    add('backtick', m[1]);
  }

  return { patterns, total: patterns.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildRegexPatternsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractRegexPatterns(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, patterns: r.patterns, totals: r.totals });
    aggregate = aggregate.concat(r.patterns.map((p) => ({ ...p, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderPattern(p, opts = {}) {
  const file = opts.includeFile && p.file ? ` _(${p.file})_` : '';
  const flags = p.flags ? `/${p.flags}` : '';
  return `- [${p.kind}] \`/${p.pattern}/${flags ? p.flags : ''}\`${file}`;
}

function renderRegexPatternsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## REGEX PATTERNS
Regular expression literals detected in the document(s): JS-style /pattern/flags, Python re.compile(r"pattern"), and backtick-wrapped raw patterns. Filtered to require regex constructs (anchors, char classes, quantifiers, escapes) to avoid false positives with file paths or division. Routes "what regex?" / "show me the patterns" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const p of only.patterns) sections.push(renderPattern(p));
  } else {
    sections.push('### Aggregate regex across all files');
    for (const p of report.aggregate) sections.push(renderPattern(p, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const r of p.patterns) sections.push(renderPattern(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...regex block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractRegexPatterns,
  buildRegexPatternsForFiles,
  renderRegexPatternsBlock,
  _internal: {
    SLASH_REGEX_RE,
    RE_COMPILE_RE,
    RAW_BACKTICK_RE,
    looksLikeRegex,
  },
};
