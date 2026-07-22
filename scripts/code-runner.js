/**
 * code-runner — Phase B dev-server runner for the /code workspace.
 *
 * Runs as a tiny Bun sidecar that SHARES the OpenCode engine's workspace volume,
 * so it sees the multi-file project the agent wrote. On `POST /run` it installs
 * deps with bun and starts that project's dev server on a port from the pool
 * (CODE_RUNNER_DEV_PORT_POOL, default DEV_PORT..DEV_PORT+9), so the /code
 * preview can iframe a REAL running Node/Vite/Next app — not just CDN HTML.
 *
 * MULTI-PROJECT (audit B1): one dev server per project, each on its own pool
 * port. Concurrency limit = pool size; when the pool is exhausted the OLDEST
 * server in state ready/error is evicted (killed with its process group).
 * If nothing is evictable (all still installing) /run answers 429. Servers
 * idle > CODE_RUNNER_DEV_IDLE_MS (default 30 min without control-API activity
 * for that project) are reaped. The legacy no-project run (workspace root)
 * stays pinned to DEV_PORT so the old /code flow keeps its contract.
 *
 * Control API (CTRL_PORT, internal):
 *   POST /run     → (re)install + start the dev server for { project? } and
 *                   answer { ok, port, project, reused }. A missing project is
 *                   rejected: the shared workspace root cannot be assigned a
 *                   safe per-project uid.
 *                   429 { error: "dev_pool_exhausted" } when the pool is full
 *                   and nothing is evictable.
 *   GET  /status  → ?project=X for that project's server; without it, legacy:
 *                   the LAST STARTED server, plus a `servers` summary array.
 *   POST /stop    → { project? } kills that project's server; without a body
 *                   it kills them ALL (legacy semantics).
 *
 * Workspace API (Codex Agent V2, flag-gated at the backend):
 *   POST /workspace/init  { project }          → mkdir + git init -b main
 *   POST /workspace/write { project, files[] } → write files (paths sanitized)
 *   GET  /workspace/file?project&path          → read a file (cap 200k)
 *   POST /workspace/exec  { project, cmd[], timeoutMs } → allowlisted exec
 *   POST /workspace/export { project }                  → mirror source to
 *                   EXPORT_DIR/<project> (host bind-mount) — hybrid "to disk".
 * The dev server itself is reachable on DEV_PORT (published in compose).
 */

const {
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  rmSync,
  chmodSync,
  chownSync,
  closeSync,
  constants: fsConstants,
  fchmodSync,
  openSync,
} = require("node:fs");
const { dirname } = require("node:path");
const {
  sanitizeProjectId,
  resolveProjectRelPath,
  commandRejectionReason,
  shouldIgnoreExportPath,
  parseDevPortPool,
  createDevPool,
  buildRunnerEnv,
  isControlRequestAuthorized,
  controlTokenForEnv,
  projectIdentity,
  sandboxCommand,
} = require("./code-runner-utils.js");

const WORKDIR = process.env.RUNNER_WORKDIR || "/workspace";
const DEV_PORT = Number(process.env.DEV_PORT || 5173);
const DEV_PORT_POOL = parseDevPortPool(process.env.CODE_RUNNER_DEV_PORT_POOL, DEV_PORT);
const DEV_IDLE_MS = Math.max(60_000, Number(process.env.CODE_RUNNER_DEV_IDLE_MS) || 30 * 60_000);
const CTRL_PORT = Number(process.env.CTRL_PORT || 4097);
const PROJECTS_DIR = `${WORKDIR}/projects`;
// Host-bind-mounted mirror target (Codex Agent V2 "export to disk", hybrid mode).
const EXPORT_DIR = process.env.EXPORT_DIR || "/export";
const CONTROL_TOKEN = controlTokenForEnv(process.env);
const FS_HELPER_PATH = process.env.CODE_RUNNER_FS_HELPER_PATH || "/opt/code-runner/code-runner-fs-helper.js";

