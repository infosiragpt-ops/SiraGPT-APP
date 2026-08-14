'use strict';

/**
 * Document-agent sandbox — one ISOLATED, EPHEMERAL workspace per task.
 *
 * Two drivers behind one interface:
 *
 *  - docker  (production / VPS): ephemeral container from the image named by
 *    SIRAGPT_DOC_SANDBOX_IMAGE. F5 hardening: gVisor (`--runtime runsc`) when
 *    the daemon has it registered — REQUIRED in production or under
 *    SIRAGPT_SANDBOX_REQUIRE_GVISOR=1 (fail closed with an honest error;
 *    plain runc stays available ONLY as the explicit opt-in
 *    SIRAGPT_SANDBOX_RUNTIME=runc for CI/dev). Hard limits per container:
 *    cpus / memory (+ equal memory-swap: no swap headroom) / pids-limit /
 *    size-capped tmpfs workspace (ephemeral) / ulimits (nofile, fsize) /
 *    --cap-drop ALL / --security-opt no-new-privileges / read-only rootfs
 *    (tmpfs /tmp; HOME=/workspace) / --network none ALWAYS (no egress opt-in
 *    in F5 — allowlists arrive with F6). Docker's default seccomp profile is
 *    kept under runc; under runsc gVisor's own syscall filtering applies; a
 *    custom profile can be pinned with SIRAGPT_SANDBOX_SECCOMP_PROFILE
 *    ("unconfined" is rejected). Files move in/out through `docker exec`
 *    streams (stdin `cat >` / stdout `cat`) instead of `docker cp`, because
 *    gVisor caches directory contents and does not reliably see host-side
 *    `docker cp` writes (gvisor.dev FAQ; the kubectl-cp strategy). Every
 *    command runs via `docker exec` with its own timeout + AbortSignal.
 *    One container per task — containers are NEVER shared across users or
 *    conversations (persistent workspaces are per-conversation volumes).
 *
 *  - local   (dev / CI fallback): a mkdtemp workspace + bash subprocess per
 *    command with cwd locked to the workspace, a scrubbed environment, output
 *    caps and a kill-on-timeout. Used automatically when Docker is not
 *    available (this repo's dev machine has no Docker; CI runners and the
 *    VPS do). NOT a security boundary equal to the container — it is the
 *    functional fallback that keeps the feature testable everywhere. It
 *    never claims gVisor (driver:'local', runtime:'none', gvisor:false) and
 *    it is REFUSED whenever gVisor is mandatory (production auto-routing or
 *    SIRAGPT_SANDBOX_REQUIRE_GVISOR=1).
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
 * confined to the workspace root — traversal escapes are rejected, and the
 * local driver additionally rejects symlink escapes (realpath check).
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { throwIfAborted } = require('../../utils/abort-signals');

const CMD_TIMEOUT_MS = clampInt(process.env.SIRAGPT_DOC_SANDBOX_CMD_TIMEOUT_MS, 120_000, 1_000, 600_000);
const MAX_OUTPUT_BYTES = clampInt(process.env.SIRAGPT_DOC_SANDBOX_MAX_OUTPUT_BYTES, 256 * 1024, 4 * 1024, 4 * 1024 * 1024);
const DOCKER_IMAGE = process.env.SIRAGPT_DOC_SANDBOX_IMAGE || 'siragpt-doc-sandbox:latest';

/** Honest, typed failure for "the isolation you demanded is not available". */
class SandboxRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxRuntimeError';
    this.code = 'sandbox_runtime_unavailable';
  }
}

/** Sanitize a conversation id so it is safe as a dir / docker volume name. */
function safePersistKey(key) {
  const s = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return s || null;
}

function persistentWorkspaceRoot(persistKey) {
  const key = safePersistKey(persistKey);
  if (!key) return null;
  const base = process.env.SIRAGPT_AGENT_WORKSPACE_DIR
    || path.join(os.tmpdir(), 'sira-agent-workspaces');
  return path.join(base, key);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Accept only docker/tmpfs size literals ("512m", "1g", "1024k", "268435456"). */
function safeSize(value, fallback) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return /^\d+(\.\d+)?[bkmg]?$/.test(s) ? s : fallback;
}

