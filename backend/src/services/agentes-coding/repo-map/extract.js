'use strict';

/**
 * Header-only symbol / import extraction for the Aider-pattern repo-map.
 * Default is regex (no tree-sitter). Callers may inject parseTags().
 *
 * Pattern fusion of aider-ai/aider RepoMap (Apache-2.0): tags = definitions
 * + references. This file is a native rewrite — not a Python dump.
 */

const IDENT = '[A-Za-z_$][\\w$]*';

function uniquePush(list, kind, name) {
  const n = String(name || '').trim();
  if (!n || list.some((s) => s.name === n && s.kind === kind)) return;
  list.push({ kind, name: n });
}

/** Extract exported / declared symbols from a source header. */
function extractSymbolsRegex(source) {
  const text = String(source || '');
  const symbols = [];
  let m;

  const reFn = new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+(${IDENT})`, 'g');
  while ((m = reFn.exec(text))) uniquePush(symbols, 'fn', m[1]);

  const reConst = new RegExp(`export\\s+const\\s+(${IDENT})`, 'g');
  while ((m = reConst.exec(text))) uniquePush(symbols, 'const', m[1]);

  const reClass = new RegExp(`export\\s+(?:default\\s+)?class\\s+(${IDENT})`, 'g');
  while ((m = reClass.exec(text))) uniquePush(symbols, 'class', m[1]);

  const reType = new RegExp(`export\\s+(?:type|interface|enum)\\s+(${IDENT})`, 'g');
  while ((m = reType.exec(text))) uniquePush(symbols, 'type', m[1]);

  const reExportList = /export\s*\{([^}]+)\}/g;
  while ((m = reExportList.exec(text))) {
    for (const part of String(m[1]).split(',')) {
      const cleaned = part.replace(/\bas\s+\S+/g, '').trim();
      const name = cleaned.split(/\s+/)[0];
      uniquePush(symbols, 'const', name);
    }
  }

  const reComp = new RegExp(`^(?:async\\s+)?function\\s+([A-Z][\\w$]*|use[A-Z][\\w$]*)\\s*\\(`, 'gm');
  while ((m = reComp.exec(text))) uniquePush(symbols, 'fn', m[1]);

  const reDefault = new RegExp(`export\\s+default\\s+(${IDENT})\\s*;?\\s*$`, 'm');
  if ((m = reDefault.exec(text))) uniquePush(symbols, 'default', m[1]);

  const rePyDef = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm;
  while ((m = rePyDef.exec(text))) uniquePush(symbols, 'fn', m[1]);
  const rePyClass = /^class\s+([A-Za-z_][\w]*)\s*[:(]/gm;
  while ((m = rePyClass.exec(text))) uniquePush(symbols, 'class', m[1]);

  const reGoFunc = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/gm;
  while ((m = reGoFunc.exec(text))) uniquePush(symbols, 'fn', m[1]);
  const reGoType = /^type\s+([A-Za-z_][\w]*)\s+/gm;
  while ((m = reGoType.exec(text))) uniquePush(symbols, 'type', m[1]);

  return symbols;
}

/**
 * @param {string} source
 * @param {{ parseTags?: (src: string) => Array<{kind?: string, name?: string}> }} [opts]
 */
function extractSymbols(source, opts = {}) {
  if (typeof opts.parseTags === 'function') {
    const raw = opts.parseTags(source) || [];
    const out = [];
    for (const tag of raw) {
      uniquePush(out, tag.kind || 'fn', tag.name);
    }
    return out;
  }
  return extractSymbolsRegex(source);
}

/** Relative import specifiers ("./x", "../y") of a JS/TS/Python source. */
function extractRelativeImports(source) {
  const text = String(source || '');
  const out = [];
  const reJs = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = reJs.exec(text))) out.push(m[1]);
  const rePy = /(?:from|import)\s+(\.{1,2}(?:\.[\w]+)+)/g;
  while ((m = rePy.exec(text))) {
    const spec = String(m[1]).replace(/\./g, '/').replace(/^\/*/, './');
    if (spec.includes('/')) out.push(spec);
  }
  return out;
}

/** Resolve a relative import against the known file set. */
function resolveImport(fromPath, spec, fileSet) {
  const baseDir = String(fromPath).split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of String(spec).split('/')) {
    if (seg === '.' || seg === '') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const stem = parts.join('/');
  const candidates = [
    stem,
    `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`,
    `${stem}.py`, `${stem}.go`,
    `${stem}/index.ts`, `${stem}/index.tsx`, `${stem}/index.js`,
    `${stem}/__init__.py`,
  ];
  return candidates.find((c) => fileSet.has(c)) || null;
}

module.exports = {
  extractSymbols,
  extractSymbolsRegex,
  extractRelativeImports,
  resolveImport,
};
