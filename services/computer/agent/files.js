'use strict';

const path = require('path');
const fs = require('fs/promises');

const WORKSPACE_ROOT = process.env.COMPUTER_WORKSPACE_ROOT || '/workspace';

class FilePathError extends Error {
  constructor(message, code = 'PATH_REJECTED') {
    super(message);
    this.name = 'FilePathError';
    this.code = code;
    this.status = 400;
  }
}

function assertSafeRelPath(raw) {
  if (raw == null) throw new FilePathError('path is required');
  if (typeof raw !== 'string') throw new FilePathError('path must be a string');
  if (raw.includes('\0')) throw new FilePathError('null bytes are not allowed');
  let p = raw.trim();
  if (!p) throw new FilePathError('path is required');
  if (p === '/workspace') p = '.';
  else if (p.startsWith('/workspace/')) p = p.slice('/workspace/'.length);
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) {
    throw new FilePathError(`absolute paths are not allowed: ${raw}`);
  }
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) {
    throw new FilePathError(`path escapes the workspace: ${raw}`);
  }
  return norm === '.' ? '' : norm;
}

function resolveWorkspacePath(raw, root = WORKSPACE_ROOT) {
  const rel = assertSafeRelPath(raw);
  const resolvedRoot = path.resolve(root);
  const resolved = rel ? path.resolve(resolvedRoot, rel) : resolvedRoot;
  const relToRoot = path.relative(resolvedRoot, resolved);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new FilePathError(`path escapes the workspace: ${raw}`);
  }
  return { rel: rel || '.', abs: resolved, root: resolvedRoot };
}

async function listOrRead(raw, { root = WORKSPACE_ROOT, maxBytes = 2 * 1024 * 1024 } = {}) {
  const { rel, abs } = resolveWorkspacePath(raw, root);
  const st = await fs.stat(abs);
  if (st.isDirectory()) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return {
      kind: 'dir',
      path: rel,
      entries: entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
      })),
    };
  }
  if (!st.isFile()) throw new FilePathError('not a regular file', 'NOT_A_FILE');
  if (st.size > maxBytes) throw new FilePathError(`file exceeds ${maxBytes} bytes`, 'TOO_LARGE');
  const buf = await fs.readFile(abs);
  return {
    kind: 'file',
    path: rel,
    size: st.size,
    contentBase64: buf.toString('base64'),
  };
}

async function writeFileSafe(raw, content, { root = WORKSPACE_ROOT, encoding = 'utf8', maxBytes = 4 * 1024 * 1024 } = {}) {
  const { rel, abs, root: resolvedRoot } = resolveWorkspacePath(raw, root);
  if (rel === '.') throw new FilePathError('cannot overwrite the workspace root');
  const buf = Buffer.isBuffer(content)
    ? content
    : encoding === 'base64'
      ? Buffer.from(String(content), 'base64')
      : Buffer.from(String(content), 'utf8');
  if (buf.length > maxBytes) throw new FilePathError(`payload exceeds ${maxBytes} bytes`, 'TOO_LARGE');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const relDir = path.relative(resolvedRoot, path.dirname(abs));
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) {
    throw new FilePathError(`path escapes the workspace: ${raw}`);
  }
  await fs.writeFile(abs, buf);
  return { ok: true, path: rel, size: buf.length };
}

module.exports = {
  WORKSPACE_ROOT,
  FilePathError,
  assertSafeRelPath,
  resolveWorkspacePath,
  listOrRead,
  writeFileSafe,
};
