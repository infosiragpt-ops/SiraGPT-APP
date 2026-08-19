'use strict';

/**
 * host-code-search-tool — read-only code navigation for autonomous repo work.
 *
 * Three tools that let the agent explore an on-disk checkout the way a coding
 * agent does: `list_dir` (directory tree), `glob_files` (find by pattern),
 * and `code_grep` (search file contents by regex). They fill the gap left by
 * `host_bash`, whose allowlist forbids pipes — so `grep -r ... | head` is
 * impossible — and by `read_file`/`search_code`, which only see the RAG
 * collection, not the freshly-cloned files on disk.
 *
 * Security: these reuse the SAME sandbox boundary as host_file/host_bash —
 * the shared workspace roots (`workspace-roots.js`), the secret-file blocklist
 * (`.env*`, private keys), and the traversal guard. They are pure JS (no
 * shell), never follow symlinks (escape defense), and are read-only.
 */

const fs = require('fs');
const path = require('path');
const {
  allowedWorkspaceRoots,
  defaultProjectsDir,
  describeWorkspaceRoots,
  isPathWithinWorkspace,
} = require('./workspace-roots');
const { _internal: hostFileInternal } = require('./host-file-tool');
const { match, anyMatch } = require('../../utils/glob-match');

const { resolveSafePath, isBlockedSecretPath } = hostFileInternal;

// Directories we never descend into — build noise that would blow every cap
// and bury real signal.
const DEFAULT_IGNORES = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.cache', '.turbo', 'out', '.venv', 'venv', '__pycache__', '.pytest_cache',
  '.gradle', 'target', 'bin', 'obj', '.idea', '.vscode', 'vendor',
]);

const MAX_LIST_ENTRIES = 600;
const MAX_LIST_DEPTH = 6;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 6000;
const MAX_FILE_BYTES_SCAN = 2 * 1024 * 1024; // skip files > 2MB in grep
const MAX_LINE_TEST_CHARS = 1000; // bound regex input per line (ReDoS guard)
const MAX_LINE_PREVIEW = 240;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Resolve a directory argument to a real, in-sandbox absolute path. Defaults
 * to the projects dir. Re-validates through realpath so a symlinked directory
 * cannot smuggle the agent outside the workspace roots.
 */
function resolveSafeDir(dirArg) {
  const raw = String(dirArg == null ? '' : dirArg).trim();
  let resolved;
  if (!raw || raw === '.') {
    resolved = defaultProjectsDir();
  } else {
    resolved = resolveSafePath(raw, defaultProjectsDir());
  }
  if (!resolved) return null;
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* may not exist yet */ }
  if (!isPathWithinWorkspace(real)) return null;
  return resolved;
}

function invalidDir() {
  return { ok: false, error: `Ruta inválida. Solo se permiten directorios dentro de: ${describeWorkspaceRoots()}.` };
}

/**
 * Depth-first file walker bounded by ignore-dirs, a file cap, and a hard
 * refusal to follow symlinks or leave the workspace. Yields absolute paths.
 */
function* walkFiles(rootDir, { maxFiles = MAX_GREP_FILES, includeHidden = false } = {}) {
  let count = 0;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const name = ent.name;
      if (!includeHidden && name.startsWith('.')) continue;
      if (DEFAULT_IGNORES.has(name)) continue;
      if (ent.isSymbolicLink()) continue; // never follow symlinks
      const full = path.join(dir, name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;
      if (isBlockedSecretPath(full)) continue;
      if (!isPathWithinWorkspace(full)) continue;
      count += 1;
      if (count > maxFiles) return;
      yield full;
    }
  }
}

// ── list_dir ──────────────────────────────────────────────────────────────

function listDir(args = {}, ctx = {}) {
  const dir = resolveSafeDir(args.path != null ? args.path : args.directory);
  if (!dir) return invalidDir();
  let rootStat;
  try { rootStat = fs.statSync(dir); } catch { return { ok: false, error: `El directorio no existe: ${dir}` }; }
  if (!rootStat.isDirectory()) return { ok: false, error: 'La ruta no es un directorio.' };

  const depth = clampInt(args.depth, 1, MAX_LIST_DEPTH, 1);
  const includeHidden = args.includeHidden === true;
  ctx.onEvent?.({ type: 'tool_call', tool: 'list_dir', preview: `${dir} (depth ${depth})` });

  const entries = [];
  let truncated = false;
  const walk = (cur, rel, d) => {
    if (truncated) return;
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => {
      // Directories first, then files, each alphabetically — readable trees.
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });
    for (const it of items) {
      if (truncated) return;
      const name = it.name;
      if (!includeHidden && name.startsWith('.')) continue;
      if (DEFAULT_IGNORES.has(name)) continue;
      if (it.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      if (it.isDirectory()) {
        entries.push({ path: relPath, type: 'dir' });
        if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
        if (d < depth) walk(path.join(cur, name), relPath, d + 1);
      } else if (it.isFile()) {
        let sizeBytes = null;
        try { sizeBytes = fs.statSync(path.join(cur, name)).size; } catch { /* ignore */ }
        entries.push({ path: relPath, type: 'file', sizeBytes });
        if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
      }
    }
  };
  walk(dir, '', 1);
  return { ok: true, path: dir, depth, count: entries.length, entries, truncated };
}

// ── glob_files ──────────────────────────────────────────────────────────────

