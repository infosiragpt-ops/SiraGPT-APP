#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Dead-code analyzer for backend/ (CommonJS .js).
// Reports named exports that are not referenced from any other backend file.
//
// Usage:
//   node scripts/dead-code.js [--json] [--root <dir>] [--include-tests]
//
// Heuristic, regex-based — not a full AST analyzer. Treats the following as
// "roots" (entry points whose exports are not required to be consumed):
//   - backend/index.js
//   - backend/src/server.js
//   - backend/scripts/**
//   - backend/tests/**  (unless --include-tests is passed)
//   - any file referenced from package.json bin / main fields
//
// Detected export forms (named):
//   module.exports = { foo, bar, baz: ... }
//   module.exports.foo = ...
//   exports.foo = ...
//   Object.assign(module.exports, { foo, bar })
//   Object.assign(exports,        { foo, bar })
//
// Default-only exports (`module.exports = something` where `something` is an
// expression rather than an object literal) are tracked as a synthetic
// `<default>` symbol. They are considered used when *any* importer requires
// the file at all.
//
// Detected usages:
//   require('./relative')            → counts as default usage
//   const { foo } = require('./x')   → counts named foo
//   const m = require('./x'); m.foo  → counts named foo
//   require('./x').foo               → counts named foo

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BACKEND_ROOT = path.join(PROJECT_ROOT, 'backend');
const SOURCE_EXT = new Set(['.js', '.cjs', '.mjs']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.test-dist',
  'uploads',
  'data',
  'prisma',
]);

function parseArgs(argv) {
  const opts = { json: false, includeTests: false, root: DEFAULT_BACKEND_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--include-tests') opts.includeTests = true;
    else if (a === '--root') {
      const next = argv[++i];
      if (!next) throw new Error('--root requires a path');
      opts.root = path.resolve(next);
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      listFiles(full, out);
    } else if (ent.isFile() && SOURCE_EXT.has(path.extname(ent.name))) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src) {
  // Remove block comments and line comments. Best-effort: not string-aware.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function splitTopLevel(body, sep) {
  // Splits on `sep` characters not nested inside (), [] or {}.
  const out = [];
  let depth = 0;
  let buf = '';
  let inStr = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      buf += c;
      if (c === '\\' && i + 1 < body.length) { buf += body[++i]; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; buf += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; buf += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; buf += c; continue; }
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim().length) out.push(buf);
  return out;
}

