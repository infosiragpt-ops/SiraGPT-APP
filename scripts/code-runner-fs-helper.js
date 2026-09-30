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
  fsyncSync,
  linkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { spawnSync } = require('node:child_process');

// Linux production wraps the trusted helper in util-linux flock (already in
// the runner image). Lock the workspace DIRECTORY: no orphan lockfile exists.
const kernelLockHeld = process.argv[2] === '--workspace-locked';
if (kernelLockHeld) process.argv.splice(2, 1);

const EDITOR_MAX_BYTES = 500 * 1024;

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

// Direct function consumers use this portable per-file guard. The Linux CLI
// instead holds a kernel flock of the workspace, released even on SIGKILL.
// A portable guard is never force-unlocked while its owner might still live.
function withFileMutationLock(root, rel, work) {
  assertRoot(root);
  if (kernelLockHeld) return work();
  const key = createHash('sha256').update(rel).digest('hex');
  const lock = `${root}/.sira-editor-lock-${key}`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error?.code === 'EEXIST') throw publicError('file_busy');
    throw error;
  }
  try { return work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function safeWriteFiles(root, files, { maxFiles = 200, maxFileBytes = 2_000_000, maxTotalBytes = 20_000_000 } = {}) {
  let written = 0;
  let totalBytes = 0;
  for (const file of (Array.isArray(files) ? files : []).slice(0, maxFiles)) {
    const rel = normalizeRelativePath(file && file.path);
    if (!rel || typeof file.content !== 'string') continue;
    const bytes = Buffer.byteLength(file.content);
    if (bytes > maxFileBytes || totalBytes + bytes > maxTotalBytes) continue;
    try {
      withFileMutationLock(root, rel, () => {
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
        } finally { if (fd != null) closeSync(fd); }
      });
    } catch {
      // Importation keeps its established best-effort semantics. Its caller
      // must report the actual count instead of claiming the entire batch.
    }
  }
  return { written, totalBytes };
}

function editorRelativePath(rawRel) {
  const value = typeof rawRel === 'string' ? rawRel.trim() : '';
  if (!value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) throw publicError('invalid_request');
  const rel = normalizeRelativePath(value);
  if (!rel) throw publicError('invalid_request');
  const parts = rel.split('/');
  const leaf = parts[parts.length - 1];
  if (parts.some((part) => part === '.git' || part.startsWith('.sira-editor-'))
      || (leaf === '.env' || (leaf.startsWith('.env.') && leaf !== '.env.example'))
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(leaf)) {
    throw publicError('protected_path');
  }
  return rel;
}

function decodeEditorText(buffer) {
  if (buffer.includes(0)) throw publicError('binary_file');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw publicError('binary_file'); }
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(content)) throw publicError('protected_path');
  return content;
}

function revisionOf(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function safeReadEditorFile(root, rawRel) {
  const rel = editorRelativePath(rawRel);
  const abs = ensureSafeParents(root, rel);
  const before = lstatOrNull(abs);
  if (!before) throw publicError('file_not_found');
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw publicError('unsafe_path');
  let fd = null;
  try {
    fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) throw publicError('unsafe_path');
    if (stat.size > EDITOR_MAX_BYTES) {
      return { path: rel, content: '', revision: null, sizeBytes: stat.size, truncated: true, readOnly: true };
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== buffer.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw publicError('file_conflict');
    const content = decodeEditorText(buffer);
    return { path: rel, content, revision: revisionOf(buffer), sizeBytes: buffer.length, truncated: false, readOnly: false };
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') throw publicError('unsafe_path');
    throw error;
  } finally { if (fd != null) closeSync(fd); }
}

function safeSaveEditorFile(root, { path: rawRel, content, expectedRevision } = {}) {
  const rel = editorRelativePath(rawRel);
  if (typeof content !== 'string' || (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)))) throw publicError('invalid_request');
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > EDITOR_MAX_BYTES) throw publicError('file_too_large');
  // Lone surrogates would be replaced on encoding, so never confirm a lossy save.
  if (decodeEditorText(buffer) !== content) throw publicError('binary_file');
  return withFileMutationLock(root, rel, () => {
    const abs = ensureSafeParents(root, rel, { create: expectedRevision === null });
    const before = lstatOrNull(abs);
    if (before && (before.isSymbolicLink() || !before.isFile() || before.nlink > 1)) throw publicError('unsafe_path');
    if ((before && expectedRevision === null) || (!before && expectedRevision !== null)) throw publicError('file_conflict');
    if (before) {
      const current = safeReadEditorFile(root, rel);
      if (current.readOnly) throw publicError('file_read_only');
      if (current.revision !== expectedRevision) throw publicError('file_conflict');
    }
    const temporaryRel = `${dirname(rel) === '.' ? '' : `${dirname(rel)}/`}.sira-editor-temp-${randomUUID()}`;
    const temporary = ensureSafeParents(root, temporaryRel);
    let fd = null;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, before ? before.mode & 0o700 : 0o600);
      fchmodSync(fd, before ? before.mode & 0o700 : 0o600);
      writeFileSync(fd, buffer);
      fsyncSync(fd);
      closeSync(fd); fd = null;
      // Recheck parent jails and the exact current bytes immediately before
      // publishing. Atomic rename avoids a partially written visible file.
      ensureSafeParents(root, rel);
      if (before) {
        const current = safeReadEditorFile(root, rel);
        const fresh = lstatSync(abs);
        if (current.revision !== expectedRevision || fresh.ino !== before.ino || fresh.dev !== before.dev || fresh.mtimeMs !== before.mtimeMs || fresh.ctimeMs !== before.ctimeMs) throw publicError('file_conflict');
        renameSync(temporary, abs);
      } else {
        try { linkSync(temporary, abs); } catch (error) {
          if (error?.code === 'EEXIST') throw publicError('file_conflict');
          throw error;
        }
        unlinkSync(temporary);
      }
      return { path: rel, revision: revisionOf(buffer), sizeBytes: buffer.length, truncated: false, readOnly: false, written: 1 };
    } finally {
      if (fd != null) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  });
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

