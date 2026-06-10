'use strict';

/**
 * Document-agent sandbox — one ISOLATED, EPHEMERAL workspace per task.
 *
 * Two drivers behind one interface:
 *
 *  - docker  (production / VPS): ephemeral container from the image built at
 *    infra/sandbox/Dockerfile, hard limits (--cpus 1, --memory 1g,
 *    --network none, --pids-limit 256, auto-removed). Files move in/out with
 *    `docker cp`; every command runs via `docker exec` with its own timeout.
 *    Driven through the docker CLI (spawn) so no new npm dependency is
 *    required — swap in dockerode behind the same interface if preferred.
 *
 *  - local   (dev / CI fallback): a mkdtemp workspace + bash subprocess per
 *    command with cwd locked to the workspace, a scrubbed environment, output
 *    caps and a kill-on-timeout. Used automatically when Docker is not
 *    available (this repo's dev machine has no Docker; CI runners and the
 *    VPS do). NOT a security boundary equal to the container — it is the
 *    functional fallback that keeps the feature testable everywhere.
 *
 * Interface (driver-agnostic):
 *   createSandbox({ driver })            → Promise<Sandbox>
 *   sandbox.exec(cmd, { timeoutMs })     → { stdout, stderr, exitCode, timedOut }
 *   sandbox.putFile(relPath, buffer)     → absolute-in-sandbox path
 *   sandbox.readFile(relPath)            → Buffer
 *   sandbox.writeFile(relPath, content)  → void
 *   sandbox.listFiles(relDir)            → [{ path, size }]
 *   sandbox.collectOutputs()             → [{ name, buffer }]   (from outputs/)
 *   sandbox.destroy()                    → void (idempotent)
 *
 * Paths given to the tool layer are ALWAYS expressed relative to /workspace
 * (the literal prefix "/workspace/" is accepted and stripped); resolution is
 * confined to the workspace root — traversal escapes are rejected.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CMD_TIMEOUT_MS = clampInt(process.env.SIRAGPT_DOC_SANDBOX_CMD_TIMEOUT_MS, 120_000, 1_000, 600_000);
const MAX_OUTPUT_BYTES = clampInt(process.env.SIRAGPT_DOC_SANDBOX_MAX_OUTPUT_BYTES, 256 * 1024, 4 * 1024, 4 * 1024 * 1024);
const DOCKER_IMAGE = process.env.SIRAGPT_DOC_SANDBOX_IMAGE || 'siragpt-doc-sandbox:latest';

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Resolve a tool-supplied path safely inside the workspace root. */
function resolveInWorkspace(root, relPath) {
  let p = String(relPath == null ? '' : relPath).trim();
  if (!p) throw new Error('empty path');
  if (p === '/workspace') p = '.';
  else if (p.startsWith('/workspace/')) p = p.slice('/workspace/'.length);
  if (path.isAbsolute(p)) throw new Error(`absolute paths are not allowed: ${relPath}`);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${relPath}`);
  }
  return abs;
}

function truncateOutput(buf) {
  const s = buf.toString('utf8');
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return `${s.slice(0, MAX_OUTPUT_BYTES)}\n…[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

function runProcess(cmd, args, { timeoutMs = CMD_TIMEOUT_MS, cwd, env, input } = {}) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so a timeout kill takes the whole tree with it.
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (_) { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT_BYTES * 2) stdout = Buffer.concat([stdout, d]); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT_BYTES * 2) stderr = Buffer.concat([stderr, d]); });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: truncateOutput(stdout), stderr: truncateOutput(stderr), exitCode, timedOut });
    };
    child.on('error', (err) => {
      stderr = Buffer.concat([stderr, Buffer.from(String(err.message || err))]);
      finish(127);
    });
    child.on('close', (code, signal) => finish(timedOut ? 124 : (code == null && signal ? 137 : (code ?? 0))));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/* ── local driver ───────────────────────────────────────────────────────── */