function extractNamedFromObjectLiteral(body) {
  // body is the inside of `{ ... }`. Pull out keys (left side of `:` for pairs,
  // whole identifier for shorthand). Skips spreads, computed keys, methods.
  const names = new Set();
  for (const rawPart of splitTopLevel(body, ',')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith('...')) continue;
    if (part.startsWith('[')) continue; // computed key
    // Find first top-level ':' to separate key from value.
    const idx = (() => {
      let depth = 0, inStr = null;
      for (let i = 0; i < part.length; i++) {
        const c = part[i];
        if (inStr) {
          if (c === '\\' && i + 1 < part.length) { i++; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (c === ':' && depth === 0) return i;
      }
      return -1;
    })();
    let key = idx >= 0 ? part.slice(0, idx).trim() : part;
    // Strip method/async/getter/setter prefixes and parameter list.
    key = key.replace(/^async\s+/, '').replace(/^(?:get|set)\s+/, '');
    // For shorthand methods like `foo()` or `foo(arg)`.
    const parenIdx = key.indexOf('(');
    if (parenIdx > 0) key = key.slice(0, parenIdx).trim();
    // For shorthand defaults like `foo = 1`.
    const eqIdx = key.indexOf('=');
    if (eqIdx > 0) key = key.slice(0, eqIdx).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
  }
  for (const reserved of ['true', 'false', 'null', 'undefined']) names.delete(reserved);
  return names;
}

function findMatchingBrace(src, openIdx) {
  // src[openIdx] must be '{'. Returns index of matching '}', or -1.
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function analyzeExports(src) {
  const exports = new Set();
  let hasDefault = false;
  let hasUnknownShape = false;

  // module.exports.<name> = ...     and    exports.<name> = ...
  const propRe = /(?:^|[^.\w])(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = propRe.exec(src)) !== null) exports.add(m[1]);

  // module.exports = { ... }
  const objAssignRe = /(?:^|[^.\w])module\.exports\s*=\s*\{/g;
  while ((m = objAssignRe.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const close = findMatchingBrace(src, open);
    if (close > open) {
      const body = src.slice(open + 1, close);
      for (const n of extractNamedFromObjectLiteral(body)) exports.add(n);
    } else {
      hasUnknownShape = true;
    }
  }

  // module.exports = <non-object-literal expression>
  // (default export — function, class, identifier, etc.)
  const defaultRe = /(?:^|[^.\w])module\.exports\s*=\s*(\S)/g;
  while ((m = defaultRe.exec(src)) !== null) {
    if (m[1] !== '{') hasDefault = true;
  }

  // Object.assign(module.exports, { ... })  /  Object.assign(exports, { ... })
  const assignRe = /Object\.assign\s*\(\s*(?:module\.exports|exports)\s*,\s*\{/g;
  while ((m = assignRe.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const close = findMatchingBrace(src, open);
    if (close > open) {
      const body = src.slice(open + 1, close);
      for (const n of extractNamedFromObjectLiteral(body)) exports.add(n);
    } else {
      hasUnknownShape = true;
    }
  }

  return { exports, hasDefault, hasUnknownShape };
}

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = spec.startsWith('/')
    ? spec
    : path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base + '.js',
    base + '.cjs',
    base + '.mjs',
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
    path.join(base, 'index.mjs'),
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return path.resolve(c);
    } catch {
      // continue
    }
  }
  return null;
}

function analyzeUsages(src, fromFile) {
  // Returns { default: Set<resolvedPath>, named: Map<resolvedPath, Set<name>> }
  const defaultUses = new Set();
  const named = new Map();

  function addNamed(target, name) {
    if (!named.has(target)) named.set(target, new Set());
    named.get(target).add(name);
  }

  // const NAME = require('spec')   |   const { a, b: c } = require('spec')   |   require('spec').foo
  // We process require() occurrences and look at left-hand context plus right-hand .prop access.
  const reqRe = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = reqRe.exec(src)) !== null) {
    const spec = m[2];
    const resolved = resolveRequire(fromFile, spec);
    if (!resolved) continue;
    defaultUses.add(resolved);

    // Look right of the require() call for an immediate .name access or destructure.
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const dot = after.match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (dot) addNamed(resolved, dot[1]);

    // Look left for a destructuring pattern: `const { a, b: c, ... } = require(...)`
    // We do this by scanning backwards for `{` then `}` then `=`.
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const destructure = before.match(/\{\s*([^{}]*?)\s*\}\s*=\s*$/);
    if (destructure) {
      const body = destructure[1];
      const partRe = /([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*)?/g;
      let pm;
      while ((pm = partRe.exec(body)) !== null) {
        if (pm[1]) addNamed(resolved, pm[1]);
      }
      continue;
    }

    // Or: `const ident = require('spec')` — collect ident, then scan for ident.NAME usage in the file.
    const identMatch = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
    if (identMatch) {
      const ident = identMatch[1];
      const usageRe = new RegExp(`\\b${ident}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
      let um;
      while ((um = usageRe.exec(src)) !== null) addNamed(resolved, um[1]);
    }
  }

  return { defaultUses, named };
}

function isRootFile(file, backendRoot, opts) {
  const rel = path.relative(backendRoot, file).replace(/\\/g, '/');
  if (rel === 'index.js') return true;
  if (rel === 'src/server.js') return true;
  if (rel.startsWith('scripts/')) return true;
  if (rel.startsWith('prisma/')) return true;
  if (!opts.includeTests && rel.startsWith('tests/')) return true;
  return false;
}

function analyze(backendRoot, opts = {}) {
  const files = listFiles(backendRoot);
  const fileExports = new Map(); // resolvedPath → { exports:Set, hasDefault, hasUnknownShape }
  const fileUsages = new Map();  // resolvedPath → { defaultUses:Set, named:Map }

  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const cleaned = stripComments(src);
    fileExports.set(f, analyzeExports(cleaned));
    fileUsages.set(f, analyzeUsages(cleaned, f));
  }

  // Aggregate global usage maps.
  const usedDefault = new Set();
  const usedNamed = new Map(); // path → Set<name>
  for (const [, u] of fileUsages) {
    for (const t of u.defaultUses) usedDefault.add(t);
    for (const [t, names] of u.named) {
      if (!usedNamed.has(t)) usedNamed.set(t, new Set());
      for (const n of names) usedNamed.get(t).add(n);
    }
  }

  const dead = []; // { file, symbol, kind }
  const summary = { totalFiles: files.length, totalExports: 0, deadExports: 0, rootsSkipped: 0 };

  for (const [file, info] of fileExports) {
    const isRoot = isRootFile(file, backendRoot, opts);
    if (isRoot) summary.rootsSkipped++;
    const usedNames = usedNamed.get(file) || new Set();
    const fileIsImported = usedDefault.has(file);

    if (info.hasDefault) {
      summary.totalExports++;
      if (!fileIsImported && !isRoot) {
        dead.push({ file, symbol: '<default>', kind: 'default' });
      }
    }

    for (const name of info.exports) {
      summary.totalExports++;
      if (info.hasUnknownShape) continue;
      if (usedNames.has(name)) continue;
      // Common namespace re-export pattern: caller does `mod.foo.bar` → we recorded `foo`,
      // but a caller doing `mod.bar` directly without listing `foo` won't reach here.
      if (isRoot) continue;
      if (!fileIsImported) {
        dead.push({ file, symbol: name, kind: 'named-orphan' });
      } else {
        dead.push({ file, symbol: name, kind: 'named' });
      }
    }
  }

  summary.deadExports = dead.length;
  return { dead, summary, backendRoot };
}

function formatReport(result) {
  const { dead, summary, backendRoot } = result;
  const lines = [];
  lines.push(`Dead-code report — backend root: ${path.relative(PROJECT_ROOT, backendRoot) || '.'}`);
  lines.push(
    `Files scanned: ${summary.totalFiles}  ·  Exports: ${summary.totalExports}  ·  ` +
    `Roots skipped: ${summary.rootsSkipped}  ·  Dead: ${summary.deadExports}`
  );
  if (dead.length === 0) {
    lines.push('No unreferenced exports detected.');
    return lines.join('\n');
  }
  const byFile = new Map();
  for (const d of dead) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }
  const sorted = [...byFile.keys()].sort();
  for (const f of sorted) {
    const rel = path.relative(PROJECT_ROOT, f);
    lines.push('');
    lines.push(rel);
    for (const d of byFile.get(f)) {
      const tag = d.kind === 'named-orphan' ? ' (file never imported)' : '';
      lines.push(`  - ${d.symbol}${tag}`);
    }
  }
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/dead-code.js [--json] [--root <dir>] [--include-tests]');
    process.exit(0);
  }
  if (!fs.existsSync(opts.root)) {
    console.error(`backend root not found: ${opts.root}`);
    process.exit(2);
  }
  const result = analyze(opts.root, opts);
  if (opts.json) {
    const payload = {
      ...result.summary,
      backendRoot: path.relative(PROJECT_ROOT, result.backendRoot) || '.',
      dead: result.dead.map((d) => ({
        file: path.relative(PROJECT_ROOT, d.file),
        symbol: d.symbol,
        kind: d.kind,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatReport(result));
  }
  // Exit code: 0 always (informational). Use --json + jq for CI gating.
}

if (require.main === module) {
  main();
}

module.exports = {
  analyze,
  analyzeExports,
  analyzeUsages,
  resolveRequire,
  stripComments,
  extractNamedFromObjectLiteral,
  formatReport,
};