function boundedPositiveEnv(name, fallback, min, max) {
  const parsed = Math.trunc(Number(process.env[name]));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const UID_BASE = boundedPositiveEnv("CODE_RUNNER_UID_BASE", 100_000, 1, 2_000_000_000);
const UID_SPAN = boundedPositiveEnv("CODE_RUNNER_UID_SPAN", 1_000_000, 1, 1_000_000_000);
const GID_BASE = boundedPositiveEnv("CODE_RUNNER_GID_BASE", UID_BASE, 1, 2_000_000_000);
const GID_SPAN = boundedPositiveEnv("CODE_RUNNER_GID_SPAN", UID_SPAN, 1, 1_000_000_000);
const CACHE_ROOT = process.env.RUNNER_CACHE_ROOT || "/runner-cache";
const HOME_ROOT = process.env.RUNNER_HOME_ROOT || "/runner-home";
const TMP_ROOT = process.env.RUNNER_TMP_ROOT || "/runner-tmp";
const INSTALL_TIMEOUT_MS = boundedPositiveEnv("CODE_RUNNER_INSTALL_TIMEOUT_MS", 180_000, 1_000, 30 * 60_000);
const DEV_READY_TIMEOUT_MS = boundedPositiveEnv("CODE_RUNNER_DEV_READY_TIMEOUT_MS", 90_000, 5_000, 30 * 60_000);
const EXEC_DEFAULT_TIMEOUT_MS = boundedPositiveEnv("CODE_RUNNER_EXEC_TIMEOUT_MS", 30_000, 1_000, 30 * 60_000);
const EXEC_MAX_TIMEOUT_MS = boundedPositiveEnv("CODE_RUNNER_EXEC_TIMEOUT_MAX_MS", 120_000, 1_000, 60 * 60_000);
const KILL_GRACE_MS = boundedPositiveEnv("CODE_RUNNER_KILL_GRACE_MS", 4_000, 100, 30_000);
const FS_HELPER_TIMEOUT_MS = boundedPositiveEnv("CODE_RUNNER_FS_HELPER_TIMEOUT_MS", 30_000, 1_000, 5 * 60_000);
const WRITE_MAX_TOTAL_BYTES = boundedPositiveEnv("CODE_RUNNER_WRITE_MAX_TOTAL_BYTES", 20_000_000, 1_000_000, 100_000_000);
const EXPORT_MAX_FILES = boundedPositiveEnv("CODE_RUNNER_EXPORT_MAX_FILES", 5_000, 1, 20_000);
const EXPORT_MAX_BYTES = boundedPositiveEnv("CODE_RUNNER_EXPORT_MAX_BYTES", 20_000_000, 1_000_000, 100_000_000);
const SANDBOX_LIMITS = Object.freeze({
  // V8 reserves a large virtual cage before allocating real pages. A 2-4 GiB
  // RLIMIT_AS lets simple node:http/node:sqlite apps start but then fail while
  // instantiating llhttp WebAssembly. RSS remains hard-capped by the container
  // cgroup; this limit only prevents unbounded virtual mappings.
  addressSpaceBytes: boundedPositiveEnv("CODE_RUNNER_RLIMIT_AS_BYTES", 16 * 1024 * 1024 * 1024, 256 * 1024 * 1024, 64 * 1024 * 1024 * 1024),
  maxProcesses: boundedPositiveEnv("CODE_RUNNER_RLIMIT_NPROC", 128, 8, 4096),
  maxOpenFiles: boundedPositiveEnv("CODE_RUNNER_RLIMIT_NOFILE", 256, 32, 65_536),
  maxFileBytes: boundedPositiveEnv("CODE_RUNNER_RLIMIT_FSIZE_BYTES", 512 * 1024 * 1024, 1024 * 1024, 16 * 1024 * 1024 * 1024),
  cpuSeconds: boundedPositiveEnv("CODE_RUNNER_RLIMIT_CPU_SECONDS", 7200, 30, 7 * 24 * 60 * 60),
});

function sandboxIdentityFor(projectId) {
  return projectIdentity(projectId || "__legacy__", {
    uidBase: UID_BASE,
    uidSpan: UID_SPAN,
    gidBase: GID_BASE,
    gidSpan: GID_SPAN,
  });
}

function ensureRootDir(path, mode = 0o711) {
  mkdirSync(path, { recursive: true, mode });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe runner directory: ${path}`);
  chmodSync(path, mode);
}

for (const path of [PROJECTS_DIR, CACHE_ROOT, HOME_ROOT, TMP_ROOT]) ensureRootDir(path);
ensureRootDir(EXPORT_DIR, 0o700);

// `concurrently` uses `ps` to discover and terminate its Vite/Express child
// tree. Keep it as a boot requirement so a slim-image regression fails before
// accepting preview work instead of timing out after the first full-stack run.
const REQUIRED_SANDBOX_TOOLS = ["setsid", "prlimit", "setpriv", "ps"];
for (const tool of REQUIRED_SANDBOX_TOOLS) {
  let ok = false;
  try {
    ok = Bun.spawnSync([tool, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`code-runner requires ${tool} (install util-linux)`);
}
if (typeof fsConstants.O_NOFOLLOW !== "number") {
  throw new Error("code-runner requires filesystem O_NOFOLLOW support");
}
const fsHelperStat = lstatSync(FS_HELPER_PATH);
if (
  !fsHelperStat.isFile()
  || fsHelperStat.isSymbolicLink()
  || fsHelperStat.uid !== 0
  || (fsHelperStat.mode & 0o022) !== 0
) {
  throw new Error("code-runner filesystem helper must be a root-owned, non-writable regular file");
}
const { migrateOwnershipTree, sealWorkspaceRoot } = require(FS_HELPER_PATH);
if (typeof migrateOwnershipTree !== "function" || typeof sealWorkspaceRoot !== "function") {
  throw new Error("code-runner filesystem helper is missing ownership safeguards");
}
sealWorkspaceRoot(WORKDIR, "projects");

function ensureOwnedDir(path, identity, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe runtime directory: ${path}`);
  chownSync(path, identity.uid, identity.gid);
  chmodSync(path, mode);
}

