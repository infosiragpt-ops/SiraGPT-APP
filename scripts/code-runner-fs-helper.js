'use strict';

/**
 * Trusted filesystem helper for code-runner.
 *
 * The control API invokes this file through setpriv as the PROJECT uid. That
 * is the important security boundary: a generated process may race path
 * checks, but the kernel still denies that uid access to the runner's secrets,
 * /export, and every other project's 0700 workspace. O_NOFOLLOW plus explicit
 * component checks reject the normal (non-racing) symlink attacks as well.
 */

const {
  chownSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  lchownSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} = require('node:fs');
const { dirname } = require('node:path');

const IGNORED_EXPORT_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.turbo',
  'coverage', '.vite', '.output', '.parcel-cache', '.svelte-kit',
]);
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function publicError(code, message = code) {
  const error = new Error(message);
  error.publicCode = code;
  return error;
}

function normalizeRelativePath(raw) {
  const value = String(raw || '').replaceAll('\\', '/').trim();
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const parts = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    parts.push(segment);
  }
  return parts.length ? parts.join('/') : null;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateNoUnsafeHardlinks(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) validateNoUnsafeHardlinks(`${path}/${name}`);
    return;
  }
  // A legacy root-runner process could have linked an inode from another
  // workspace. Chowning this name would also chown the hidden peer inode.
  if (st.nlink > 1) throw publicError('unsafe_hardlink');
}

function applyOwnership(path, uid, gid) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    lchownSync(path, uid, gid);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) applyOwnership(`${path}/${name}`, uid, gid);
  }
  chownSync(path, uid, gid);
}

function migrateOwnershipTree(path, identity) {
  const uid = Math.trunc(Number(identity && identity.uid));
  const gid = Math.trunc(Number(identity && identity.gid));
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw publicError('invalid_identity');
  }
  // Validate the entire tree before changing a single inode.
  validateNoUnsafeHardlinks(path);
  applyOwnership(path, uid, gid);
}

function sealWorkspaceRoot(root, projectsName = 'projects', owner = { uid: 0, gid: 0 }) {
  const uid = Math.trunc(Number(owner && owner.uid));
  const gid = Math.trunc(Number(owner && owner.gid));
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    throw publicError('invalid_identity');
  }
  assertRoot(root);
  const entries = readdirSync(root);

  // Validate before mutating anything. A legacy root workspace containing a
  // top-level symlink, special file, or hardlink needs operator cleanup rather
  // than a best-effort chmod that could touch an unrelated inode.
  for (const name of entries) {
    const path = `${root}/${name}`;
    const st = lstatSync(path);
    if (name === projectsName) {
      if (!st.isDirectory() || st.isSymbolicLink()) throw publicError('unsafe_projects_directory');
      continue;
    }
    if (st.isSymbolicLink()) throw publicError('unsafe_legacy_workspace_entry');
    if (st.isFile()) {
      if (st.nlink > 1) throw publicError('unsafe_hardlink');
      continue;
    }
    if (!st.isDirectory()) throw publicError('unsafe_legacy_workspace_entry');
  }

  chownSync(root, uid, gid);
  chmodSync(root, 0o711);
  for (const name of entries) {
    const path = `${root}/${name}`;
    const st = lstatSync(path);
    chownSync(path, uid, gid);
    chmodSync(path, name === projectsName ? 0o711 : st.isDirectory() ? 0o700 : 0o600);
  }
}

function assertRoot(root) {
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw publicError('unsafe_path');
}

function ensureSafeParents(root, rel, { create = false } = {}) {
  assertRoot(root);
  const parent = dirname(rel);
  if (!parent || parent === '.') return `${root}/${rel}`;
  let current = root;
  for (const segment of parent.split('/')) {
    current = `${current}/${segment}`;
    let st = lstatOrNull(current);
    if (!st && create) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }
      st = lstatOrNull(current);
    }
    if (!st) throw publicError('file_not_found');
    if (!st.isDirectory() || st.isSymbolicLink()) throw publicError('unsafe_path');
  }
  return `${root}/${rel}`;
}