/** POSIX single-quote so crafted paths can never break out of `bash -c`. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Hard per-sandbox limits, env-overridable with sane defaults. Read at call
 * time (not module load) so operators and tests can adjust without a restart.
 */
function sandboxLimitsFromEnv(env = process.env) {
  const ulimitFsizeMb = clampInt(env.SIRAGPT_SANDBOX_ULIMIT_FSIZE_MB, 256, 1, 4096);
  return {
    cpus: clampFloat(env.SIRAGPT_SANDBOX_CPUS, 1, 0.1, 16),
    memory: safeSize(env.SIRAGPT_SANDBOX_MEMORY, '1g'),
    pidsLimit: clampInt(env.SIRAGPT_SANDBOX_PIDS_LIMIT, 256, 16, 4096),
    workspaceSize: safeSize(env.SIRAGPT_SANDBOX_WORKSPACE_SIZE, '512m'),
    tmpSize: safeSize(env.SIRAGPT_SANDBOX_TMP_SIZE, '256m'),
    readOnlyRootfs: env.SIRAGPT_SANDBOX_READONLY_ROOTFS !== '0',
    ulimitNofile: clampInt(env.SIRAGPT_SANDBOX_ULIMIT_NOFILE, 1024, 64, 65536),
    ulimitFsizeMb,
    maxFileBytes: ulimitFsizeMb * 1024 * 1024,
    // Optional pinned seccomp profile path. "unconfined" is NEVER accepted:
    // silently weakening the syscall filter is exactly what F5 forbids.
    seccompProfile: (() => {
      const p = String(env.SIRAGPT_SANDBOX_SECCOMP_PROFILE || '').trim();
      if (!p || p.toLowerCase() === 'unconfined') return null;
      return p;
    })(),
  };
}

/**
 * Pick the container runtime honestly.
 *  - SIRAGPT_SANDBOX_RUNTIME=auto|runsc|runc (default auto)
 *  - SIRAGPT_SANDBOX_REQUIRE_GVISOR=1 → runsc or an honest failure, ALWAYS
 *    (even an explicit runc opt-in is refused).
 *  - NODE_ENV=production → runsc required unless SIRAGPT_SANDBOX_RUNTIME=runc
 *    was set explicitly (the documented CI/dev escape hatch).
 *  - dev/CI with runsc missing → runc with `fallback: true` (never claimed
 *    as gVisor anywhere).
 */
function resolveSandboxRuntime({ env = process.env, availableRuntimes = [] } = {}) {
  const requested = String(env.SIRAGPT_SANDBOX_RUNTIME || 'auto').toLowerCase();
  const requireGvisor = String(env.SIRAGPT_SANDBOX_REQUIRE_GVISOR || '') === '1';
  const production = String(env.NODE_ENV || '') === 'production';
  const hasRunsc = availableRuntimes.includes('runsc');
  const installHint = 'Instala gVisor y registra el runtime "runsc" en /etc/docker/daemon.json '
    + '(https://gvisor.dev/docs/user_guide/install/), o exporta SIRAGPT_SANDBOX_RUNTIME=runc '
    + 'para optar EXPLÍCITAMENTE por el aislamiento runc (solo CI/dev).';

  if (!['auto', 'runsc', 'runc'].includes(requested)) {
    throw new SandboxRuntimeError(
      `SIRAGPT_SANDBOX_RUNTIME inválido: "${requested}" (valores permitidos: auto | runsc | runc).`,
    );
  }
  if (requested === 'runc') {
    if (requireGvisor) {
      throw new SandboxRuntimeError(
        'SIRAGPT_SANDBOX_REQUIRE_GVISOR=1 exige el runtime gVisor (runsc): el opt-in '
        + 'SIRAGPT_SANDBOX_RUNTIME=runc queda deshabilitado. ' + installHint,
      );
    }
    return { runtime: 'runc', gvisor: false, fallback: false };
  }
  if (hasRunsc) return { runtime: 'runsc', gvisor: true, fallback: false };
  if (requested === 'runsc' || requireGvisor || production) {
    throw new SandboxRuntimeError(
      'El sandbox endurecido exige gVisor y el daemon Docker no tiene el runtime "runsc" '
      + `registrado (runtimes disponibles: ${availableRuntimes.join(', ') || 'ninguno'}). `
      + 'No se degrada en silencio a runc. ' + installHint,
    );
  }
  return { runtime: 'runc', gvisor: false, fallback: true };
}