function safeReadBinaryFile(root, rawRel, maxBytes = 6_000_000) {
  const rel = normalizeRelativePath(rawRel);
  if (!rel) throw publicError('invalid_request');
  const abs = ensureSafeParents(root, rel);
  const before = lstatOrNull(abs);
  if (!before) throw publicError('file_not_found');
  if (before.isSymbolicLink() || !before.isFile()) throw publicError('unsafe_path');

  const limit = Math.min(Math.max(Number(maxBytes) || 0, 1), 12_000_000);
  if (before.size > limit) throw publicError('file_too_large');

  let fd = null;
  try {
    fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) throw publicError('unsafe_path');
    if (st.size > limit) throw publicError('file_too_large');
    const buffer = Buffer.alloc(st.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    const content = buffer.subarray(0, bytesRead);
    return {
      path: rel,
      bytes: content.length,
      contentBase64: content.toString('base64'),
    };
  } catch (error) {
    if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) throw publicError('unsafe_path');
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function shouldIgnoreExport(rel) {
  // Excluir tanto directorios ignorados como archivos de entorno (.env, .env.local…)
  // que pueden contener secretos reales del proyecto generado.
  const segments = rel.split('/');
  for (const segment of segments) {
    if (IGNORED_EXPORT_DIRS.has(segment)) return true;
  }
  const leaf = segments[segments.length - 1];
  return leaf === '.env' || /^\.env\.[A-Za-z0-9_-]+$/.test(leaf);
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

function collectExportDirectory(root, rawRel, limits = {}) {
  const rel = normalizeRelativePath(rawRel);
  if (!rel) throw publicError('invalid_request');
  const abs = ensureSafeParents(root, rel);
  const st = lstatOrNull(abs);
  if (!st) throw publicError('file_not_found');
  if (!st.isDirectory() || st.isSymbolicLink()) throw publicError('unsafe_path');
  return collectExportFiles(abs, limits);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const action = process.argv[2];
  const root = process.cwd();
  if (process.platform === 'linux' && !kernelLockHeld && ['write', 'save-editor', 'read-editor'].includes(action)) {
    assertRoot(root);
    const child = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', root,
      process.execPath, __filename, '--workspace-locked', ...process.argv.slice(2)], {
      cwd: root, input: ['write', 'save-editor'].includes(action) ? await readStdin() : undefined,
      encoding: 'utf8', maxBuffer: 4_000_000,
    });
    if (child.error) throw publicError('filesystem_lock_unavailable');
    if (child.status == null) throw publicError('filesystem_operation_failed');
    if (child.status === 75) throw publicError('file_busy');
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    process.exitCode = child.status || 0;
    return;
  }
  if (action === 'write') {
    const payload = JSON.parse(await readStdin());
    const result = safeWriteFiles(root, payload.files, payload.limits);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (action === 'read-editor') {
    process.stdout.write(JSON.stringify({ ok: true, ...safeReadEditorFile(root, process.argv[3]) }));
    return;
  }
  if (action === 'save-editor') {
    process.stdout.write(JSON.stringify({ ok: true, ...safeSaveEditorFile(root, JSON.parse(await readStdin())) }));
    return;
  }
  if (action === 'read') {
    const result = safeReadFile(root, process.argv[3], Number(process.argv[4]) || 200_000);
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (action === 'read-base64') {
    const result = safeReadBinaryFile(root, process.argv[3], Number(process.argv[4]) || 6_000_000);
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
  if (action === 'export-dir') {
    const result = collectExportDirectory(root, process.argv[3], {
      maxFiles: Number(process.argv[4]) || 5000,
      maxTotalBytes: Number(process.argv[5]) || 20_000_000,
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
  safeReadEditorFile,
  safeSaveEditorFile,
  editorRelativePath,
  EDITOR_MAX_BYTES,
  safeReadBinaryFile,
  collectExportFiles,
  collectExportDirectory,
};
