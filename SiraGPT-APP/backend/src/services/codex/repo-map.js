'use strict';

/**
 * codex/repo-map — Aider-style ranked repository map for the APPS agent.
 *
 * The idea (rewritten from scratch, no tree-sitter dependency): instead of a
 * flat file list, give the agent a COMPRESSED, RANKED view of the codebase —
 * per file, the symbols it exports and what imports it — so it can orient in
 * a grown project without reading every file. Aider ranks with PageRank over
 * a tree-sitter symbol graph; this clean-room version uses regex symbol
 * extraction (plenty for the TS/React/Prisma projects the APPS runner hosts)
 * and import-degree centrality, which preserves the property that matters:
 * the files everything else depends on float to the top.
 *
 * Bounded by design: caps on files read, bytes per file and total map chars,
 * so a huge workspace can never blow up the prompt or the turn latency.
 */

const SOURCE_RE = /\.(tsx?|jsx?|mjs|cjs)$/;
const SKIP_RE = /(^|\/)(node_modules|dist|build|\.next|\.git|coverage|\.sira)\//;
const MAX_FILES_READ = 40;
const MAX_BYTES_PER_FILE = 60_000;
const DEFAULT_MAP_CHARS = 3200;

/** Extract exported/declared symbols from a JS/TS source (regex, best-effort). */
function extractSymbols(source) {
  const text = String(source || '');
  const symbols = [];
  const push = (kind, name) => {
    if (name && !symbols.some((s) => s.name === name)) symbols.push({ kind, name });
  };
  let m;
  const reFn = /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(text))) push('fn', m[1]);
  const reConst = /export\s+const\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reConst.exec(text))) push('const', m[1]);
  const reClass = /export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reClass.exec(text))) push('class', m[1]);
  const reType = /export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reType.exec(text))) push('type', m[1]);
  // Non-exported top-level components/hooks still matter for orientation.
  const reComp = /^(?:async\s+)?function\s+([A-Z][\w$]*|use[A-Z][\w$]*)\s*\(/gm;
  while ((m = reComp.exec(text))) push('fn', m[1]);
  // `export default Name` referencing an earlier declaration.
  const reDefault = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m;
  if ((m = reDefault.exec(text))) push('default', m[1]);
  return symbols;
}

/** Relative import specifiers ("./x", "../y") of a JS/TS source. */
function extractRelativeImports(source) {
  const out = [];
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(String(source || '')))) out.push(m[1]);
  return out;
}

/** Resolve a relative import against the known file set (ts/tsx/js/jsx/index). */
function resolveImport(fromPath, spec, fileSet) {
  const baseDir = fromPath.split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of spec.split('/')) {
    if (seg === '.') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const stem = parts.join('/');
  const candidates = [
    stem,
    `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`,
    `${stem}/index.ts`, `${stem}/index.tsx`, `${stem}/index.js`,
  ];
  return candidates.find((c) => fileSet.has(c)) || null;
}

function symbolLine(path, symbols, importedByCount, extra = '') {
  const names = symbols.slice(0, 8).map((s) => s.name).join(', ');
  const more = symbols.length > 8 ? ` +${symbols.length - 8}` : '';
  const refs = importedByCount > 0 ? ` ←${importedByCount}` : '';
  return `${path}${refs}: ${names}${more}${extra}`.trimEnd();
}

/**
 * Build the ranked map. `readFile(path) → string|null` abstracts the runner.
 *
 * @param {string[]} paths all workspace file paths (git ls-files style)
 * @param {(path: string) => Promise<string|null>} readFile bounded reader
 * @param {{maxChars?: number}} [opts]
 * @returns {Promise<string>} bounded, ranked map ('' when nothing to map)
 */
async function buildRepoMapFromFiles(paths, readFile, opts = {}) {
  const maxChars = Number(opts.maxChars) || DEFAULT_MAP_CHARS;
  const all = (paths || []).filter((p) => p && !SKIP_RE.test(p));
  const sources = all.filter((p) => SOURCE_RE.test(p)).slice(0, MAX_FILES_READ);
  if (!sources.length) return '';
  const fileSet = new Set(all);

  const entries = [];
  const importedBy = new Map(); // path → count of files importing it
  for (const path of sources) {
    let content = null;
    try {
      content = await readFile(path);
    } catch { /* unreadable → skip */ }
    if (typeof content !== 'string') continue;
    const bounded = content.slice(0, MAX_BYTES_PER_FILE);
    const symbols = extractSymbols(bounded);
    const imports = extractRelativeImports(bounded)
      .map((spec) => resolveImport(path, spec, fileSet))
      .filter(Boolean);
    for (const target of new Set(imports)) {
      importedBy.set(target, (importedBy.get(target) || 0) + 1);
    }
    entries.push({ path, symbols, imports });
  }
  if (!entries.length) return '';

  // Rank: import-degree centrality + entrypoint bonus + symbol richness.
  const ENTRY_BONUS = /(^|\/)(main|index|App|app)\.(tsx?|jsx?)$/;
  const score = (e) =>
    (importedBy.get(e.path) || 0) * 3 +
    (ENTRY_BONUS.test(e.path) ? 4 : 0) +
    Math.min(e.symbols.length, 6);
  entries.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));

  const lines = ['Mapa del repositorio (rankeado; ←N = importado por N archivos):'];
  // Non-source anchors the agent always wants to know about.
  for (const anchor of ['package.json', 'prisma/schema.prisma']) {
    if (fileSet.has(anchor)) lines.push(anchor);
  }
  let used = lines.join('\n').length;
  let omitted = 0;
  for (const e of entries) {
    const line = symbolLine(e.path, e.symbols, importedBy.get(e.path) || 0);
    if (used + line.length + 1 > maxChars) { omitted += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const skippedSources = Math.max(0, all.filter((p) => SOURCE_RE.test(p)).length - MAX_FILES_READ);
  if (omitted + skippedSources > 0) {
    lines.push(`… +${omitted + skippedSources} archivos más (usa list_files/grep_search para el detalle)`);
  }
  return lines.join('\n');
}

/** Runner-backed convenience used by the `repo_map` tool. */
async function buildRepoMap({ runner, project, maxChars } = {}) {
  if (!runner || !project) return '';
  let paths = [];
  try {
    const out = await runner.exec(project, ['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { timeoutMs: 15_000 });
    paths = String(out?.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return '';
  }
  return buildRepoMapFromFiles(
    paths,
    async (path) => {
      const read = await runner.readFile(project, path);
      return typeof read?.content === 'string' ? read.content : null;
    },
    { maxChars },
  );
}

module.exports = {
  buildRepoMap,
  buildRepoMapFromFiles,
  extractSymbols,
  extractRelativeImports,
  resolveImport,
  MAX_FILES_READ,
  DEFAULT_MAP_CHARS,
};