function runtimePathsFor(projectId, identity = sandboxIdentityFor(projectId)) {
  const key = projectId || "__legacy__";
  const paths = {
    home: `${HOME_ROOT}/${key}`,
    cache: `${CACHE_ROOT}/${key}`,
    tmp: `${TMP_ROOT}/${key}`,
  };
  ensureOwnedDir(paths.home, identity);
  ensureOwnedDir(paths.cache, identity);
  ensureOwnedDir(`${paths.cache}/bun`, identity);
  ensureOwnedDir(`${paths.cache}/npm`, identity);
  ensureOwnedDir(`${paths.cache}/xdg`, identity);
  ensureOwnedDir(paths.tmp, identity);
  return paths;
}

function generatedCodeEnv(projectId, overrides = {}) {
  const identity = sandboxIdentityFor(projectId);
  const paths = runtimePathsFor(projectId, identity);
  return buildRunnerEnv(process.env, {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: paths.home,
    TMPDIR: paths.tmp,
    XDG_CACHE_HOME: `${paths.cache}/xdg`,
    BUN_INSTALL_CACHE_DIR: `${paths.cache}/bun`,
    NPM_CONFIG_CACHE: `${paths.cache}/npm`,
    npm_config_cache: `${paths.cache}/npm`,
    ...overrides,
  });
}

function spawnSandboxed(projectId, cmd, options = {}) {
  const identity = sandboxIdentityFor(projectId);
  return Bun.spawn(sandboxCommand(cmd, identity, SANDBOX_LIMITS), {
    ...options,
    env: generatedCodeEnv(projectId, options.env || {}),
  });
}

function spawnSandboxedSync(projectId, cmd, options = {}) {
  const identity = sandboxIdentityFor(projectId);
  return Bun.spawnSync(sandboxCommand(cmd, identity, SANDBOX_LIMITS), {
    ...options,
    env: generatedCodeEnv(projectId, options.env || {}),
  });
}

function projectDirOf(id) {
  return `${PROJECTS_DIR}/${id}`;
}

