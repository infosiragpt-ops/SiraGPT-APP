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
 *                   answer { ok, port, project, reused }. Without a project it
 *                   runs the workspace root on DEV_PORT (legacy /code flow).
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

const { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } = require("node:fs");
const { dirname } = require("node:path");
const {
  sanitizeProjectId,
  resolveProjectRelPath,
  commandRejectionReason,
  shouldIgnoreExportPath,
  parseDevPortPool,
  createDevPool,
} = require("./code-runner-utils.js");

const WORKDIR = process.env.RUNNER_WORKDIR || "/workspace";
const DEV_PORT = Number(process.env.DEV_PORT || 5173);
const DEV_PORT_POOL = parseDevPortPool(process.env.CODE_RUNNER_DEV_PORT_POOL, DEV_PORT);
const DEV_IDLE_MS = Math.max(60_000, Number(process.env.CODE_RUNNER_DEV_IDLE_MS) || 30 * 60_000);
const CTRL_PORT = Number(process.env.CTRL_PORT || 4097);
const PROJECTS_DIR = `${WORKDIR}/projects`;
// Host-bind-mounted mirror target (Codex Agent V2 "export to disk", hybrid mode).
const EXPORT_DIR = process.env.EXPORT_DIR || "/export";

function projectDirOf(id) {
  return `${PROJECTS_DIR}/${id}`;
}

/**
 * Mirror a project's SOURCE (ignoring node_modules/.git/build dirs) to
 * destDir. Replaces destDir wholesale so the mirror always matches HEAD.
 * Returns the number of files copied.
 */
function exportProjectSource(srcDir, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  let files = 0;
  const walk = (relBase) => {
    const absDir = relBase ? `${srcDir}/${relBase}` : srcDir;
    for (const name of readdirSync(absDir)) {
      const rel = relBase ? `${relBase}/${name}` : name;
      if (shouldIgnoreExportPath(rel)) continue;
      const absChild = `${srcDir}/${rel}`;
      let st;
      try { st = statSync(absChild); } catch { continue; }
      if (st.isDirectory()) {
        walk(rel);
      } else if (st.isFile()) {
        const dest = `${destDir}/${rel}`;
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(absChild, dest);
        files++;
      }
    }
  };
  walk("");
  return files;
}

// Git refuses repos owned by another uid ("dubious ownership") — the volume
// is shared across containers, so trust it wholesale inside the sandbox.
try {
  Bun.spawnSync(["git", "config", "--global", "--add", "safe.directory", "*"]);
} catch {
  /* git missing — surfaced by /workspace/init instead */
}

// ── Multi-project dev-server registry ───────────────────────────────────────
// Key '' (ROOT_KEY) is the legacy workspace-root run, pinned to DEV_PORT.
const ROOT_KEY = "";
const devPool = createDevPool({ ports: DEV_PORT_POOL });
let lastStartedKey = null; // legacy GET /status (no project) mirrors this one

// `setsid` makes the spawned dev command a process-group leader (it execs in
// place when the caller isn't already a group leader, so the pid is stable),
// which lets us kill the WHOLE tree (bunx → vite → esbuild...) on evict/stop.
// Same pattern as host-runner.js killGroup; falls back to a direct kill.
const SETSID_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(["setsid", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();

function groupCmd(cmd) {
  return SETSID_AVAILABLE ? ["setsid", ...cmd] : cmd;
}

function killGroup(proc) {
  if (!proc || proc.killed) return;
  try {
    process.kill(-proc.pid, "SIGTERM"); // group leader (setsid) → whole tree
  } catch {
    try { proc.kill(); } catch { /* already gone */ }
  }
  // Escalate stragglers: SIGKILL the group a few seconds later, best-effort.
  const pid = proc.pid;
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  }, 4000);
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

async function readJson(path) {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return await f.json();
  } catch {
    return null;
  }
}

