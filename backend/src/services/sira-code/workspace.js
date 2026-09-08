'use strict';

/**
 * Per-session workspace for SiraCode.
 *
 * Reuses the same isolation ideas as doc-agent/sandbox (local driver) and
 * agents/code-sandbox: temp root, path jail, scrubbed env, timeout, abort.
 * Never executes against the process cwd or the raw host project tree.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildUntrustedChildEnv } = require('../../utils/untrusted-child-env');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.opencode',
  'coverage', '.turbo',
]);

// Native adaptation of OpenCode FileMutation / KeyedMutex (MIT), revision
// ecbc6ccac85b3e8087b6445e584318419b9e2b34. See THIRD_PARTY_NOTICES.md.
// Serializes cooperating mutations in this process, not shell/other processes.
const mutationLocks = new Map();

async function withMutationLock(key, operation) {
  const previous = mutationLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  mutationLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationLocks.get(key) === tail) mutationLocks.delete(key);
  }
}

function withMutationLocks(keys, operation) {
  const ordered = [...new Set(keys)].sort();
  const enter = (index) => index === ordered.length
    ? operation()
    : withMutationLock(ordered[index], () => enter(index + 1));
  return enter(0);
}

function mutationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mutationText(content) {
  const text = String(content == null ? '' : content);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    throw mutationError('file_too_large', 'archivo demasiado grande');
  }
  return text;
}

// Mutation snapshots must contain all bytes; display/list truncation is not a
// valid basis for an edit. Bound reads even if another process grows the file.
async function mutationBytes(abs) {
  const handle = await fs.open(abs, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK | fsSync.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw mutationError('not_a_file', 'no es un archivo');
    if (stat.size > MAX_FILE_BYTES) throw mutationError('file_too_large', 'archivo demasiado grande');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_FILE_BYTES) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) return buffer.subarray(0, offset);
      offset += bytesRead;
    }
    throw mutationError('file_too_large', 'archivo demasiado grande');
  } finally {
    await handle.close();
  }
}

async function assertUnchanged(abs, expected) {
  if (!Buffer.isBuffer(expected) || expected.length > MAX_FILE_BYTES) {
    throw mutationError('invalid_snapshot', 'la edición requiere una lectura completa del archivo');
  }
  let current;
  try {
    current = await mutationBytes(abs);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!current || !current.equals(expected)) {
    throw mutationError('file_changed', 'El archivo cambió. Léelo de nuevo antes de editarlo.');
  }
}

async function createExclusive(abs, content) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw mutationError('file_exists', 'El destino ya existe; no se ha reemplazado.');
    throw error;
  }
}

function workspaceRootFor(sessionId) {
  const safe = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'session';
  return path.join(os.tmpdir(), 'sira-code', safe);
}

function pathTraversalError() {
  const err = new Error('ruta fuera del workspace');
  err.code = 'path_traversal';
  return err;
}

function isInsideRoot(root, abs) {
  const rootReal = path.resolve(root);
  const resolved = path.resolve(abs);
  return resolved === rootReal || resolved.startsWith(rootReal + path.sep);
}

function jailPath(root, relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/').trim() || '.';
  const stripped = raw.replace(/^\/workspace\/?/, '');
  if (stripped.includes('\0')) {
    const err = new Error('path inválido');
    err.code = 'path_invalid';
    throw err;
  }
  const resolved = path.resolve(root, stripped);
  const rootReal = path.resolve(root);
  if (!isInsideRoot(rootReal, resolved)) {
    throw pathTraversalError();
  }
  return resolved;
}

/**
 * Lexical jail plus symlink follow. A mid-path link that escapes the
 * workspace is rejected even when the requested string looks in-tree.
 * Missing tails (new files) return the lexical path after parents pass.
 */
