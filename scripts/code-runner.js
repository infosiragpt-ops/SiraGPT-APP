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
 *   POST /run     → (re)install + start the dev server. → { ok, port }
 *   GET  /status  → { running, ready, framework, port, error, tail }
 *   POST /stop    → kill the dev server.
 * The dev server itself is reachable on DEV_PORT (published in compose).
 */

const WORKDIR = process.env.RUNNER_WORKDIR || "/workspace";
const DEV_PORT = Number(process.env.DEV_PORT || 5173);
const CTRL_PORT = Number(process.env.CTRL_PORT || 4097);

let devProc = null;
const state = {
  running: false,
  ready: false,
  framework: null,
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

async function startDev() {
  if (devProc) {
    try { devProc.kill(); } catch { /* already gone */ }
    devProc = null;
  }
  state.running = true;
  state.ready = false;
  state.error = null;
  state.log = [];

  const pkg = await readJson(`${WORKDIR}/package.json`);
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
  const install = Bun.spawn(["bun", "install"], { cwd: WORKDIR, stdout: "pipe", stderr: "pipe" });
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
    cwd: WORKDIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: String(DEV_PORT), HOST: "0.0.0.0", BROWSER: "none" },
  });
  pipe(devProc.stdout, "[dev]");
  pipe(devProc.stderr, "[dev]");

  // Poll readiness for up to ~60s.
  for (let i = 0; i < 40; i++) {
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
  state.error = "dev server didn't become ready in 60s";
}

Bun.serve({
  port: CTRL_PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      const ready = state.running ? await probeReady() : false;
      return Response.json({ ...state, ready, tail: state.log.slice(-12) });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      startDev().catch((e) => {
        state.error = String(e && e.message ? e.message : e);
        state.running = false;
      });
      return Response.json({ ok: true, port: DEV_PORT });
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
