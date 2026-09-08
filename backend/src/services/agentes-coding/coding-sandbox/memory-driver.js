'use strict';

/**
 * In-memory DEV / test driver. Same session interface as docker-local,
 * no daemon. Files live in a Map jailed to /workspace.
 */

const { fail } = require('./errors');
const { jailRelPath } = require('./path-jail');

function createMemoryDriver() {
  return {
    kind: 'memory',

    async createSession(session) {
      session.files = new Map();
      session.containerName = null;
      return session;
    },

    async exec(session, command, opts = {}) {
      const cmd = String(command || '').trim();
      if (!cmd) fail('E_PARAMS', 'Falta el comando.');
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : session.limits.timeoutMs;
      if (opts.signal && opts.signal.aborted) fail('E_CANCELLED');
      // Memory driver does not spawn a shell. Tests inject `execImpl` on the
      // session when they need stdout. Default is an honest no-op.
      if (typeof session.execImpl === 'function') {
        const started = Date.now();
        let timer;
        try {
          const out = await Promise.race([
            session.execImpl(cmd, { timeoutMs, cwd: opts.cwd || '/workspace' }),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' }));
              }, timeoutMs);
            }),
          ]);
          if (opts.signal && opts.signal.aborted) fail('E_CANCELLED');
          return {
            ok: (out.exitCode ?? 0) === 0,
            exitCode: out.exitCode ?? 0,
            stdout: String(out.stdout || ''),
            stderr: String(out.stderr || ''),
            timedOut: false,
            durationMs: Date.now() - started,
          };
        } catch (err) {
          if (err && err.code === 'E_TIMEOUT') {
            return {
              ok: false,
              exitCode: 124,
              stdout: '',
              stderr: 'El comando superó el tiempo máximo del sandbox.',
              timedOut: true,
              durationMs: Date.now() - started,
            };
          }
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: '',
        stderr: 'memory-driver: exec no lanza un shell; usa el driver docker en DEV.',
        timedOut: false,
        durationMs: 0,
      };
    },

    async readFile(session, relPath) {
      const rel = jailRelPath(relPath);
      if (!session.files.has(rel)) fail('E_PARAMS', `No existe ${rel}.`);
      return session.files.get(rel);
    },

    async writeFile(session, relPath, content) {
      const rel = jailRelPath(relPath);
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      if (buf.length > session.limits.maxFileBytes) fail('E_QUOTA', 'El archivo supera el tope.');
      session.files.set(rel, buf);
      return { path: rel, bytes: buf.length };
    },

    async listFiles(session, relDir = '.') {
      const prefix = jailRelPath(relDir, { forList: true });
      const out = [];
      for (const [p, buf] of session.files) {
        if (prefix === '.' || p === prefix || p.startsWith(`${prefix}/`)) {
          out.push({ path: p, size: buf.length });
        }
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    },

    async destroy(session) {
      session.files = new Map();
    },
  };
}

module.exports = { createMemoryDriver };