/** Is the dev server on `port` actually accepting connections yet? */
async function probeReady(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.status > 0;
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
  const key = projectId || ROOT_KEY;
  const normBase = safeBasePath(basePath);

  // Reuse: same project, already serving with the same base path → no restart
  // (vite watches files, edits are picked up by HMR without a re-run).
  const existing = devPool.get(key);
  if (existing && existing.state === "ready" && (existing.basePath || null) === normBase && (await probeReady(existing.port))) {
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

  const cwd = projectId ? projectDirOf(projectId) : WORKDIR;
  const pkg = await readJson(`${cwd}/package.json`);
  if (!pkg) {
    entry.state = "error";
    entry.error = "No package.json — this project doesn't need a build (use the static preview).";
    return;
  }

  // Detect the framework for the right dev command + port flag.
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const isNext = !!deps.next;
  const hasDevScript = pkg.scripts && pkg.scripts.dev;
  entry.framework = isNext ? "next" : deps.vite ? "vite" : hasDevScript ? "custom" : "vite";

  pushLog(entry, "$ bun install");
  const install = Bun.spawn(groupCmd(["bun", "install"]), { cwd, stdout: "pipe", stderr: "pipe" });
  entry.proc = install;
  pipe(entry, install.stdout, "[install]");
  pipe(entry, install.stderr, "[install]");
  const code = await install.exited;
  if (stale()) return;
  if (code !== 0) {
    entry.proc = null;
    entry.state = "error";
    entry.error = `bun install failed (exit ${code})`;
    return;
  }

  // Dev command per framework. Host 0.0.0.0 so it's reachable from the proxy.
  let cmd;
  if (isNext) {
    cmd = ["bunx", "next", "dev", "-H", "0.0.0.0", "-p", String(port)];
  } else if (deps.vite || (hasDevScript && /vite/.test(pkg.scripts.dev || ""))) {
    cmd = ["bunx", "vite", "--host", "0.0.0.0", "--port", String(port)];
    if (entry.basePath) cmd.push("--base", entry.basePath);
  } else if (hasDevScript) {
    cmd = ["bun", "run", "dev"];
  } else {
    cmd = ["bunx", "vite", "--host", "0.0.0.0", "--port", String(port)];
    if (entry.basePath) cmd.push("--base", entry.basePath);
  }
  pushLog(entry, `$ ${cmd.join(" ")}`);
  entry.state = "starting";
  const devProc = Bun.spawn(groupCmd(cmd), {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
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
      // Marks "this Vite runs behind the SiraGPT tokenized preview proxy" so the
      // generated vite.config disables HMR here (the proxy doesn't carry the HMR
      // WebSocket → red console errors). A standalone `vite` run has no such env
      // and keeps full hot-reload.
      SIRA_PREVIEW: "1",
    },
  });
  entry.proc = devProc;
  pipe(entry, devProc.stdout, "[dev]");
  pipe(entry, devProc.stderr, "[dev]");

  // Poll readiness for up to ~90s (cold-cache installs of vite + tailwind v4
  // native binaries can be slow; the frontend polls with its own ~3min budget).
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(1500);
    if (stale()) return;
    if (await probeReady(port)) {
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
  entry.error = "dev server didn't become ready in 90s";
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

    if (url.pathname === "/workspace/init" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      if (!id) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      const dir = projectDirOf(id);
      mkdirSync(dir, { recursive: true });
      const init = Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
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
      const dir = projectDirOf(id);
      if (!existsSync(dir)) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      let written = 0;
      for (const f of files.slice(0, 200)) {
        const rel = resolveProjectRelPath(f && f.path);
        if (!rel || typeof f.content !== "string" || f.content.length > 2_000_000) continue;
        const abs = `${dir}/${rel}`;
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
        written++;
      }
      return Response.json({ ok: true, written });
    }

    if (url.pathname === "/workspace/file" && req.method === "GET") {
      const id = sanitizeProjectId(url.searchParams.get("project"));
      const rel = resolveProjectRelPath(url.searchParams.get("path"));
      if (!id || !rel) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      const abs = `${projectDirOf(id)}/${rel}`;
      if (!existsSync(abs)) return Response.json({ ok: false, error: "file_not_found" }, { status: 404 });
      const content = readFileSync(abs, "utf8").slice(0, 200_000);
      return Response.json({ ok: true, path: rel, content });
    }

    if (url.pathname === "/workspace/exec" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      const cmd = body.cmd;
      const rejection = commandRejectionReason(cmd);
      if (!id || rejection) {
        return Response.json({ ok: false, error: rejection || "invalid_command" }, { status: 400 });
      }
      const dir = projectDirOf(id);
      if (!existsSync(dir)) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 30_000, 1_000), 120_000);
      const started = Date.now();
      const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      const stdout = (await new Response(proc.stdout).text()).slice(0, 30_000);
      const stderr = (await new Response(proc.stderr).text()).slice(0, 30_000);
      return Response.json({ ok: exitCode === 0, exitCode, stdout, stderr, durationMs: Date.now() - started });
    }

    if (url.pathname === "/workspace/export" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      if (!id) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      const src = projectDirOf(id);
      if (!existsSync(src)) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      try {
        const files = exportProjectSource(src, `${EXPORT_DIR}/${id}`);
        return Response.json({ ok: true, project: id, files });
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
      const ready = st.running ? await probeReady(st.port) : false;
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
    return new Response("code-runner ok", { status: 200 });
  },
});

console.log(
  `[code-runner] control on :${CTRL_PORT}, dev pool ${DEV_PORT_POOL[0]}-${DEV_PORT_POOL[DEV_PORT_POOL.length - 1]} (${DEV_PORT_POOL.length} slots, setsid=${SETSID_AVAILABLE}), workdir ${WORKDIR}`,
);