async function createLocalSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-doc-sandbox-'));
  await fs.mkdir(path.join(root, 'uploads'), { recursive: true });
  await fs.mkdir(path.join(root, 'outputs'), { recursive: true });
  let destroyed = false;

  const scrubbedEnv = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    LANG: process.env.LANG || 'en_US.UTF-8',
    // Deliberately NO API keys / secrets from the parent environment.
  };

  return {
    driver: 'local',
    root,
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('sandbox destroyed');
      const timeoutMs = clampInt(opts.timeoutMs, CMD_TIMEOUT_MS, 1_000, 600_000);
      // /workspace is a convenience alias in prompts; map it for local runs.
      const mapped = String(command).split('/workspace').join(root);
      return runProcess('bash', ['-c', mapped], { timeoutMs, cwd: root, env: scrubbedEnv });
    },
    async putFile(relPath, buffer) {
      const abs = resolveInWorkspace(root, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buffer);
      return abs;
    },
    async readFile(relPath) {
      return fs.readFile(resolveInWorkspace(root, relPath));
    },
    async writeFile(relPath, content) {
      const abs = resolveInWorkspace(root, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    async listFiles(relDir = '.') {
      const base = resolveInWorkspace(root, relDir);
      const out = [];
      const walk = async (dir) => {
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) await walk(abs);
          else {
            let size = 0;
            try { size = (await fs.stat(abs)).size; } catch { /* raced */ }
            out.push({ path: path.relative(root, abs), size });
          }
        }
      };
      await walk(base);
      return out;
    },
    async collectOutputs() {
      const dir = path.join(root, 'outputs');
      const outputs = [];
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return outputs; }
      for (const e of entries) {
        if (!e.isFile()) continue;
        outputs.push({ name: e.name, buffer: await fs.readFile(path.join(dir, e.name)) });
      }
      return outputs;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      try { fsSync.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    },
  };
}

/* ── docker driver (CLI-based; ephemeral container per task) ─────────────── */

async function dockerAvailable() {
  const r = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5_000, env: process.env });
  return r.exitCode === 0;
}

async function createDockerSandbox() {
  const name = `sira-doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run = await runProcess('docker', [
    'run', '-d', '--rm',
    '--name', name,
    '--network', 'none',
    '--memory', '1g',
    '--cpus', '1',
    '--pids-limit', '256',
    '--read-only=false',
    DOCKER_IMAGE,
    'sleep', 'infinity',
  ], { timeoutMs: 30_000, env: process.env });
  if (run.exitCode !== 0) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  let destroyed = false;
  // Staging dir for docker cp round-trips.
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-doc-stage-'));

  const dexec = (args, opts = {}) => runProcess('docker', args, { ...opts, env: process.env });

  return {
    driver: 'docker',
    root: '/workspace',
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('sandbox destroyed');
      const timeoutMs = clampInt(opts.timeoutMs, CMD_TIMEOUT_MS, 1_000, 600_000);
      return dexec(['exec', '-w', '/workspace', name, 'bash', '-c', String(command)], { timeoutMs });
    },
    async putFile(relPath, buffer) {
      const safeRel = path.posix.normalize(String(relPath).replace(/^\/workspace\/?/, '')).replace(/^(\.\.\/?)+/, '');
      const local = path.join(stage, `put-${Date.now()}-${path.basename(safeRel)}`);
      await fs.writeFile(local, buffer);
      await dexec(['exec', name, 'mkdir', '-p', path.posix.join('/workspace', path.posix.dirname(safeRel))], { timeoutMs: 10_000 });
      const cp = await dexec(['cp', local, `${name}:${path.posix.join('/workspace', safeRel)}`], { timeoutMs: 30_000 });
      await fs.rm(local, { force: true });
      if (cp.exitCode !== 0) throw new Error(`docker cp in failed: ${cp.stderr}`);
      return path.posix.join('/workspace', safeRel);
    },
    async readFile(relPath) {
      const safeRel = path.posix.normalize(String(relPath).replace(/^\/workspace\/?/, '')).replace(/^(\.\.\/?)+/, '');
      const local = path.join(stage, `get-${Date.now()}-${path.basename(safeRel)}`);
      const cp = await dexec(['cp', `${name}:${path.posix.join('/workspace', safeRel)}`, local], { timeoutMs: 30_000 });
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
      const outputs = [];
      for (const n of names) {
        try { outputs.push({ name: n, buffer: await this.readFile(`outputs/${n}`) }); } catch (_) { /* skip unreadable */ }
      }
      return outputs;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await dexec(['rm', '-f', name], { timeoutMs: 15_000 }).catch(() => {});
      try { fsSync.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    },
  };
}

/* ── factory ─────────────────────────────────────────────────────────────── */

/**
 * @param {{ driver?: 'auto'|'local'|'docker' }} [opts]
 */
async function createSandbox(opts = {}) {
  const requested = String(opts.driver || process.env.SIRAGPT_DOC_SANDBOX_DRIVER || 'auto').toLowerCase();
  if (requested === 'local') return createLocalSandbox();
  if (requested === 'docker') return createDockerSandbox();
  // auto: prefer the real container when a Docker daemon is reachable.
  if (await dockerAvailable()) {
    try { return await createDockerSandbox(); } catch (_) { /* image missing etc. → local */ }
  }
  return createLocalSandbox();
}

module.exports = {
  createSandbox,
  resolveInWorkspace, // exported for unit tests
  CMD_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  DOCKER_IMAGE,
};