async function jailRealPath(root, relPath) {
  const resolved = jailPath(root, relPath);
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    rootReal = path.resolve(root);
  }
  // resolved is lexical; compare it to the same lexical root before walking
  // from rootReal (/var and /private/var can denote the same directory).
  const rel = path.relative(path.resolve(root), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw pathTraversalError();
  }
  let cursor = rootReal;
  const parts = rel === '' ? [] : rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await fs.lstat(cursor);
    } catch (err) {
      if (err && err.code === 'ENOENT') return resolved;
      throw err;
    }
    if (!st.isSymbolicLink()) continue;
    let real;
    try {
      real = await fs.realpath(cursor);
    } catch {
      throw pathTraversalError();
    }
    if (!isInsideRoot(rootReal, real)) throw pathTraversalError();
    cursor = real;
  }
  return cursor;
}

async function mutationTarget(root, relPath) {
  const abs = jailPath(root, relPath);
  const relative = path.relative(root, abs);
  let current = root;
  let canonical = await fs.realpath(root);
  // Mutation paths reject symlinks rather than treating two aliases as distinct
  // lock targets. This is not protection against hostile external path races.
  const segments = ['', ...relative.split(path.sep).filter(Boolean)];
  for (const [index, segment] of segments.entries()) {
    if (segment) current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        canonical = path.join(canonical, ...segments.slice(index));
        break;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw mutationError('path_symlink', 'No se modifican archivos mediante enlaces simbólicos.');
    if (current === abs && !stat.isFile()) throw mutationError('not_a_file', 'no es un archivo');
    if (current === abs && stat.nlink > 1) throw mutationError('file_links', 'No se modifican archivos con varios enlaces físicos.');
    canonical = await fs.realpath(current);
  }
  // Resolve existing names through the filesystem: lowercasing alone misses
  // aliases such as sigma/final-sigma on APFS. Canonicalize existing parents
  // for prospective files too. Conservative normalization may serialize some
  // distinct names on case-sensitive hosts, but never changes their contents.
  return { abs, key: canonical.normalize('NFD').toLowerCase() };
}

