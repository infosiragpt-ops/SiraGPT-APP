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

function runnerDevUrl(env = process.env) {
  return env.CODE_RUNNER_DEV_URL || 'http://localhost:5173';
}

function createRunnerClient({ fetchImpl = fetch, baseUrl = runnerBaseUrl(), timeoutMs = 30_000 } = {}) {
  async function call(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    exec: (project, cmd, opts = {}) => call('POST', '/workspace/exec', { project, cmd, timeoutMs: opts.timeoutMs }),
    startDev: (project) => call('POST', '/run', { project }),
    devStatus: () => call('GET', '/status'),
    stopDev: () => call('POST', '/stop'),
  };
}

module.exports = { createRunnerClient, RunnerError, runnerBaseUrl, runnerDevUrl };
