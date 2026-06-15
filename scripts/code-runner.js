/**
 * code-runner — Phase B dev-server runner for the /code workspace.
 *
 * Runs as a tiny Bun sidecar that SHARES the OpenCode engine's workspace volume,
 * so it sees the multi-file project the agent wrote. On `POST /run` it installs
 * deps with bun and starts the project's dev server on DEV_PORT (published to
 * the host), so the /code preview can iframe a REAL running Node/Vite/Next app —
 * not just CDN HTML. One project at a time (the workspace is single-tenant).
 *
 * Control API (CTRL_PORT, internal):
 *   POST /run     → (re)install + start the dev server. Body { project? } to
 *                   run a per-project workspace (projects/<id>); without body
 *                   it keeps running the workspace root (legacy /code flow).
 *   GET  /status  → { running, ready, framework, project, port, error, tail }
 *   POST /stop    → kill the dev server.
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
const { sanitizeProjectId, resolveProjectRelPath, isAllowedCommand, shouldIgnoreExportPath } = require("./code-runner-utils.js");

const WORKDIR = process.env.RUNNER_WORKDIR || "/workspace";
const DEV_PORT = Number(process.env.DEV_PORT || 5173);
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

let devProc = null;
const state = {
  running: false,
  ready: false,
  framework: null,
  project: null,
  port: DEV_PORT,
  error: null,
  log: [],
};

function pushLog(line) {
  state.log.push(String(line).slice(0, 500));
  if (state.log.length > 80) state.log.shift();
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

/** Is the dev server actually accepting connections yet? */
async function probeReady() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${DEV_PORT}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.status > 0;
  } catch {
    return false;
  }
}

function pipe(stream, prefix) {
  if (!stream) return;
  (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          if (line.trim()) pushLog(`${prefix} ${line.trim()}`);
        }
      }
    } catch {
      /* stream closed */
    }
  })();
}

async function startDev(projectId = null) {
  if (devProc) {
    try { devProc.kill(); } catch { /* already gone */ }
    devProc = null;
  }
  state.running = true;
  state.ready = false;
  state.error = null;
  state.log = [];

  const cwd = projectId ? projectDirOf(projectId) : WORKDIR;
  state.project = projectId;

  const pkg = await readJson(`${cwd}/package.json`);
  if (!pkg) {
    state.running = false;
    state.error = "No package.json — this project doesn't need a build (use the static preview).";
    return;
  }

  // Detect the framework for the right dev command + port flag.
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const isNext = !!deps.next;
  const hasDevScript = pkg.scripts && pkg.scripts.dev;
  state.framework = isNext ? "next" : deps.vite ? "vite" : hasDevScript ? "custom" : "vite";

  pushLog("$ bun install");
  const install = Bun.spawn(["bun", "install"], { cwd, stdout: "pipe", stderr: "pipe" });
  pipe(install.stdout, "[install]");
  pipe(install.stderr, "[install]");
  const code = await install.exited;
  if (code !== 0) {
    state.running = false;
    state.error = `bun install failed (exit ${code})`;
    return;
  }

  // Dev command per framework. Host 0.0.0.0 so it's reachable from the host.
  let cmd;
  if (isNext) {
    cmd = ["bunx", "next", "dev", "-H", "0.0.0.0", "-p", String(DEV_PORT)];
  } else if (deps.vite || (hasDevScript && /vite/.test(pkg.scripts.dev || ""))) {
    cmd = ["bunx", "vite", "--host", "0.0.0.0", "--port", String(DEV_PORT)];
  } else if (hasDevScript) {
    cmd = ["bun", "run", "dev"];
  } else {
    cmd = ["bunx", "vite", "--host", "0.0.0.0", "--port", String(DEV_PORT)];
  }
  pushLog(`$ ${cmd.join(" ")}`);
  devProc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: String(DEV_PORT), HOST: "0.0.0.0", BROWSER: "none" },
  });
  pipe(devProc.stdout, "[dev]");
  pipe(devProc.stderr, "[dev]");

  // Poll readiness for up to ~90s (cold-cache installs of vite + tailwind v4
  // native binaries can be slow; the frontend polls with its own ~3min budget).
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(1500);
    if (await probeReady()) {
      state.ready = true;
      pushLog(`[runner] dev server ready on ${DEV_PORT}`);
      return;
    }
    if (devProc.killed) {
      state.running = false;
      state.error = "dev server exited before becoming ready";
      return;
    }
  }
  // Kill the stalled process so a late-ready zombie can't confuse the next /status.
  try {
    devProc.kill();
  } catch {
    /* already gone */
  }
  devProc = null;
  state.running = false;
  state.error = "dev server didn't become ready in 90s";
}

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
      if (!id || !isAllowedCommand(cmd)) {
        return Response.json({ ok: false, error: "invalid_command" }, { status: 400 });
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
      const ready = state.running ? await probeReady() : false;
      return Response.json({ ...state, ready, tail: state.log.slice(-12) });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body && body.project ? sanitizeProjectId(body.project) : null;
      if (body && body.project && !id) {
        return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      }
      startDev(id).catch((e) => {
        state.error = String(e && e.message ? e.message : e);
        state.running = false;
      });
      return Response.json({ ok: true, port: DEV_PORT, project: id });
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      if (devProc) { try { devProc.kill(); } catch { /* gone */ } devProc = null; }
      state.running = false;
      state.ready = false;
      return Response.json({ ok: true });
    }
    return new Response("code-runner ok", { status: 200 });
  },
});

console.log(`[code-runner] control on :${CTRL_PORT}, dev on :${DEV_PORT}, workdir ${WORKDIR}`);