async function createWorkspace(sessionId) {
  const directory = workspaceRootFor(sessionId);
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) {
    throw mutationError('path_symlink', 'El directorio de la sesión no puede ser un enlace simbólico.');
  }
  // macOS TMPDIR may use /var while realpath returns /private/var. Keep the
  // workspace, jail and tool-return paths on the same canonical root.
  const root = await fs.realpath(directory);
  return {
    root,
    resolve(relPath) {
      return jailPath(root, relPath);
    },
    async resolveSafe(relPath) {
      return jailRealPath(root, relPath);
    },
    async readFile(relPath) {
      const abs = await jailRealPath(root, relPath);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        const err = new Error('no es un archivo');
        err.code = 'not_a_file';
        throw err;
      }
      if (stat.size > MAX_FILE_BYTES) {
        const buf = await fs.readFile(abs, { encoding: 'utf8', flag: 'r' });
        return buf.slice(0, MAX_FILE_BYTES);
      }
      return fs.readFile(abs, 'utf8');
    },
    async writeFile(relPath, content) {
      const { abs, key } = await mutationTarget(root, relPath);
      const text = mutationText(content);
      await withMutationLock(key, async () => {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, text, 'utf8');
      });
      return path.relative(root, abs).replace(/\\/g, '/') || path.basename(abs);
    },
    async readFileForMutation(relPath) {
      const { abs, key } = await mutationTarget(root, relPath);
      const bytes = await withMutationLock(key, () => mutationBytes(abs));
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) {
        throw mutationError('file_encoding', 'El archivo no es texto UTF-8 válido; no se ha modificado.');
      }
      return { bytes, content };
    },
    async writeFileIfUnchanged(relPath, content, expected) {
      const { abs, key } = await mutationTarget(root, relPath);
      const text = mutationText(content);
      await withMutationLock(key, async () => {
        await assertUnchanged(abs, expected);
        await fs.writeFile(abs, text, 'utf8');
      });
      return path.relative(root, abs).replace(/\\/g, '/') || path.basename(abs);
    },
    async createFile(relPath, content) {
      const { abs, key } = await mutationTarget(root, relPath);
      const text = mutationText(content);
      await withMutationLock(key, () => createExclusive(abs, text));
      return path.relative(root, abs).replace(/\\/g, '/') || path.basename(abs);
    },
    async moveFileIfUnchanged(relPath, destination, content, expected) {
      const { abs: source, key: sourceKey } = await mutationTarget(root, relPath);
      const { abs: target, key: targetKey } = await mutationTarget(root, destination);
      const text = mutationText(content);
      await withMutationLocks([sourceKey, targetKey], async () => {
        await assertUnchanged(source, expected);
        if (source === target) {
          await fs.writeFile(source, text, 'utf8');
          return;
        }
        // Do not touch the source unless the destination was created exclusively.
        await createExclusive(target, text);
        try {
          await fs.unlink(source);
        } catch {
          // No destructive rollback: another process may have changed either
          // path. Keep the result and expose partial completion for recovery.
          const error = mutationError('move_incomplete', 'Se creó el destino pero no se pudo eliminar el origen. Revisa ambos archivos antes de continuar.');
          error.operations = [`create ${path.relative(root, target).replace(/\\/g, '/')}`];
          throw error;
        }
      });
      return path.relative(root, target).replace(/\\/g, '/') || path.basename(target);
    },
    async listFiles(relDir = '.', { maxFiles = 80, depth = 6 } = {}) {
      const files = [];
      async function walk(dir, level) {
        if (level > depth || files.length >= maxFiles) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (files.length >= maxFiles) break;
          if (!entry.name || entry.name.startsWith('.')) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) await walk(abs, level + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            const content = await fs.readFile(abs, 'utf8');
            files.push({
              path: path.relative(root, abs).replace(/\\/g, '/'),
              content: content.slice(0, 200_000),
            });
          } catch {
            /* binary / unreadable */
          }
        }
      }
      await walk(await jailRealPath(root, relDir), 0);
      return files;
    },
    async listDir(relDir = '.', { maxEntries = 200 } = {}) {
      const abs = await jailRealPath(root, relDir);
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        const err = new Error('no es un directorio');
        err.code = 'not_a_directory';
        throw err;
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        if (out.length >= maxEntries) break;
        if (!entry.name || entry.name.startsWith('.')) continue;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        const child = path.join(abs, entry.name);
        let size = 0;
        let isDir = entry.isDirectory();
        try {
          const st = await fs.stat(child);
          size = st.isDirectory() ? 0 : st.size;
          isDir = st.isDirectory();
        } catch {
          continue;
        }
        out.push({
          path: path.relative(root, child).replace(/\\/g, '/') || entry.name,
          name: entry.name,
          isDir,
          size,
        });
      }
      out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      return out;
    },
    async removeFile(relPath) {
      const { abs, key } = await mutationTarget(root, relPath);
      await withMutationLock(key, async () => {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) throw mutationError('not_a_file', 'no es un archivo');
        await fs.unlink(abs);
      });
      return path.relative(root, abs).replace(/\\/g, '/') || path.basename(abs);
    },
    async destroy() {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function stripEnv() {
  try {
    return buildUntrustedChildEnv({
      HOME: '/tmp',
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    });
  } catch {
    return {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    };
  }
}

function execInWorkspace(root, command, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, allowNetwork = false } = {}) {
  const cwd = path.resolve(root);
  if (!fsSync.existsSync(cwd)) {
    return Promise.resolve({
      stdout: '',
      stderr: 'falta el workspace',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      truncated: false,
    });
  }
  const env = {
    ...stripEnv(),
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    all_proxy: '',
    no_proxy: '*',
    NO_PROXY: '*',
  };
  if (!allowNetwork) {
    env.SIRAGPT_SHELL_NET = 'off';
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', String(command || '')], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const push = (target, chunk) => {
      const next = Buffer.concat([target, chunk]);
      if (next.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return next.subarray(0, MAX_OUTPUT_BYTES);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = push(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = push(stderr, chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: err.message || 'error al lanzar el comando',
        exitCode: 1,
        timedOut,
        aborted,
        truncated,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        exitCode: Number.isFinite(code) ? code : 1,
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}

module.exports = {
  SKIP_DIRS,
  MAX_FILE_BYTES,
  MAX_OUTPUT_BYTES,
  workspaceRootFor,
  jailPath,
  jailRealPath,
  isInsideRoot,
  createWorkspace,
  execInWorkspace,
};
