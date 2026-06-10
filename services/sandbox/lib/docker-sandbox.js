'use strict';

/**
 * Docker sandbox runner (standalone microservice copy).
 *
 * One EPHEMERAL, HARD-LIMITED container per session — the "muscle" the main
 * SiraGPT app drives over HTTPS for document tasks. Self-contained on purpose:
 * this service is deployed on its own host (the Lenovo) and must not depend on
 * the backend tree. Driven through the `docker` CLI (spawn) so no native
 * dependency is required.
 *
 * Per-container limits (every session): --network none, --memory 1g, --cpus 1,
 * --pids-limit 100, non-root, auto-removed. Each command runs via `docker
 * exec` with its own timeout. Files move in/out with `docker cp`. Paths from
 * the caller are confined to /workspace.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IMAGE = process.env.SANDBOX_RUNNER_IMAGE || 'siragpt-doc-sandbox:latest';
const CMD_TIMEOUT_MS = clampInt(process.env.SANDBOX_CMD_TIMEOUT_MS, 120_000, 1_000, 600_000);
const MAX_OUTPUT_BYTES = clampInt(process.env.SANDBOX_MAX_OUTPUT_BYTES, 256 * 1024, 4 * 1024, 4 * 1024 * 1024);
const MEMORY = process.env.SANDBOX_MEMORY || '1g';
const CPUS = process.env.SANDBOX_CPUS || '1';
const PIDS = clampInt(process.env.SANDBOX_PIDS_LIMIT, 100, 16, 1024);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function safeRel(relPath) {
  let p = String(relPath == null ? '' : relPath).trim();
  if (!p) throw new Error('empty path');
  if (p === '/workspace') p = '.';
  else if (p.startsWith('/workspace/')) p = p.slice('/workspace/'.length);
  if (path.posix.isAbsolute(p)) throw new Error(`absolute paths are not allowed: ${relPath}`);
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../')) throw new Error(`path escapes the workspace: ${relPath}`);
  return norm;
}

function runProcess(cmd, args, { timeoutMs = CMD_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT_BYTES * 2) stdout = Buffer.concat([stdout, d]); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT_BYTES * 2) stderr = Buffer.concat([stderr, d]); });
    const finish = (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const trunc = (b) => { const s = b.toString('utf8'); return s.length <= MAX_OUTPUT_BYTES ? s : `${s.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]`; };
      resolve({ stdout: trunc(stdout), stderr: trunc(stderr), exitCode, timedOut });
    };
    child.on('error', (err) => { stderr = Buffer.concat([stderr, Buffer.from(String(err.message || err))]); finish(127); });
    child.on('close', (code, signal) => finish(timedOut ? 124 : (code == null && signal ? 137 : (code ?? 0))));
  });
}

async function dockerAvailable() {
  const r = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5_000 });
  return r.exitCode === 0;
}

/** Create one ephemeral container session. */
async function createDockerSession() {
  const name = `sira-doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run = await runProcess('docker', [
    'run', '-d', '--rm',
    '--name', name,
    '--network', 'none',
    '--memory', MEMORY,
    '--cpus', CPUS,
    '--pids-limit', String(PIDS),
    '--security-opt', 'no-new-privileges',
    IMAGE, 'sleep', 'infinity',
  ], { timeoutMs: 30_000 });
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-stage-'));
  let destroyed = false;
  const dexec = (args, opts) => runProcess('docker', args, opts);

  return {
    name,
    createdAt: Date.now(),
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('session destroyed');
      const timeoutMs = clampInt(opts.timeoutMs, CMD_TIMEOUT_MS, 1_000, 600_000);
      return dexec(['exec', '-w', '/workspace', name, 'bash', '-c', String(command)], { timeoutMs });
    },
    async putFile(relPath, buffer) {
      const rel = safeRel(relPath);
      const local = path.join(stage, `put-${Date.now()}-${path.basename(rel)}`);
      await fs.writeFile(local, buffer);
      await dexec(['exec', name, 'mkdir', '-p', path.posix.join('/workspace', path.posix.dirname(rel))], { timeoutMs: 10_000 });
      const cp = await dexec(['cp', local, `${name}:${path.posix.join('/workspace', rel)}`], { timeoutMs: 60_000 });
      await fs.rm(local, { force: true });
      if (cp.exitCode !== 0) throw new Error(`docker cp in failed: ${cp.stderr}`);
      return path.posix.join('/workspace', rel);
    },
    async readFile(relPath) {
      const rel = safeRel(relPath);
      const local = path.join(stage, `get-${Date.now()}-${path.basename(rel)}`);
      const cp = await dexec(['cp', `${name}:${path.posix.join('/workspace', rel)}`, local], { timeoutMs: 60_000 });
      if (cp.exitCode !== 0) throw new Error(`docker cp out failed: ${cp.stderr}`);
      const buf = await fs.readFile(local);
      await fs.rm(local, { force: true });
      return buf;
    },
    async writeFile(relPath, content) {
      await this.putFile(relPath, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    },
    async listFiles(relDir = '.') {
      const r = await this.exec(`cd /workspace && find ${JSON.stringify(relDir)} -type f -printf '%s %p\\n' 2>/dev/null | head -500`);
      return String(r.stdout || '').split('\n').filter(Boolean).map((line) => {
        const i = line.indexOf(' ');
        return { path: line.slice(i + 1).replace(/^\.\//, ''), size: Number(line.slice(0, i)) || 0 };
      });
    },
    async collectOutputs() {
      const listing = await this.exec("ls -1 /workspace/outputs 2>/dev/null");
      const names = String(listing.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const out = [];
      for (const n of names) { try { out.push({ name: n, buffer: await this.readFile(`outputs/${n}`) }); } catch (_) {} }
      return out;
    },
    async destroy() {
      if (destroyed) return; destroyed = true;
      await dexec(['rm', '-f', name], { timeoutMs: 15_000 }).catch(() => {});
      try { fsSync.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

module.exports = { createDockerSession, dockerAvailable, safeRel, IMAGE, CMD_TIMEOUT_MS, limits: { MEMORY, CPUS, PIDS } };