function ensureProjectDirectory(id) {
  const dir = projectDirOf(id);
  const identity = sandboxIdentityFor(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe_project_directory");
  // Seal legacy 0755 workspaces before touching their contents. No existing
  // unprivileged project process can traverse the tree during migration.
  chmodSync(dir, 0o700);
  // One-time ownership migration for workspaces created by the old root
  // runner. Once the root is owned by this project's uid, all subsequent API
  // writes preserve that invariant without rescanning node_modules.
  if (st.uid !== identity.uid || st.gid !== identity.gid) migrateOwnershipTree(dir, identity);
  chownSync(dir, identity.uid, identity.gid);
  chmodSync(dir, 0o700);
  runtimePathsFor(id, identity);
  return { dir, identity };
}

function filesystemHelperError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function callFilesystemHelper(projectId, args, { input = null, outputCap = 1_000_000 } = {}) {
  const proc = spawnSandboxed(projectId, [process.execPath, FS_HELPER_PATH, ...args], {
    cwd: projectDirOf(projectId),
    stdin: input == null ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = collectOutput(proc.stdout, outputCap);
  const stderrPromise = collectOutput(proc.stderr, 2_000);
  if (input != null) {
    try {
      proc.stdin.write(input);
      proc.stdin.end();
    } catch {
      killGroup(proc);
    }
  }
  const { exitCode, timedOut } = await waitForExit(proc, FS_HELPER_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timedOut) throw filesystemHelperError("filesystem_operation_timeout");
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw filesystemHelperError("filesystem_helper_invalid_response", stderr || `exit ${exitCode}`);
  }
  if (exitCode !== 0 || !payload || payload.ok !== true) {
    throw filesystemHelperError(payload && payload.error ? payload.error : "filesystem_operation_failed", stderr);
  }
  return payload;
}

function ensurePrivateExportParent(destRoot, rel) {
  const parent = dirname(rel);
  if (!parent || parent === ".") return;
  let current = destRoot;
  for (const segment of parent.split("/")) {
    current = `${current}/${segment}`;
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe_export_path");
    chmodSync(current, 0o700);
  }
}

function writePrivateExport(projectId, files) {
  const destRoot = `${EXPORT_DIR}/${projectId}`;
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { mode: 0o700 });
  chmodSync(destRoot, 0o700);
  let written = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const rel = resolveProjectRelPath(file && file.path);
    if (!rel || shouldIgnoreExportPath(rel) || typeof file.content !== "string") continue;
    ensurePrivateExportParent(destRoot, rel);
    const abs = `${destRoot}/${rel}`;
    let fd = null;
    try {
      fd = openSync(
        abs,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      writeFileSync(fd, Buffer.from(file.content, "base64"));
      written++;
    } finally {
      if (fd != null) closeSync(fd);
    }
  }
  return written;
}

// ── Multi-project dev-server registry ───────────────────────────────────────
// ROOT_KEY remains only for the no-project status/stop response shape. Starting
// a workspace-root process is deliberately rejected by startDev.
const ROOT_KEY = "";
const devPool = createDevPool({ ports: DEV_PORT_POOL });
let lastStartedKey = null; // legacy GET /status (no project) mirrors this one

// `setsid` makes the spawned dev command a process-group leader (it execs in
// place when the caller isn't already a group leader, so the pid is stable),
// which lets us kill the WHOLE tree (npm/node → vite → esbuild...) on evict/stop.
// Same pattern as host-runner.js killGroup. sandboxCommand always places
// setsid first, so proc.pid is also the process-group id.

function killGroup(proc) {
  if (!proc || !proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM"); // group leader (setsid) → whole tree
  } catch {
    try { proc.kill(); } catch { /* already gone */ }
  }
  // Escalate stragglers: SIGKILL the group a few seconds later, best-effort.
  const pid = proc.pid;
  const escalation = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }, KILL_GRACE_MS);
  if (typeof escalation.unref === "function") escalation.unref();
}

async function waitForExit(proc, timeoutMs) {
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    killGroup(proc);
  }, timeoutMs);
  const exitCode = await proc.exited;
  settled = true;
  clearTimeout(timer);
  return { exitCode, timedOut };
}

async function collectOutput(stream, cap = 30_000) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (text.length < cap) text += decoder.decode(value, { stream: true }).slice(0, cap - text.length);
    }
    if (text.length < cap) text += decoder.decode().slice(0, cap - text.length);
  } catch {
    /* process stream closed during group termination */
  }
  return text.slice(0, cap);
}

function killEntryProc(entry) {
  if (!entry) return;
  killGroup(entry.proc);
  entry.proc = null;
}

function pushLog(entry, line) {
  entry.log.push(String(line).slice(0, 500));
  if (entry.log.length > 80) entry.log.shift();
}

