'use strict';

/**
 * agentes-coding/repo-map — Aider-pattern ranked file/symbol hints.
 *
 * Given a coding-sandbox session (or a workspace root / injected file
 * list), produce `{ name, path, kind, score }` hints without loading
 * whole files. Headers only (`HEADER_BYTES`). Tree-sitter is optional
 * via `parseTags`; the default extractor is regex.
 *
 * Apache-2.0 pattern from aider-ai/aider RepoMap. Native CommonJS —
 * not a Python monorepo dump. Flag: AGENTES_CODING_V2 (default OFF).
 *
 * See docs/agentes-coding-repomap.md
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const { extractSymbols, extractRelativeImports, resolveImport } = require('./extract');
const { pageRank, normalizeScores, combineScores, pathHeuristic } = require('./rank');

const SOURCE_RE = /\.(tsx?|jsx?|mjs|cjs|py|go)$/;
const SKIP_RE = /(^|\/)(node_modules|dist|build|\.next|\.git|coverage|\.sira|vendor|__pycache__)\//;
const HEADER_BYTES = 8_192;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 80;
const DEFAULT_MAX_FILES = 48;
const MAX_FILES_CAP = 80;
const MAX_QUERY_CHARS = 200;
const ANCHORS = new Set(['package.json', 'prisma/schema.prisma', 'go.mod', 'pyproject.toml']);

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseOpts(opts = {}) {
  const query = String(opts.query || '').trim();
  if (query.length > MAX_QUERY_CHARS) {
    fail('E_PARAMS', 'La consulta del mapa es demasiado larga.');
  }
  return {
    query,
    limit: clampInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    maxFiles: clampInt(opts.maxFiles, DEFAULT_MAX_FILES, 1, MAX_FILES_CAP),
    parseTags: typeof opts.parseTags === 'function' ? opts.parseTags : null,
    headerBytes: clampInt(opts.headerBytes, HEADER_BYTES, 256, HEADER_BYTES),
  };
}

function fileName(filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function skipPath(p) {
  return !p || SKIP_RE.test(p);
}

/**
 * Slice a reader result to the header budget. Never keeps the tail.
 * @returns {Promise<{ text: string|null, bytesRead: number }>}
 */
async function readHeaderOnly(readHeader, filePath, headerBytes) {
  let raw;
  try {
    raw = await readHeader(filePath, headerBytes);
  } catch {
    return { text: null, bytesRead: 0 };
  }
  if (raw == null) return { text: null, bytesRead: 0 };
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const sliced = text.slice(0, headerBytes);
  return { text: sliced, bytesRead: sliced.length };
}

/**
 * Build ranked hints from a path list + header reader.
 *
 * @param {string[]} paths
 * @param {(path: string, maxBytes: number) => Promise<string|Buffer|null>} readHeader
 * @param {object} [opts]
 */
