'use strict';

/**
 * codex/runner-client — typed HTTP client for the code-runner sidecar
 * (scripts/code-runner.js control API). The runner is the only process with
 * filesystem access to the sandbox volume, so every workspace/git/exec
 * operation goes through it. Injectable fetch for offline tests.
 */

class RunnerError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.status = status;
    this.body = body;
  }
}

function runnerBaseUrl(env = process.env) {
  return String(env.CODE_RUNNER_URL || 'http://runner:4097').replace(/\/+$/, '');
}

/**
 * Base URL of the runner's dev server. With `port` (multi-project pool, audit
 * B1) the configured URL's port is swapped for the project's assigned one;
 * without it, the legacy single-port URL is returned unchanged.
 */
function runnerDevUrl(env = process.env, port = null) {
  const base = env.CODE_RUNNER_DEV_URL || 'http://localhost:5173';
  if (port == null) return base;
  try {
    const u = new URL(base);
    u.port = String(port);
    return u.toString().replace(/\/+$/, '');
  } catch {
    return base;
  }
}

// Host-visible base dir the runner's /export bind-mount maps to (display only —
// the backend never touches it; the runner writes there). Default matches the
// compose bind mount `./.codex-workspaces`.
function codexExportHostDir(env = process.env) {
  return String(env.CODEX_EXPORT_HOST_DIR || '.codex-workspaces').replace(/[/\\]+$/, '');
}

/** Human-facing path of an exported project, e.g. `.codex-workspaces/<id>`. */
function codexExportHostPath(projectId, env = process.env) {
  const sep = /\\/.test(codexExportHostDir(env)) ? '\\' : '/';
  return `${codexExportHostDir(env)}${sep}${projectId}`;
}

function createRunnerClient({ fetchImpl = fetch, baseUrl = runnerBaseUrl(), timeoutMs = 30_000 } = {}) {
  async function call(method, path, body, { callTimeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), callTimeoutMs || timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new RunnerError(`runner unreachable: ${err.message}`, { status: 0 });
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new RunnerError(json.error || `runner http ${res.status}`, { status: res.status, body: json });
    }
    return json;
  }

  return {
    initWorkspace: (project) => call('POST', '/workspace/init', { project }),
    writeFiles: (project, files) => call('POST', '/workspace/write', { project, files }),
    readFile: (project, path) =>
      call('GET', `/workspace/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`),
    exec: (project, cmd, opts = {}) =>
      // The HTTP abort must outlive the command's own budget — otherwise a
      // 120s `bun install` gets chopped at the client's 30s default.
      call('POST', '/workspace/exec', { project, cmd, timeoutMs: opts.timeoutMs }, {
        callTimeoutMs: opts.timeoutMs ? Math.max(timeoutMs, opts.timeoutMs + 10_000) : undefined,
      }),
    // Multi-project (audit B1): /run answers { port } of the project's slot;
    // /status and /stop accept an optional project. Without one they keep the
    // legacy semantics (status of the last started server / stop ALL servers).
    startDev: (project, opts = {}) => call('POST', '/run', { project, basePath: opts.basePath || null }),
    devStatus: (project) =>
      call('GET', project ? `/status?project=${encodeURIComponent(project)}` : '/status'),
    stopDev: (project) => call('POST', '/stop', project ? { project } : {}),
    exportWorkspace: (project) => call('POST', '/workspace/export', { project }),
  };
}

module.exports = { createRunnerClient, RunnerError, runnerBaseUrl, runnerDevUrl, codexExportHostDir, codexExportHostPath };
