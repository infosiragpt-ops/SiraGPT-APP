'use strict';

/**
 * workspace-files.service — file CRUD inside an already-cloned repository
 * checkout so the editor can browse/read/write the REAL repo on disk (the
 * thing git status/commit/push actually sees), Replit-style.
 *
 * Every path is funnelled through `resolveInside()`:
 *   - the cloned repo root is the absolute jail; nothing may escape it
 *   - `..`, absolute paths, NUL bytes and leading-dash flag smuggling rejected
 *   - the `.git` directory is off-limits for reads and writes (you manage it
 *     through the git.service, never by hand)
 *
 * The route layer resolves + ownership-checks the connection first and hands us
 * the validated `localPath` (the WorkspaceManager-approved clone root).
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// Directories never walked when building the tree (heavy / not source).
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
]);

const DEFAULT_MAX_ENTRIES = 5000; // tree node cap — protects against huge repos
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB — editor text cap
const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MB

function fileError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Reject a relative path that could escape the repo or smuggle a CLI flag. */
function isUnsafeRel(rel) {
  const v = String(rel == null ? '' : rel);
  if (v.includes('\0')) return true;
  if (path.isAbsolute(v) || path.win32.isAbsolute(v)) return true;
  // any segment that is ".." or starts with "-"
  return v
    .split(/[\\/]+/)
    .some((seg) => seg === '..' || seg.startsWith('-'));
}

/**
 * Resolve `rel` to an absolute path that is guaranteed to live inside `root`.
 * `rel === ''` resolves to the root itself (used for tree listing).
 */
function resolveInside(root, rel) {
  const normalizedRoot = path.resolve(root);
  const raw = String(rel == null ? '' : rel);
  if (isUnsafeRel(raw)) {
    throw fileError(400, 'invalid_path', `Invalid path: ${raw}`);
  }
  const cleaned = raw.replace(/^[\\/]+/, '');
  if (isUnsafeRel(cleaned)) {
    throw fileError(400, 'invalid_path', `Invalid path: ${cleaned}`);
  }
  const abs = path.resolve(normalizedRoot, cleaned);
  // Containment: abs must equal root or be nested under root + separator.
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
    throw fileError(400, 'path_escape', 'Path escapes the workspace root');
  }
  // Never let callers touch .git through the file API.
  const relFromRoot = path.relative(normalizedRoot, abs);
  const firstSeg = relFromRoot.split(/[\\/]+/)[0];
  if (firstSeg === '.git') {
    throw fileError(403, 'git_dir_protected', 'The .git directory is read-only via the file API');
  }
  return abs;
}