function entryStatus(entry) {
  if (!entry) {
    return { running: false, ready: false, framework: null, project: null, port: null, basePath: null, error: null, log: [] };
  }
  return {
    running: entry.state === "installing" || entry.state === "starting" || entry.state === "ready",
    ready: entry.state === "ready",
    framework: entry.framework || null,
    project: entry.key === ROOT_KEY ? null : entry.key,
    port: entry.port,
    basePath: entry.basePath || null,
    error: entry.error || null,
    log: entry.log,
    startedAt: entry.startedAt,
  };
}

function serversSummary() {
  return devPool.list().map((e) => ({
    project: e.key === ROOT_KEY ? null : e.key,
    port: e.port,
    state: e.state,
    startedAt: e.startedAt,
    lastUsedAt: e.lastUsedAt,
  }));
}

async function readProjectJson(projectId, relPath) {
  try {
    const result = await callFilesystemHelper(projectId, ["read", relPath, "1000000"], { outputCap: 2_000_000 });
    return JSON.parse(result.content);
  } catch {
    return null;
  }
}

/** Is the configured preview base returning a successful HTTP response? */
async function probeReady(port, basePath = null) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const probePath = safeBasePath(basePath) || "/";
    const r = await fetch(`http://127.0.0.1:${port}${probePath}`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function pipe(entry, stream, prefix) {
  if (!stream) return;
  (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          if (line.trim()) pushLog(entry, `${prefix} ${line.trim()}`);
        }
      }
    } catch {
      /* stream closed */
    }
  })();
}

function safeBasePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.includes("\0") || raw.includes("..")) return null;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Allocate (or reuse) the slot for a project and kick off install+dev in the
 * background. Returns { port, project, reused } synchronously-ish (one probe
 * when reusing). Throws { code: "dev_pool_exhausted" } when the pool is full
 * and nothing is evictable.
 */
async function startDev(projectId = null, basePath = null) {
  if (!projectId) {
    const error = new Error("legacy workspace-root execution is disabled; provide a project id");
    error.code = "legacy_root_run_disabled";
    throw error;
  }
  const key = projectId || ROOT_KEY;
  const normBase = safeBasePath(basePath);
  if (!existsSync(projectDirOf(projectId))) {
    const error = new Error("project not found");
    error.code = "project_not_found";
    throw error;
  }
  ensureProjectDirectory(projectId);

  // Reuse: same project, already serving with the same base path → no restart
  // (vite watches files, edits are picked up by HMR without a re-run).
  const existing = devPool.get(key);
  if (
    existing
    && existing.state === "ready"
    && (existing.basePath || null) === normBase
    && (await probeReady(existing.port, existing.basePath))
  ) {
    devPool.touch(key);
    lastStartedKey = key;
    return { port: existing.port, project: projectId, reused: true };
  }

  const alloc = devPool.allocate(key, key === ROOT_KEY ? { pinnedPort: DEV_PORT } : {});
  if (!alloc) {
    const err = new Error("dev pool exhausted: all slots are busy starting");
    err.code = "dev_pool_exhausted";
    throw err;
  }
  if (alloc.evicted) {
    killEntryProc(alloc.evicted);
    console.log(`[code-runner] evicted dev server ${alloc.evicted.key || "<root>"} on :${alloc.evicted.port}`);
  }
  const entry = alloc.entry;
  killEntryProc(entry); // restart of an existing slot → kill the old tree first
  entry.gen = (entry.gen || 0) + 1;
  entry.state = "installing";
  entry.error = null;
  entry.log = [];
  entry.framework = null;
  entry.basePath = normBase;
  entry.startedAt = Date.now();
  entry.lastUsedAt = Date.now();
  lastStartedKey = key;

  runDev(entry, projectId).catch((e) => {
    if (devPool.get(key) !== entry) return; // superseded/stopped meanwhile
    entry.state = "error";
    entry.error = String(e && e.message ? e.message : e);
  });
  return { port: entry.port, project: projectId, reused: false };
}

