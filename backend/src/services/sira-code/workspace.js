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

function workspaceRootFor(sessionId) {
  const safe = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'session';
  return path.join(os.tmpdir(), 'sira-code', safe);
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
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    const err = new Error('ruta fuera del workspace');
    err.code = 'path_traversal';
    throw err;
  }
  return resolved;
}

async function createWorkspace(sessionId) {
  const root = workspaceRootFor(sessionId);
  await fs.mkdir(root, { recursive: true });
  return {
    root,
    resolve(relPath) {
      return jailPath(root, relPath);
    },
    async readFile(relPath) {
      const abs = jailPath(root, relPath);
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
      const abs = jailPath(root, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const text = String(content == null ? '' : content);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
        const err = new Error('archivo demasiado grande');
        err.code = 'file_too_large';
        throw err;
      }
      await fs.writeFile(abs, text, 'utf8');
      return path.relative(root, abs).replace(/\\/g, '/') || path.basename(abs);
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
      await walk(jailPath(root, relDir), 0);
      return files;
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

function execInWorkspace(root, command, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const cwd = path.resolve(root);
  if (!fsSync.existsSync(cwd)) {
    return Promise.resolve({
      stdout: '',
      stderr: 'workspace missing',
      exitCode: 1,
      timedOut: false,
      aborted: false,
    });
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', String(command || '')], {
      cwd,
      env: stripEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
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
      return next.length > MAX_OUTPUT_BYTES ? next.subarray(0, MAX_OUTPUT_BYTES) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = push(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = push(stderr, chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: err.message || 'spawn error',
        exitCode: 1,
        timedOut,
        aborted,
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
      });
    });
  });
}

module.exports = {
  SKIP_DIRS,
  MAX_FILE_BYTES,
  workspaceRootFor,
  jailPath,
  createWorkspace,
  execInWorkspace,
};
