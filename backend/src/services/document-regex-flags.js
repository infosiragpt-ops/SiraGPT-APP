'use strict';

/**
 * document-regex-flags.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects regex literal references and flag analysis:
 *
 *   - JS regex literals:  /pattern/flags        (g, i, m, s, u, y, d)
 *   - new RegExp("...", "flags") constructor calls
 *   - feature analysis:
 *       lookahead/lookbehind  (?= ... ) / (?! ... ) / (?<= ... ) / (?<! ... )
 *       named groups          (?<name> ... )
 *       backreferences        \1 / \k<name>
 *       unicode property      \p{...} / \P{...}
 *       anchors               ^ $ \b \B
 *
 * Public API:
 *   extractRegexFlags(text)             → { entries, totals, total }
 *   buildRegexFlagsForFiles(files)      → { perFile, aggregate, totals }
 *   renderRegexFlagsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

// JS regex literal — keep pattern conservative to avoid false positives on division operators
const LITERAL_RE = /(?:^|[=([,!&|?:;{}\s])\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+)\/([gimsuyd]{0,7})(?![a-zA-Z0-9_])/g;
// new RegExp("...", "flags") — both quote styles
const CONSTRUCTOR_RE = /\bnew\s+RegExp\s*\(\s*(?:["'`]([^"'`\n]{1,200})["'`]|\/([^\/\n]{1,200})\/[gimsuyd]{0,7})(?:\s*,\s*["']([gimsuyd]{0,7})["'])?/g;

const FEATURES = [
  { name: 'lookahead', re: /\(\?=/ },
  { name: 'negLookahead', re: /\(\?!/ },
  { name: 'lookbehind', re: /\(\?<=/ },
  { name: 'negLookbehind', re: /\(\?<!/ },
  { name: 'namedGroup', re: /\(\?<[a-zA-Z_]/ },
  { name: 'backref', re: /\\\d|\\k</ },
  { name: 'unicodeProp', re: /\\[pP]\{/ },
  { name: 'wordBoundary', re: /\\[bB]/ },
];

function analyzeFlags(flags) {
  const out = [];
  if (flags.includes('g')) out.push('global');
  if (flags.includes('i')) out.push('insensitive');
  if (flags.includes('m')) out.push('multiline');
  if (flags.includes('s')) out.push('dotall');
  if (flags.includes('u')) out.push('unicode');
  if (flags.includes('y')) out.push('sticky');
  if (flags.includes('d')) out.push('hasIndices');
  return out;
}

function previewPattern(pat) {
  if (!pat) return '';
  if (pat.length <= 36) return pat;
  return `${pat.slice(0, 28)}…`;
}

function extractRegexFlags(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {
    literal: 0, constructor: 0,
    global: 0, insensitive: 0, multiline: 0, dotall: 0, unicode: 0, sticky: 0, hasIndices: 0,
    lookahead: 0, negLookahead: 0, lookbehind: 0, negLookbehind: 0,
    namedGroup: 0, backref: 0, unicodeProp: 0, wordBoundary: 0,
  };

  function push(kind, pattern, flags) {
    const key = `${kind}:${pattern}:${flags || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, pattern: previewPattern(pattern), flags });
    if (totals[kind] != null) totals[kind] += 1;
    for (const flagName of analyzeFlags(flags || '')) {
      totals[flagName] += 1;
    }
    for (const { name, re } of FEATURES) {
      if (re.test(pattern)) {
        if (entries.length < MAX_PER_FILE && totals[name] === 0) {
          // Add a synthetic feature marker entry once per feature per file
          entries.push({ kind: 'feature', pattern: name, flags: '' });
        }
        totals[name] += 1;
      }
    }
  }

  LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = LITERAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('literal', m[1], m[2]);
  }
  if (entries.length < MAX_PER_FILE) {
    CONSTRUCTOR_RE.lastIndex = 0;
    while ((m = CONSTRUCTOR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const pat = m[1] || m[2] || '';
      push('constructor', pat, m[3] || '');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildRegexFlagsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    literal: 0, constructor: 0,
    global: 0, insensitive: 0, multiline: 0, dotall: 0, unicode: 0, sticky: 0, hasIndices: 0,
    lookahead: 0, negLookahead: 0, lookbehind: 0, negLookbehind: 0,
    namedGroup: 0, backref: 0, unicodeProp: 0, wordBoundary: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractRegexFlags(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.pattern}:${e.flags || ''}`;
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

function renderRegexFlagsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## REGEX LITERALS & FLAGS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const fl = e.flags ? ` [${e.flags}]` : '';
      lines.push(`- [${e.kind}] \`${e.pattern}\`${fl}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractRegexFlags,
  buildRegexFlagsForFiles,
  renderRegexFlagsBlock,
  _internal: { analyzeFlags, previewPattern, FEATURES },
};