async function runDev(entry, projectId) {
  const myGen = entry.gen;
  const key = entry.key;
  const port = entry.port;
  // A newer /run (or /stop) for this project supersedes this generation.
  const stale = () => devPool.get(key) !== entry || entry.gen !== myGen;

  const cwd = projectDirOf(projectId);
  const pkg = await readProjectJson(projectId, "package.json");
  if (!pkg) {
    entry.state = "error";
    entry.error = "No package.json — this project doesn't need a build (use the static preview).";
    return;
  }

  // Detect the framework for the right dev command + port flag.
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const isNext = !!deps.next;
  const devScript = String((pkg.scripts && pkg.scripts.dev) || "");
  const hasDevScript = Boolean(devScript);
  // A composite dev script (the full-stack starter: `concurrently "api" "web"`)
  // must run AS-IS — forcing `bunx vite` here silently dropped the Express API,
  // so "backend real" apps rendered but every /api call died. Port/base reach
  // Vite through env (PORT/VITE_BASE, read by that starter's vite.config).
  const isCompositeDev = /\bconcurrently\b/.test(devScript);
  entry.framework = isNext ? "next" : isCompositeDev ? "custom" : deps.vite ? "vite" : hasDevScript ? "custom" : "vite";

  pushLog(entry, "$ bun install");
  const install = spawnSandboxed(projectId, ["bun", "install"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { NODE_ENV: "development", CI: "1" },
  });
  entry.proc = install;
  pipe(entry, install.stdout, "[install]");
  pipe(entry, install.stderr, "[install]");
  const installResult = await waitForExit(install, INSTALL_TIMEOUT_MS);
  const code = installResult.exitCode;
  if (stale()) return;
  if (installResult.timedOut) {
    entry.proc = null;
    entry.state = "error";
    entry.error = `bun install timed out after ${INSTALL_TIMEOUT_MS}ms`;
    return;
  }
  if (code !== 0) {
    entry.proc = null;
    entry.state = "error";
    entry.error = `bun install failed (exit ${code})`;
    return;
  }

  // Dev command per framework. Host 0.0.0.0 so it's reachable from the proxy.
  let cmd;
  if (isNext) {
    cmd = ["node", "node_modules/next/dist/bin/next", "dev", "-H", "0.0.0.0", "-p", String(port)];
  } else if (isCompositeDev) {
    // Full-stack starter: concurrently boots API + web; flags can't reach the
    // inner vite, so it reads PORT/VITE_BASE/API_PORT from the env below.
    cmd = ["npm", "run", "dev"];
  } else if (deps.vite || (hasDevScript && /vite/.test(devScript))) {
    cmd = ["node", "node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", String(port)];
    if (entry.basePath) cmd.push("--base", entry.basePath);
  } else if (hasDevScript) {
    cmd = ["npm", "run", "dev"];
  } else {
    cmd = ["node", "node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", String(port)];
    if (entry.basePath) cmd.push("--base", entry.basePath);
  }
  pushLog(entry, `$ ${cmd.join(" ")}`);
  entry.state = "starting";
  const devProc = spawnSandboxed(projectId, cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "development",
      PORT: String(port),
      HOST: "0.0.0.0",
      BROWSER: "none",
      // Vite 7 host-checks the Host header and 403s anything that isn't
      // localhost — the backend's browser verifier reaches this dev server as
      // http://runner:5173, so every check saw "Blocked request" instead of
      // the app. This env var (Vite's official escape hatch) whitelists the
      // container hostname for ALL workspaces, including pre-existing ones
      // whose vite.config predates the allowedHosts fix in the starter.
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: process.env.VITE_EXTRA_ALLOWED_HOST || "runner",
      // Composite (concurrently) projects can't take CLI flags, so the
      // tokenized base + the derived API port travel via env instead. Plain
      // vite starters ignore both — harmless.
      VITE_BASE: entry.basePath || "/",
      API_PORT: String(port + 1000),
    },
  });
  entry.proc = devProc;
  pipe(entry, devProc.stdout, "[dev]");
  pipe(entry, devProc.stderr, "[dev]");

  // Poll readiness within the configured wall-clock budget. Resource limits
  // remain active for the lifetime of the dev tree after it becomes ready.
  const readyDeadline = Date.now() + DEV_READY_TIMEOUT_MS;
  while (Date.now() < readyDeadline) {
    await Bun.sleep(1500);
    if (stale()) return;
    if (await probeReady(port, entry.basePath)) {
      entry.state = "ready";
      pushLog(entry, `[runner] dev server ready on ${port}`);
      return;
    }
    if (devProc.killed) {
      entry.state = "error";
      entry.error = "dev server exited before becoming ready";
      return;
    }
  }
  // Kill the stalled tree so a late-ready zombie can't confuse the next /status.
  killEntryProc(entry);
  entry.state = "error";
  entry.error = `dev server didn't become ready in ${DEV_READY_TIMEOUT_MS}ms`;
}