function globFiles(args = {}, ctx = {}) {
  const dir = resolveSafeDir(args.directory != null ? args.directory : args.path);
  if (!dir) return invalidDir();
  const pattern = String(args.pattern || '').trim();
  if (!pattern) return { ok: false, error: 'pattern es requerido (ej. "**/*.ts" o "src/*.js").' };
  try { fs.statSync(dir); } catch { return { ok: false, error: `El directorio no existe: ${dir}` }; }

  const includeHidden = args.includeHidden === true;
  ctx.onEvent?.({ type: 'tool_call', tool: 'glob_files', preview: `${pattern} in ${dir}` });

  const files = [];
  let truncated = false;
  for (const full of walkFiles(dir, { includeHidden, maxFiles: MAX_GREP_FILES })) {
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (match(pattern, rel) || match(pattern, path.basename(full))) {
      files.push(rel);
      if (files.length >= MAX_GLOB_RESULTS) { truncated = true; break; }
    }
  }
  files.sort();
  return { ok: true, directory: dir, pattern, count: files.length, files, truncated };
}

// ── code_grep ──────────────────────────────────────────────────────────────

function codeGrep(args = {}, ctx = {}) {
  const dir = resolveSafeDir(args.directory != null ? args.directory : args.path);
  if (!dir) return invalidDir();
  const patternStr = String(args.pattern || '');
  if (!patternStr) return { ok: false, error: 'pattern (regex) es requerido.' };
  try { fs.statSync(dir); } catch { return { ok: false, error: `El directorio no existe: ${dir}` }; }

  let re;
  try {
    re = new RegExp(patternStr, args.ignoreCase === true ? 'i' : '');
  } catch (err) {
    return { ok: false, error: `Expresión regular inválida: ${err.message}` };
  }

  const include = args.include != null
    ? (Array.isArray(args.include) ? args.include : [args.include]).map(String).filter(Boolean)
    : null;
  const includeHidden = args.includeHidden === true;
  ctx.onEvent?.({ type: 'tool_call', tool: 'code_grep', preview: `/${patternStr}/ in ${dir}` });

  const matches = [];
  let filesScanned = 0;
  let truncated = false;

  outer:
  for (const full of walkFiles(dir, { includeHidden, maxFiles: MAX_GREP_FILES })) {
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (include && !anyMatch(include, rel) && !anyMatch(include, path.basename(full))) continue;

    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES_SCAN) continue;

    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    filesScanned += 1;

    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Bound the regex input length per line to neutralize catastrophic
      // backtracking on minified/one-line files.
      const probe = line.length > MAX_LINE_TEST_CHARS ? line.slice(0, MAX_LINE_TEST_CHARS) : line;
      if (re.test(probe)) {
        matches.push({ file: rel, line: i + 1, text: line.slice(0, MAX_LINE_PREVIEW) });
        if (matches.length >= MAX_GREP_MATCHES) { truncated = true; break outer; }
      }
    }
  }

  return {
    ok: true,
    directory: dir,
    pattern: patternStr,
    matchCount: matches.length,
    filesScanned,
    matches,
    truncated,
  };
}

// ── tool descriptors ────────────────────────────────────────────────────────

const listDirTool = {
  name: 'list_dir',
  description: 'List files and folders in a directory tree on the host, within the SiraGPT workspace roots. Read-only. Skips node_modules/.git and other build dirs. Use after clone_project to explore a repo before reading or editing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Absolute (within workspace roots) or relative to ~/Desktop/sira-projects. Defaults to the projects dir.' },
      depth: { type: 'integer', minimum: 1, maximum: MAX_LIST_DEPTH, description: 'How many levels deep to descend. Default 1.' },
      includeHidden: { type: 'boolean', description: 'Include dotfiles/dotdirs. Default false.' },
    },
    required: [],
    additionalProperties: false,
  },
  execute: listDir,
};

const globFilesTool = {
  name: 'glob_files',
  description: 'Find files by glob pattern under a directory on the host (e.g. "**/*.ts", "src/**/*.test.js"). Read-only, workspace-bounded, skips build dirs. Use to locate source files before reading or grepping them.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern matched against the path relative to directory. ** matches across folders; * within a segment.' },
      directory: { type: 'string', description: 'Root directory to search. Absolute (within workspace roots) or relative to ~/Desktop/sira-projects. Defaults to the projects dir.' },
      includeHidden: { type: 'boolean', description: 'Include dotfiles. Default false.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  execute: globFiles,
};

const codeGrepTool = {
  name: 'code_grep',
  description: 'Search file contents by JavaScript regular expression under a directory on the host (a real recursive grep). Returns file path + line number + matching line. Read-only, workspace-bounded, skips binaries and build dirs. Use to find where a symbol, string, or pattern is defined/used across a repo.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression to search for (line by line).' },
      directory: { type: 'string', description: 'Root directory to search. Absolute (within workspace roots) or relative to ~/Desktop/sira-projects. Defaults to the projects dir.' },
      include: { type: 'array', items: { type: 'string' }, description: 'Optional glob(s) to restrict which files are scanned (e.g. ["**/*.ts"]).' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive match. Default false.' },
      includeHidden: { type: 'boolean', description: 'Scan dotfiles. Default false.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  execute: codeGrep,
};

const codeSearchTools = [listDirTool, globFilesTool, codeGrepTool];

module.exports = {
  listDir,
  globFiles,
  codeGrep,
  listDirTool,
  globFilesTool,
  codeGrepTool,
  codeSearchTools,
  _internal: {
    resolveSafeDir,
    walkFiles,
    DEFAULT_IGNORES,
    MAX_GREP_MATCHES,
    MAX_GLOB_RESULTS,
  },
};
