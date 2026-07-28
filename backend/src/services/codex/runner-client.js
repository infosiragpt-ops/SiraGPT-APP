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

function runnerControlToken(env = process.env) {
  return String(env.CODE_RUNNER_CONTROL_TOKEN || '').trim();
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

function createRunnerClient({
  fetchImpl = fetch,
  baseUrl = runnerBaseUrl(),
  timeoutMs = 30_000,
  controlToken = runnerControlToken(),
} = {}) {
  async function call(method, path, body, { callTimeoutMs, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), callTimeoutMs || timeoutMs);
    const abortFromCaller = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    let res;
    try {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (controlToken) headers.Authorization = `Bearer ${controlToken}`;
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new RunnerError(`runner unreachable: ${err.message}`, { status: 0 });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new RunnerError(json.error || `runner http ${res.status}`, { status: res.status, body: json });
    }
    return json;
  }

  let unscopedClient = null;

  function buildClient(scope = null) {
    const run = scope?.run || null;
    const defaultProject = scope?.project || null;
    const bodyFor = (body) => (run ? { ...body, run } : body);
    const projectFor = (project) => project || (run ? defaultProject : null);
    const queryFor = (project, extras = {}) => {
      const params = [];
      if (project) params.push(['project', project]);
      if (run) params.push(['run', run]);
      for (const [key, value] of Object.entries(extras)) {
        if (value != null) params.push([key, value]);
      }
      const query = params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return query ? `?${query}` : '';
    };

    const client = {
      scope: run ? Object.freeze({ run, project: defaultProject }) : null,
      forRun(runId, projectId = null) {
        return buildClient({
          run: String(runId || '').trim(),
          project: String(projectId || '').trim() || null,
        });
      },
      unscoped() {
        return unscopedClient;
      },
      initWorkspace: (project) => call('POST', '/workspace/init', { project }),
      createWorktree: (project, runId, baseBranch = 'main') =>
        call('POST', '/workspace/worktree', { project, run: runId, baseBranch }),
      recoverRunBase: (project, runId, { baseBranch = 'main' } = {}) =>
        call('POST', '/workspace/worktree/recover-base', {
          project,
          run: runId,
          baseBranch,
        }),
      removeWorktree: (project, runId) =>
        call('POST', '/workspace/worktree/remove', { project, run: runId }),
      writeFiles: (project, files) =>
        call('POST', '/workspace/write', bodyFor({ project: projectFor(project), files })),
      readFile: (project, path) =>
        call(
          'GET',
          `/workspace/file${queryFor(projectFor(project), { path })}`,
        ),
      readBinaryFile: (project, path) =>
        call(
          'GET',
          `/workspace/file-binary${queryFor(projectFor(project), { path })}`,
          null,
          { callTimeoutMs: 45_000 },
        ),
      exec: (project, cmd, opts = {}) =>
        // The HTTP abort must outlive the command's own budget — otherwise a
        // 120s `bun install` gets chopped at the client's 30s default.
        call('POST', '/workspace/exec', bodyFor({
          project: projectFor(project),
          cmd,
          timeoutMs: opts.timeoutMs,
        }), {
          callTimeoutMs: opts.timeoutMs ? Math.max(timeoutMs, opts.timeoutMs + 10_000) : undefined,
          signal: opts.signal,
        }),
      // A scoped client assigns its own preview slot to project+run. Legacy
      // unscoped calls keep the historical per-project/no-arg behavior.
      startDev: (project, opts = {}) => call('POST', '/run', bodyFor({
        project: projectFor(project),
        basePath: opts.basePath || null,
      })),
      devStatus: (project) => {
        const resolvedProject = projectFor(project);
        return call('GET', `/status${queryFor(resolvedProject)}`);
      },
      stopDev: (project) => {
        const resolvedProject = projectFor(project);
        return call('POST', '/stop', resolvedProject || run
          ? bodyFor({ project: resolvedProject })
          : {});
      },
      exportWorkspace: (project) =>
        call('POST', '/workspace/export', bodyFor({ project: projectFor(project) })),
      exportBuild: (project, outDir = 'dist') =>
        call('POST', '/workspace/export-build', bodyFor({
          project: projectFor(project),
          outDir,
        }), { callTimeoutMs: 120_000 }),
    };
    return client;
  }

  unscopedClient = buildClient();
  return unscopedClient;
}

module.exports = {
  createRunnerClient,
  RunnerError,
  runnerBaseUrl,
  runnerControlToken,
  runnerDevUrl,
  codexExportHostDir,
  codexExportHostPath,
};