function stopEntry(key) {
  const entry = devPool.release(key);
  if (!entry) return false;
  killEntryProc(entry);
  entry.state = "stopped";
  if (lastStartedKey === key) lastStartedKey = null;
  return true;
}

// Reaper: kill dev servers with no control-API activity for DEV_IDLE_MS.
// (The proxy talks straight to the dev port, so "idle" means no /run|/status
// touches for that project — the frontend re-runs preview/start on a dead
// preview, and warm bun caches make that restart fast.)
setInterval(() => {
  for (const idle of devPool.idleEntries(DEV_IDLE_MS)) {
    console.log(`[code-runner] reaping idle dev server ${idle.key || "<root>"} on :${idle.port}`);
    stopEntry(idle.key);
  }
}, 60_000);

Bun.serve({
  port: CTRL_PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (!isControlRequestAuthorized({
      pathname: url.pathname,
      authorization: req.headers.get("authorization"),
      token: CONTROL_TOKEN,
    })) {
      return Response.json(
        { ok: false, error: "unauthorized" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="code-runner"',
            "Cache-Control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/workspace/init" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      if (!id) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      let dir;
      try {
        ({ dir } = ensureProjectDirectory(id));
      } catch (error) {
        return Response.json({ ok: false, error: "workspace_init_failed", detail: String(error.message || error).slice(0, 300) }, { status: 500 });
      }
      const init = spawnSandboxedSync(id, ["git", "init", "-b", "main"], { cwd: dir });
      if (init.exitCode !== 0) {
        const detail = init.stderr ? init.stderr.toString().slice(0, 500) : "git unavailable";
        return Response.json({ ok: false, error: "git_init_failed", detail }, { status: 500 });
      }
      return Response.json({ ok: true, dir: `projects/${id}` });
    }

    if (url.pathname === "/workspace/write" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!id || !files.length) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      if (!existsSync(projectDirOf(id))) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      ensureProjectDirectory(id);
      const accepted = [];
      let acceptedBytes = 0;
      for (const f of files.slice(0, 200)) {
        const rel = resolveProjectRelPath(f && f.path);
        if (!rel || typeof f.content !== "string" || f.content.length > 2_000_000) continue;
        const bytes = Buffer.byteLength(f.content);
        if (acceptedBytes + bytes > WRITE_MAX_TOTAL_BYTES) continue;
        accepted.push({ path: rel, content: f.content });
        acceptedBytes += bytes;
      }
      try {
        const result = await callFilesystemHelper(id, ["write"], {
          input: JSON.stringify({
            files: accepted,
            limits: { maxFiles: 200, maxFileBytes: 2_000_000, maxTotalBytes: WRITE_MAX_TOTAL_BYTES },
          }),
          outputCap: 20_000,
        });
        return Response.json({ ok: true, written: result.written });
      } catch (error) {
        return Response.json({ ok: false, error: error.code || "filesystem_operation_failed" }, { status: 500 });
      }
    }

    if (url.pathname === "/workspace/file" && req.method === "GET") {
      const id = sanitizeProjectId(url.searchParams.get("project"));
      const rel = resolveProjectRelPath(url.searchParams.get("path"));
      if (!id || !rel) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      if (!existsSync(projectDirOf(id))) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      ensureProjectDirectory(id);
      try {
        const result = await callFilesystemHelper(id, ["read", rel, "200000"], { outputCap: 1_500_000 });
        return Response.json({ ok: true, path: result.path, content: result.content });
      } catch (error) {
        if (error.code === "file_not_found") {
          return Response.json({ ok: false, error: "file_not_found" }, { status: 404 });
        }
        if (error.code === "unsafe_path" || error.code === "invalid_request") {
          return Response.json({ ok: false, error: error.code }, { status: 400 });
        }
        return Response.json({ ok: false, error: "filesystem_operation_failed" }, { status: 500 });
      }
    }

    if (url.pathname === "/workspace/exec" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      const cmd = body.cmd;
      const rejection = commandRejectionReason(cmd);
      if (!id || rejection) {
        return Response.json({ ok: false, error: rejection || "invalid_command" }, { status: 400 });
      }
      if (!existsSync(projectDirOf(id))) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      const { dir } = ensureProjectDirectory(id);
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || EXEC_DEFAULT_TIMEOUT_MS, 1_000), EXEC_MAX_TIMEOUT_MS);
      const started = Date.now();
      const proc = spawnSandboxed(id, cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const stdoutPromise = collectOutput(proc.stdout);
      const stderrPromise = collectOutput(proc.stderr);
      const { exitCode, timedOut } = await waitForExit(proc, timeoutMs);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return Response.json({
        ok: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    }

    if (url.pathname === "/workspace/export" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      if (!id) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      const src = projectDirOf(id);
      if (!existsSync(src)) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      try {
        ensureProjectDirectory(id);
        const bundle = await callFilesystemHelper(
          id,
          ["export", String(EXPORT_MAX_FILES), String(EXPORT_MAX_BYTES)],
          { outputCap: Math.ceil(EXPORT_MAX_BYTES * 1.5) + 2_000_000 },
        );
        const files = writePrivateExport(id, bundle.files);
        return Response.json({ ok: true, project: id, files, bytes: bundle.totalBytes });
      } catch (e) {
        const detail = String(e && e.message ? e.message : e).slice(0, 400);
        return Response.json({ ok: false, error: "export_failed", detail }, { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      const rawProject = url.searchParams.get("project");
      let entry;
      if (rawProject) {
        const id = sanitizeProjectId(rawProject);
        if (!id) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
        entry = devPool.get(id);
        if (entry) devPool.touch(id); // status polling counts as activity for the reaper
      } else {
        // Legacy: no project param → the last started server.
        entry = lastStartedKey != null ? devPool.get(lastStartedKey) : null;
      }
      const st = entryStatus(entry);
      // Legacy contract: `ready` is a LIVE probe while the server is running
      // (it can flip true during "starting", as soon as the port answers).
      const ready = st.running ? await probeReady(st.port, st.basePath) : false;
      const { log, ...rest } = st;
      return Response.json({
        ...rest,
        ready,
        tail: (log || []).slice(-12),
        servers: serversSummary(),
      });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body && body.project ? sanitizeProjectId(body.project) : null;
      if (body && body.project && !id) {
        return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      }
      try {
        const out = await startDev(id, body && body.basePath);
        return Response.json({ ok: true, port: out.port, project: id, reused: out.reused });
      } catch (e) {
        if (e && e.code === "dev_pool_exhausted") {
          return Response.json({ ok: false, error: "dev_pool_exhausted" }, { status: 429 });
        }
        if (e && e.code === "project_not_found") {
          return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
        }
        if (e && e.code === "legacy_root_run_disabled") {
          return Response.json({ ok: false, error: "legacy_root_run_disabled" }, { status: 409 });
        }
        return Response.json({ ok: false, error: String(e && e.message ? e.message : e) }, { status: 500 });
      }
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body && body.project ? sanitizeProjectId(body.project) : null;
      if (body && body.project && !id) {
        return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      }
      if (id) {
        const stopped = stopEntry(id);
        return Response.json({ ok: true, stopped: stopped ? 1 : 0 });
      }
      // Legacy: no project → stop them ALL.
      let stopped = 0;
      for (const e of devPool.list()) {
        if (stopEntry(e.key)) stopped++;
      }
      return Response.json({ ok: true, stopped });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  },
});

console.log(
  `[code-runner] control on :${CTRL_PORT} (auth=${CONTROL_TOKEN ? "required" : "disabled-dev"}), dev pool ${DEV_PORT_POOL[0]}-${DEV_PORT_POOL[DEV_PORT_POOL.length - 1]} (${DEV_PORT_POOL.length} slots), sandbox=setpriv+prlimit+setsid, workdir ${WORKDIR}`,
);