/** Forward-slash relative path (stable across OSes for the client). */
function toPosixRel(root, abs) {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

/**
 * Build a nested file tree for the editor's file explorer. Skips IGNORED_DIRS,
 * sorts dirs-first then alphabetically, and stops at MAX_ENTRIES / MAX_DEPTH.
 *
 * @returns {{ tree: object[], truncated: boolean, count: number }}
 */
async function listTree(root, { maxEntries = DEFAULT_MAX_ENTRIES, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const normalizedRoot = path.resolve(root);
  let count = 0;
  let truncated = false;

  async function walk(absDir, depth) {
    if (depth > maxDepth) {
      truncated = true;
      return [];
    }
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      const isDir = ent.isDirectory();
      if (isDir && IGNORED_DIRS.has(ent.name)) continue;
      if (ent.isSymbolicLink()) continue; // don't follow symlinks out of the jail
      const abs = path.join(absDir, ent.name);
      const rel = toPosixRel(normalizedRoot, abs);
      count += 1;
      if (isDir) {
        dirs.push({ name: ent.name, path: rel, type: 'dir', children: await walk(abs, depth + 1) });
      } else if (ent.isFile()) {
        let size = 0;
        try {
          size = (await fsp.stat(abs)).size;
        } catch {
          /* ignore */
        }
        files.push({ name: ent.name, path: rel, type: 'file', size });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  const tree = await walk(normalizedRoot, 0);
  return { tree, truncated, count };
}

/** Heuristic: treat a buffer as binary if it has a NUL in the first 8 KB. */
function looksBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Read a file for the editor. Returns text content, or a binary marker for
 * non-text files (the editor shows a "binary file" placeholder).
 */
async function readFile(root, rel, { maxBytes = DEFAULT_MAX_READ_BYTES } = {}) {
  const abs = resolveInside(root, rel);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw fileError(404, 'not_found', `File not found: ${rel}`);
  }
  if (stat.isDirectory()) {
    throw fileError(400, 'is_directory', 'Path is a directory, not a file');
  }
  if (stat.size > maxBytes) {
    return { path: toPosixRel(root, abs), tooLarge: true, size: stat.size, maxBytes };
  }
  const buf = await fsp.readFile(abs);
  if (looksBinary(buf)) {
    return { path: toPosixRel(root, abs), binary: true, size: stat.size };
  }
  return { path: toPosixRel(root, abs), content: buf.toString('utf8'), size: stat.size };
}

/**
 * Read every (text) file in the workspace in one shot — used to hydrate an
 * editor with the real repo contents. Skips IGNORED_DIRS, binary files and
 * oversized files; capped by maxFiles + per-file maxBytes.
 *
 * @returns {{ files: {path:string, content:string}[], truncated: boolean }}
 */
async function readAllText(root, { maxFiles = 800, maxBytes = 512 * 1024 } = {}) {
  const normalizedRoot = path.resolve(root);
  const out = [];
  let truncated = false;

  async function walk(absDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        await walk(path.join(absDir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      const abs = path.join(absDir, ent.name);
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > maxBytes) continue;
      let buf;
      try {
        buf = await fsp.readFile(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      out.push({ path: toPosixRel(normalizedRoot, abs), content: buf.toString('utf8') });
    }
  }

  await walk(normalizedRoot);
  return { files: out, truncated };
}

/** Create or overwrite a text file, creating parent dirs as needed. */
async function writeFile(root, rel, content, { maxBytes = DEFAULT_MAX_WRITE_BYTES } = {}) {
  const abs = resolveInside(root, rel);
  if (!rel || rel.endsWith('/') || rel.endsWith('\\')) {
    throw fileError(400, 'invalid_path', 'A file path is required');
  }
  const data = typeof content === 'string' ? content : String(content == null ? '' : content);
  if (Buffer.byteLength(data, 'utf8') > maxBytes) {
    throw fileError(413, 'too_large', `File exceeds the ${maxBytes}-byte write limit`);
  }
  // Refuse to overwrite an existing directory with a file.
  try {
    if ((await fsp.stat(abs)).isDirectory()) {
      throw fileError(400, 'is_directory', 'Path is an existing directory');
    }
  } catch (err) {
    if (err.status) throw err; // re-throw our own typed error
    /* ENOENT — fine, it's a new file */
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data, 'utf8');
  const stat = await fsp.stat(abs);
  return { path: toPosixRel(root, abs), size: stat.size, created: true };
}

/** Create an (empty) directory. Idempotent. */
async function createFolder(root, rel) {
  const abs = resolveInside(root, rel);
  if (!rel) throw fileError(400, 'invalid_path', 'A folder path is required');
  await fsp.mkdir(abs, { recursive: true });
  return { path: toPosixRel(root, abs), type: 'dir', created: true };
}

/** Rename / move a file or directory within the workspace. */
async function rename(root, from, to) {
  const absFrom = resolveInside(root, from);
  const absTo = resolveInside(root, to);
  try {
    await fsp.access(absFrom);
  } catch {
    throw fileError(404, 'not_found', `Source not found: ${from}`);
  }
  let toExists = true;
  try {
    await fsp.access(absTo);
  } catch {
    toExists = false;
  }
  if (toExists) {
    throw fileError(409, 'exists', `Destination already exists: ${to}`);
  }
  await fsp.mkdir(path.dirname(absTo), { recursive: true });
  await fsp.rename(absFrom, absTo);
  return { from: toPosixRel(root, absFrom), to: toPosixRel(root, absTo) };
}

/** Delete a file or directory (recursive for dirs). */
async function deleteEntry(root, rel) {
  const abs = resolveInside(root, rel);
  if (path.resolve(abs) === path.resolve(root)) {
    throw fileError(400, 'cannot_delete_root', 'Cannot delete the workspace root');
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw fileError(404, 'not_found', `Path not found: ${rel}`);
  }
  await fsp.rm(abs, { recursive: stat.isDirectory(), force: true });
  return { path: toPosixRel(root, abs), deleted: true };
}

module.exports = {
  resolveInside,
  isUnsafeRel,
  listTree,
  readAllText,
  readFile,
  writeFile,
  createFolder,
  rename,
  deleteEntry,
  // constants exposed for tests / route tuning
  IGNORED_DIRS,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
};