/**
 * Build the full `docker run` argv for one sandbox container. Pure — exported
 * so tests can verify every isolation flag without a Docker daemon.
 * `--network none` is NOT configurable: F5 ships no egress opt-in (F6 adds
 * allowlisted egress later).
 */
function buildDockerRunArgs({
  name,
  image = DOCKER_IMAGE,
  runtime = 'runc',
  persistKey = null,
  limits = sandboxLimitsFromEnv(),
} = {}) {
  const key = safePersistKey(persistKey);
  const args = [
    'run', '-d', '--rm',
    '--name', name,
    '--runtime', runtime,
    '--network', 'none',
    '--memory', limits.memory,
    '--memory-swap', limits.memory,
    '--cpus', String(limits.cpus),
    '--pids-limit', String(limits.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--ulimit', `nofile=${limits.ulimitNofile}:${limits.ulimitNofile}`,
    '--ulimit', `fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`,
    '-e', 'HOME=/workspace',
    '-e', 'TMPDIR=/tmp',
    '--tmpfs', `/tmp:rw,exec,size=${limits.tmpSize}`,
  ];
  if (limits.readOnlyRootfs) args.push('--read-only');
  if (limits.seccompProfile) args.push('--security-opt', `seccomp=${limits.seccompProfile}`);
  if (key) {
    // Persistent per-conversation volume (one volume per conversation — never
    // shared across users). Size-capping a named volume needs storage-driver
    // support, so the fsize ulimit is the per-file cap here.
    args.push('-v', `sira-ws-${key}:/workspace`);
  } else {
    args.push('--tmpfs', `/workspace:rw,exec,size=${limits.workspaceSize}`);
  }
  args.push(image, 'sleep', 'infinity');
  return args;
}

function truncateOutput(buf) {
  const s = buf.toString('utf8');
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return `${s.slice(0, MAX_OUTPUT_BYTES)}\n…[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

function runProcess(cmd, args, {
  timeoutMs = CMD_TIMEOUT_MS, cwd, env, input, signal, binary = false, maxOutputBytes,
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({ stdout: '', stderr: 'operation aborted', exitCode: 130, timedOut: false, aborted: true });
  }
  const stdoutCap = binary
    ? clampInt(maxOutputBytes, MAX_OUTPUT_BYTES * 2, 1, 4 * 1024 * 1024 * 1024)
    : MAX_OUTPUT_BYTES * 2;
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let overflowed = false;
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so a timeout kill takes the whole tree with it.
      detached: process.platform !== 'win32',
    });
    const killTree = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (_) { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // Close the tiny race between the pre-spawn check and listener install.
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (d) => {
      if (stdout.length < stdoutCap) stdout = Buffer.concat([stdout, d]);
      else overflowed = true;
    });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT_BYTES * 2) stderr = Buffer.concat([stderr, d]); });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        stdout: binary ? '' : truncateOutput(stdout),
        stdoutBuffer: binary ? stdout : undefined,
        stderr: truncateOutput(stderr),
        exitCode,
        timedOut,
        aborted,
        overflowed,
      });
    };
    child.on('error', (err) => {
      stderr = Buffer.concat([stderr, Buffer.from(String(err.message || err))]);
      finish(127);
    });
    child.on('close', (code, closeSignal) => finish(aborted ? 130 : (timedOut ? 124 : (code == null && closeSignal ? 137 : (code ?? 0)))));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Resolve a tool-supplied path safely inside the workspace root (lexical). */
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

/**
 * Symlink hardening for the local driver: the lexical check above cannot see
 * a symlink INSIDE the workspace that points OUTSIDE it. Follow the deepest
 * existing ancestor of the target through realpath and demand it still lives
 * under the workspace root.
 */
async function assertRealpathInWorkspace(root, abs, relPath) {
  const rootReal = await fs.realpath(root).catch(() => root);
  let probe = abs;
  for (;;) {
    try {
      await fs.lstat(probe);
      break;
    } catch (_) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const real = await fs.realpath(probe).catch(() => probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`path escapes the workspace (symlink): ${relPath}`);
  }
  return abs;
}

/** Confine a docker-driver path under /workspace (posix, no traversal). */
function safeContainerRel(relPath) {
  let p = String(relPath == null ? '.' : relPath).trim() || '.';
  p = p.replace(/^\/workspace\/?/, '');
  p = path.posix.normalize(p);
  p = p.replace(/^(\.\.(\/|$))+/, '').replace(/^\/+/, '');
  if (!p || p === '..') p = '.';
  return p;
}

/* ── local driver ───────────────────────────────────────────────────────── */

async function createLocalSandbox({ signal, persistKey } = {}) {
  throwIfAborted(signal);
  const key = safePersistKey(persistKey);
  const persistentRoot = key ? persistentWorkspaceRoot(key) : null;
  const root = persistentRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'sira-doc-sandbox-'));
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

  const resolveReal = async (relPath) => assertRealpathInWorkspace(root, resolveInWorkspace(root, relPath), relPath);

  return {
    driver: 'local',
    runtime: 'none',
    gvisor: false,
    persistent: Boolean(key),
    persistKey: key,
    root,
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('sandbox destroyed');
      throwIfAborted(opts.signal || signal);
      const timeoutMs = clampInt(opts.timeoutMs, CMD_TIMEOUT_MS, 1_000, 600_000);
      // /workspace is a convenience alias in prompts; map it for local runs.
      const mapped = String(command).split('/workspace').join(root);
      return runProcess('bash', ['-c', mapped], { timeoutMs, cwd: root, env: scrubbedEnv, signal: opts.signal || signal });
    },
    async putFile(relPath, buffer) {
      throwIfAborted(signal);
      const abs = await resolveReal(relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buffer);
      return abs;
    },
    async readFile(relPath) {
      throwIfAborted(signal);
      return fs.readFile(await resolveReal(relPath));
    },
    async writeFile(relPath, content) {
      throwIfAborted(signal);
      const abs = await resolveReal(relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    async listFiles(relDir = '.') {
      const base = await resolveReal(relDir);
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
      // Persistent workspaces survive the task so follow-ups reopen the
      // last files. Ephemeral ones are wiped.
      if (key) return;
      try { fsSync.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    },
  };
}

/* ── docker driver (CLI-based; ephemeral container per task) ─────────────── */

async function dockerAvailable(signal) {
  const r = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5_000, env: process.env, signal });
  return r.exitCode === 0;
}

const RUNTIME_PROBE_TTL_MS = 60_000;
let runtimeProbeCache = { at: 0, runtimes: null };

/** Ask the Docker daemon which OCI runtimes it has registered (60s cache). */
async function listDockerRuntimes({ signal, force = false } = {}) {
  const now = Date.now();
  if (!force && runtimeProbeCache.runtimes && (now - runtimeProbeCache.at) < RUNTIME_PROBE_TTL_MS) {
    return runtimeProbeCache.runtimes;
  }
  const r = await runProcess('docker', ['info', '--format', '{{json .Runtimes}}'], { timeoutMs: 5_000, env: process.env, signal });
  let runtimes = [];
  if (r.exitCode === 0) {
    try { runtimes = Object.keys(JSON.parse(String(r.stdout).trim() || '{}')); } catch (_) { runtimes = []; }
  }
  runtimeProbeCache = { at: now, runtimes };
  return runtimes;
}

function resetRuntimeProbeCache() {
  runtimeProbeCache = { at: 0, runtimes: null };
}

async function createDockerSandbox({
  signal,
  processRunner = runProcess,
  persistKey,
  availableRuntimes,
  env = process.env,
} = {}) {
  throwIfAborted(signal);
  const key = safePersistKey(persistKey);
  // Runtime resolution FIRST: when the isolation demanded is not available
  // this throws before any container exists (fail closed, honest error).
  const runtimes = Array.isArray(availableRuntimes)
    ? availableRuntimes
    : await listDockerRuntimes({ signal });
  const resolved = resolveSandboxRuntime({ env, availableRuntimes: runtimes });
  const limits = sandboxLimitsFromEnv(env);
  const name = `sira-doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dockerArgs = buildDockerRunArgs({
    name,
    image: env.SIRAGPT_DOC_SANDBOX_IMAGE || DOCKER_IMAGE,
    runtime: resolved.runtime,
    persistKey: key,
    limits,
  });
  const run = await processRunner('docker', dockerArgs, { timeoutMs: 30_000, env: process.env, signal });
  if (run.exitCode !== 0) {
    // docker run may have reached the daemon before its CLI was cancelled.
    // Removing by the preselected name is harmless when no container exists
    // and prevents an aborted creation from leaking a live sandbox.
    await processRunner('docker', ['rm', '-f', name], {
      timeoutMs: 15_000,
      env: process.env,
      signal: undefined,
    }).catch(() => {});
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  let destroyed = false;

  const dexec = (args, opts = {}) => {
    const { ignoreParentAbort = false, ...runOpts } = opts;
    return processRunner('docker', args, {
      ...runOpts,
      env: process.env,
      signal: ignoreParentAbort ? undefined : (opts.signal || signal),
    });
  };

  return {
    driver: 'docker',
    runtime: resolved.runtime,
    gvisor: resolved.gvisor,
    runtimeFallback: resolved.fallback,
    limits,
    persistent: Boolean(key),
    persistKey: key,
    root: '/workspace',
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('sandbox destroyed');
      const timeoutMs = clampInt(opts.timeoutMs, CMD_TIMEOUT_MS, 1_000, 600_000);
      // Forward the per-call signal (F3 cancel): killing the docker-exec CLI
      // detaches the stream immediately; the in-container process is reaped
      // by destroy() (`docker rm -f`), which the runner always runs.
      return dexec(['exec', '-w', '/workspace', name, 'bash', '-c', String(command)], { timeoutMs, signal: opts.signal });
    },
    // File transfer goes through `docker exec` streams — NOT `docker cp` —
    // so it stays correct under gVisor (runsc caches directory listings and
    // may never see host-side docker-cp writes; exec keeps its cache
    // coherent, the same reason `kubectl cp` works) and works with the
    // internal tmpfs workspace, which does not exist host-side at all.
    async putFile(relPath, buffer) {
      if (destroyed) throw new Error('sandbox destroyed');
      const safeRel = safeContainerRel(relPath);
      const dest = path.posix.join('/workspace', safeRel);
      const dir = path.posix.dirname(dest);
      const r = await dexec(
        ['exec', '-i', name, 'sh', '-c', `mkdir -p ${shQuote(dir)} && cat > ${shQuote(dest)}`],
        { timeoutMs: 60_000, input: buffer },
      );
      if (r.exitCode !== 0) throw new Error(`sandbox putFile failed: ${r.stderr || r.stdout}`);
      return dest;
    },
    async readFile(relPath) {
      if (destroyed) throw new Error('sandbox destroyed');
      const safeRel = safeContainerRel(relPath);
      const src = path.posix.join('/workspace', safeRel);
      const r = await dexec(['exec', name, 'cat', src], {
        timeoutMs: 60_000,
        binary: true,
        maxOutputBytes: limits.maxFileBytes,
      });
      if (r.exitCode !== 0) throw new Error(`sandbox readFile failed: ${r.stderr}`);
      if (r.overflowed) throw new Error(`sandbox readFile: ${safeRel} exceeds ${limits.maxFileBytes} bytes`);
      return r.stdoutBuffer ?? Buffer.alloc(0);
    },
    async writeFile(relPath, content) {
      await this.putFile(relPath, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    },
    async listFiles(relDir = '.') {
      const safeRel = safeContainerRel(relDir);
      const r = await this.exec(`cd /workspace && find ${shQuote(safeRel)} -type f -printf '%s %p\\n' 2>/dev/null | head -500`);
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
      await dexec(['rm', '-f', name], { timeoutMs: 15_000, ignoreParentAbort: true }).catch(() => {});
    },
  };
}

/* ── factory ─────────────────────────────────────────────────────────────── */

/**
 * @param {{ driver?: 'auto'|'local'|'docker'|'remote' }} [opts]
 */
async function createSandbox(opts = {}) {
  const env = opts.env || process.env;
  const requested = String(opts.driver || env.SIRAGPT_DOC_SANDBOX_DRIVER || 'auto').toLowerCase();
  const requireGvisor = String(env.SIRAGPT_SANDBOX_REQUIRE_GVISOR || '') === '1';
  const production = String(env.NODE_ENV || '') === 'production';
  const hasRemote = Boolean(process.env.SANDBOX_SERVICE_URL && process.env.SANDBOX_API_KEY);
  const persistKey = opts.persistKey || opts.workspaceKey || null;
  if (requested === 'remote') {
    return require('./remote-sandbox').createRemoteSandbox({
      signal: opts.signal,
      workspaceKey: persistKey,
    });
  }
  if (requested === 'local') {
    if (requireGvisor) {
      throw new SandboxRuntimeError(
        'SIRAGPT_SANDBOX_REQUIRE_GVISOR=1 exige el sandbox gVisor (runsc): el driver local '
        + '(sin frontera de aislamiento) queda deshabilitado.',
      );
    }
    return createLocalSandbox({ signal: opts.signal, persistKey });
  }
  if (requested === 'docker') return createDockerSandbox({ signal: opts.signal, persistKey, env });
  // auto: the remote sandbox microservice wins when configured (this is how a
  // Docker-less host like Replit gets real container isolation); then a local
  // Docker daemon; then the in-process local workspace fallback (dev/CI only:
  // in production, or under SIRAGPT_SANDBOX_REQUIRE_GVISOR=1, a missing/broken
  // Docker+runsc fails CLOSED instead of degrading to a weaker sandbox).
  if (hasRemote) {
    return require('./remote-sandbox').createRemoteSandbox({
      signal: opts.signal,
      workspaceKey: persistKey,
    });
  }
  if (await dockerAvailable(opts.signal)) {
    try {
      return await createDockerSandbox({ signal: opts.signal, persistKey, env });
    } catch (err) {
      // Honest failures never degrade: a demanded-but-missing runtime, an
      // abort, or ANY docker failure in fail-closed mode propagates.
      if (err?.name === 'SandboxRuntimeError' || err?.name === 'AbortError') throw err;
      if (requireGvisor || production) throw err;
      /* image missing etc. (dev/CI) → local */
    }
  } else if (requireGvisor || production) {
    throw new SandboxRuntimeError(
      'Docker no está disponible y el sandbox endurecido (gVisor) es obligatorio '
      + '(NODE_ENV=production o SIRAGPT_SANDBOX_REQUIRE_GVISOR=1). No se degrada en '
      + 'silencio al driver local. Levanta Docker con el runtime runsc o exporta '
      + 'SIRAGPT_DOC_SANDBOX_DRIVER=local para optar explícitamente por el driver '
      + 'local SIN frontera de aislamiento (solo CI/dev).',
    );
  }
  return createLocalSandbox({ signal: opts.signal, persistKey });
}

module.exports = {
  createSandbox,
  resolveInWorkspace, // exported for unit tests
  assertRealpathInWorkspace,
  safePersistKey,
  persistentWorkspaceRoot,
  resolveSandboxRuntime,
  buildDockerRunArgs,
  sandboxLimitsFromEnv,
  safeContainerRel,
  shQuote,
  SandboxRuntimeError,
  CMD_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  DOCKER_IMAGE,
  _createDockerSandbox: createDockerSandbox,
  _createLocalSandbox: createLocalSandbox,
  _listDockerRuntimes: listDockerRuntimes,
  _resetRuntimeProbeCache: resetRuntimeProbeCache,
};