function safeWriteFiles(root, files, { maxFiles = 200, maxFileBytes = 2_000_000, maxTotalBytes = 20_000_000 } = {}) {
  let written = 0;
  let totalBytes = 0;
  for (const file of (Array.isArray(files) ? files : []).slice(0, maxFiles)) {
    const rel = normalizeRelativePath(file && file.path);
    if (!rel || typeof file.content !== 'string') continue;
    const bytes = Buffer.byteLength(file.content);
    if (bytes > maxFileBytes || totalBytes + bytes > maxTotalBytes) continue;
    let fd = null;
    try {
      const abs = ensureSafeParents(root, rel, { create: true });
      const existing = lstatOrNull(abs);
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw publicError('unsafe_path');
      fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, file.content, 'utf8');
      written++;
      totalBytes += bytes;
    } catch {
      // Batch semantics intentionally match the old endpoint: one invalid path
      // is skipped while valid files are still persisted.
    } finally {
      if (fd != null) closeSync(fd);
    }
  }
  return { written, totalBytes };
}

function safeReadFile(root, rawRel, maxBytes = 200_000) {
  const rel = normalizeRelativePath(rawRel);
  if (!rel) throw publicError('invalid_request');
  const abs = ensureSafeParents(root, rel);
  const before = lstatOrNull(abs);
  if (!before) throw publicError('file_not_found');
  if (before.isSymbolicLink() || !before.isFile()) throw publicError('unsafe_path');

  let fd = null;
  try {
    fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) throw publicError('unsafe_path');
    const buffer = Buffer.alloc(Math.min(Math.max(0, st.size), maxBytes));
    const bytesRead = buffer.length ? readSync(fd, buffer, 0, buffer.length, 0) : 0;
    return { path: rel, content: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (error) {
    if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) throw publicError('unsafe_path');
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function shouldIgnoreExport(rel) {
  return rel.split('/').some((segment) => IGNORED_EXPORT_DIRS.has(segment));
}

function collectExportFiles(root, { maxFiles = 5000, maxTotalBytes = 20_000_000 } = {}) {
  assertRoot(root);
  const files = [];
  let totalBytes = 0;

  const walk = (relBase) => {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) return;
    const absDir = relBase ? `${root}/${relBase}` : root;
    for (const name of readdirSync(absDir)) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      const rel = relBase ? `${relBase}/${name}` : name;
      if (shouldIgnoreExport(rel)) continue;
      const abs = `${root}/${rel}`;
      const st = lstatOrNull(abs);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!st.isFile() || st.size > maxTotalBytes - totalBytes) continue;

      let fd = null;
      try {
        // openSync is performed by the project uid and O_NOFOLLOW closes the
        // leaf-symlink race. Parent races cannot cross an uid permission wall.
        fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
        const current = fstatSync(fd);
        if (!current.isFile() || current.size > maxTotalBytes - totalBytes) continue;
        const buffer = Buffer.alloc(current.size);
        const bytesRead = buffer.length ? readSync(fd, buffer, 0, buffer.length, 0) : 0;
        const content = buffer.subarray(0, bytesRead);
        files.push({ path: rel, content: content.toString('base64') });
        totalBytes += content.length;
      } catch (error) {
        if (!error || !['ELOOP', 'EMLINK', 'ENOENT', 'EACCES'].includes(error.code)) throw error;
      } finally {
        if (fd != null) closeSync(fd);
      }
    }
  };

  walk('');
  return { files, totalBytes };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const action = process.argv[2];
  const root = process.cwd();
  if (action === 'write') {
    const payload = JSON.parse(await readStdin());
    const result = safeWriteFiles(root, payload.files, payload.limits);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (action === 'read') {
    const result = safeReadFile(root, process.argv[3], Number(process.argv[4]) || 200_000);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (action === 'export') {
    const result = collectExportFiles(root, {
      maxFiles: Number(process.argv[3]) || 5000,
      maxTotalBytes: Number(process.argv[4]) || 20_000_000,
    });
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    return;
  }
  throw publicError('invalid_action');
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: error.publicCode || 'filesystem_operation_failed' }));
    process.stderr.write(String(error && error.message ? error.message : error).slice(0, 500));
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeRelativePath,
  validateNoUnsafeHardlinks,
  migrateOwnershipTree,
  sealWorkspaceRoot,
  ensureSafeParents,
  safeWriteFiles,
  safeReadFile,
  collectExportFiles,
};
