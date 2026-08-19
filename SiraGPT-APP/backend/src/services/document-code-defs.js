'use strict';

/**
 * document-code-defs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects code function/class/type definitions across major languages:
 *
 *   - JS/TS: function foo(), const foo = (), class Foo, type Foo = ...,
 *     interface Foo
 *   - Python: def foo(), class Foo
 *   - Go: func Foo(), type Foo struct, type Foo interface
 *   - Rust: fn foo(), struct Foo, enum Foo, trait Foo, impl Foo
 *   - Java/Kotlin: public class Foo, fun foo()
 *   - C/C++: class Foo, struct Foo, void foo()
 *
 * Different from document-code-blocks (raw fenced code) by extracting
 * structural identifiers. Routes "what functions / classes?" to a
 * citeable list.
 *
 * Public API:
 *   extractCodeDefs(text)         → CodeDefReport
 *   buildCodeDefsForFiles(files)  → { perFile, aggregate, totals }
 *   renderCodeDefsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 12;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5000;
const MAX_NAME_LEN = 80;

const PATTERNS = [
  // JS/TS function declarations
  { kind: 'function', re: /\bfunction\s+([A-Za-z_$][\w$]{0,60})\s*\(/g, lang: 'js' },
  // JS/TS const/let arrow functions
  { kind: 'function', re: /(?:const|let|var)\s+([A-Za-z_$][\w$]{0,60})\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, lang: 'js' },
  // Python def
  { kind: 'function', re: /\bdef\s+([A-Za-z_][\w]{0,60})\s*\(/g, lang: 'py' },
  // Python class
  { kind: 'class', re: /\bclass\s+([A-Z][\w]{0,60})\s*[(:]/g, lang: 'py' },
  // JS/Java/Kotlin class
  { kind: 'class', re: /\bclass\s+([A-Z][\w$]{0,60})\s*[{<\s]/g, lang: 'js' },
  // TS interface / type
  { kind: 'type', re: /\b(?:interface|type)\s+([A-Z][\w$]{0,60})\b/g, lang: 'ts' },
  // Go func
  { kind: 'function', re: /\bfunc\s+(?:\([^)]+\)\s+)?([A-Z][a-zA-Z0-9]{0,60})\s*\(/g, lang: 'go' },
  // Go type / struct
  { kind: 'type', re: /\btype\s+([A-Z][a-zA-Z0-9]{0,60})\s+(?:struct|interface)\b/g, lang: 'go' },
  // Rust fn
  { kind: 'function', re: /\bfn\s+([a-z_][a-zA-Z0-9_]{0,60})\s*[(<]/g, lang: 'rs' },
  // Rust struct / enum / trait / impl
  { kind: 'type', re: /\b(?:struct|enum|trait|impl)\s+([A-Z][a-zA-Z0-9_]{0,60})\b/g, lang: 'rs' },
];

const KINDS = ['function', 'class', 'type'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipName(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_NAME_LEN) return t;
  return `${t.slice(0, MAX_NAME_LEN - 1)}…`;
}

function emptyByKind() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

const RESERVED_NAMES = new Set(['function', 'class', 'const', 'let', 'var', 'def', 'func', 'fn', 'type', 'interface', 'struct', 'enum', 'trait', 'impl', 'public', 'private', 'protected', 'static', 'final', 'async', 'await', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'this', 'super', 'self', 'true', 'false', 'null', 'None', 'True', 'False', 'undefined']);

function extractCodeDefs(input) {
  const text = safeText(input);
  if (!text) return { defs: [], total: 0, byKind: emptyByKind(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const defs = [];
  const seen = new Set();
  const byKind = emptyByKind();

  for (const { kind, re, lang } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (defs.length >= MAX_PER_FILE) break;
      if (byKind[kind] >= MAX_PER_KIND) break;
      const name = clipName(m[1]);
      if (!name || RESERVED_NAMES.has(name)) continue;
      const key = `${kind}|${name}|${lang}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push({ kind, name, lang });
      byKind[kind] += 1;
    }
  }

  return { defs, total: defs.length, byKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCodeDefsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byKind = emptyByKind();
  for (const f of list) {
    const r = extractCodeDefs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, defs: r.defs, byKind: r.byKind });
    aggregate = aggregate.concat(r.defs.map((d) => ({ ...d, file: name })));
    for (const k of KINDS) byKind[k] += r.byKind[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byKind };
}

function renderDef(d, opts = {}) {
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  return `- [${d.kind}/${d.lang}] \`${d.name}\`${file}`;
}

function renderCodeDefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byKind = report.byKind || emptyByKind();
  const breakdown = KINDS
    .filter((k) => byKind[k] > 0)
    .map((k) => `${k}=${byKind[k]}`)
    .join('  ');
  const heading = `## CODE DEFINITIONS
Function / class / type definitions detected in code-bearing sections of the document(s) across JS, TS, Python, Go, Rust (with extensible patterns). Different from raw code-block extraction by surfacing structural identifiers. Routes "what functions are defined?" / "what classes?" to a citeable inventory.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.defs) sections.push(renderDef(d));
  } else {
    sections.push('### Aggregate code defs across all files');
    for (const d of report.aggregate) sections.push(renderDef(d, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.defs) sections.push(renderDef(d));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...code defs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCodeDefs,
  buildCodeDefsForFiles,
  renderCodeDefsBlock,
  _internal: {
    PATTERNS,
    KINDS,
    RESERVED_NAMES,
  },
};