async function buildRepoMap(paths, readHeader, opts = {}) {
  const cfg = parseOpts(opts);
  const all = (paths || []).map((p) => String(p || '').replace(/^\/+/, '')).filter((p) => p && !skipPath(p));
  const fileSet = new Set(all);
  const sources = all.filter((p) => SOURCE_RE.test(p)).slice(0, cfg.maxFiles);
  const omitted = Math.max(0, all.filter((p) => SOURCE_RE.test(p)).length - sources.length);

  const entries = [];
  const importedBy = new Map();
  const outgoing = new Map();
  let headerReads = 0;

  for (const filePath of sources) {
    const { text } = await readHeaderOnly(readHeader, filePath, cfg.headerBytes);
    headerReads += 1;
    if (typeof text !== 'string') {
      entries.push({ path: filePath, symbols: [], imports: [] });
      outgoing.set(filePath, []);
      continue;
    }
    const symbols = extractSymbols(text, { parseTags: cfg.parseTags || undefined });
    const imports = extractRelativeImports(text)
      .map((spec) => resolveImport(filePath, spec, fileSet))
      .filter(Boolean);
    const uniqueImports = [...new Set(imports)];
    for (const target of uniqueImports) {
      importedBy.set(target, (importedBy.get(target) || 0) + 1);
    }
    entries.push({ path: filePath, symbols, imports: uniqueImports });
    outgoing.set(filePath, uniqueImports);
  }

  const nodes = entries.map((e) => e.path);
  const ranks = pageRank(nodes, outgoing);

  const scored = entries.map((e) => ({
    path: e.path,
    symbols: e.symbols,
    raw: combineScores({
      path: e.path,
      symbols: e.symbols,
      importedBy,
      ranks,
      query: cfg.query,
    }),
  }));

  for (const anchor of ANCHORS) {
    if (fileSet.has(anchor) && !scored.some((e) => e.path === anchor)) {
      scored.push({
        path: anchor,
        symbols: [],
        raw: pathHeuristic(anchor, cfg.query) + 3,
      });
    }
  }

  // Non-source leftovers still get a cheap path score (no file body).
  if (scored.length < cfg.limit) {
    for (const p of all) {
      if (SOURCE_RE.test(p) || scored.some((e) => e.path === p)) continue;
      scored.push({ path: p, symbols: [], raw: pathHeuristic(p, cfg.query) });
      if (scored.length >= cfg.limit + 8) break;
    }
  }

  scored.sort((a, b) => b.raw - a.raw || a.path.localeCompare(b.path));
  const normalized = normalizeScores(scored);

  const hints = [];
  for (const file of normalized) {
    if (hints.length >= cfg.limit) break;
    hints.push({
      name: fileName(file.path),
      path: file.path,
      kind: 'file',
      score: file.score,
    });
    const symbolBudget = Math.min(3, cfg.limit - hints.length);
    const rankedSymbols = file.symbols.slice(0, symbolBudget);
    for (let i = 0; i < rankedSymbols.length; i += 1) {
      const sym = rankedSymbols[i];
      const qBoost = cfg.query && String(sym.name).toLowerCase().includes(cfg.query.toLowerCase())
        ? 0.08
        : 0;
      hints.push({
        name: sym.name,
        path: file.path,
        kind: sym.kind,
        score: Number(Math.max(0, file.score * (0.92 - i * 0.08) + qBoost).toFixed(4)),
      });
    }
  }

  return {
    ok: true,
    hints: hints.slice(0, cfg.limit),
    omitted,
    scanned: headerReads,
    headerBytes: cfg.headerBytes,
    query: cfg.query || undefined,
  };
}

async function mapSession(sandbox, sessionId, opts = {}) {
  if (!sandbox || typeof sandbox.listFiles !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  const files = await sandbox.listFiles(sessionId, opts.path || '.');
  const paths = (files || []).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  return buildRepoMap(
    paths,
    async (rel) => sandbox.readFile(sessionId, rel),
    opts,
  );
}

async function walkWorkspaceFiles(rootAbs, maxFiles) {
  const out = [];
  async function walk(rel) {
    if (out.length >= maxFiles * 4) return;
    const abs = rel ? path.join(rootAbs, rel) : rootAbs;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (skipPath(`${child}/`) || skipPath(child)) continue;
      if (ent.isDirectory()) {
        await walk(child);
      } else if (ent.isFile()) {
        out.push(child);
      }
    }
  }
  await walk('');
  return out;
}

/**
 * Map a workspace root on disk (tests / DEV). HTTP never takes a raw root —
 * sessions stay inside the coding-sandbox jail.
 */
async function mapWorkspaceRoot(root, opts = {}) {
  const resolved = path.resolve(String(root || ''));
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    fail('E_PARAMS', 'El directorio del workspace no existe.');
  }
  if (!stat.isDirectory()) fail('E_PARAMS', 'La raíz del mapa debe ser un directorio.');
  const cfg = parseOpts(opts);
  const paths = await walkWorkspaceFiles(resolved, cfg.maxFiles);
  return buildRepoMap(
    paths,
    async (rel, maxBytes) => {
      const abs = path.resolve(resolved, rel);
      if (abs !== resolved && !abs.startsWith(`${resolved}${path.sep}`)) {
        fail('E_PATH_ESCAPE');
      }
      const fh = await fs.open(abs, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
        return buf.slice(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    },
    opts,
  );
}

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

async function mapForRequest(sandbox, sessionId, opts, env) {
  requireEnabled(env);
  return mapSession(sandbox, sessionId, opts);
}

module.exports = {
  buildRepoMap,
  mapSession,
  mapWorkspaceRoot,
  mapForRequest,
  requireEnabled,
  extractSymbols,
  extractRelativeImports,
  resolveImport,
  pageRank,
  pathHeuristic,
  HEADER_BYTES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_MAX_FILES,
  SKIP_RE,
  SOURCE_RE,
  CodingSandboxError,
};
