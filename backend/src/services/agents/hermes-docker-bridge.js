'use strict';

/**
 * Hermes environment bridge — maps Hermes terminal backends to SiraGPT sandbox/runtime.
 * Covers docker, local, ssh-style isolation via code-sandbox + env flags.
 */

const codeSandbox = require('./code-sandbox');

const HERMES_BACKENDS = Object.freeze([
  { id: 'local', label: 'Local process', siragpt: 'code-sandbox + host-bash-tool', available: true },
  { id: 'docker', label: 'Docker container', siragpt: 'SANDBOX_DOCKER=1 when configured', available: isTruthy(process.env.SANDBOX_DOCKER) || isTruthy(process.env.DOCKER_HOST) },
  { id: 'ssh', label: 'Remote SSH', siragpt: 'host-bash-tool with SSH_HOST env', available: Boolean(process.env.SIRAGPT_SSH_HOST) },
  { id: 'modal', label: 'Modal serverless', siragpt: 'planned via compute route', available: isTruthy(process.env.SIRAGPT_MODAL_ENABLED) },
  { id: 'daytona', label: 'Daytona sandbox', siragpt: 'planned via compute route', available: isTruthy(process.env.SIRAGPT_DAYTONA_ENABLED) },
  { id: 'vercel', label: 'Vercel sandbox', siragpt: 'planned via compute route', available: isTruthy(process.env.SIRAGPT_VERCEL_SANDBOX_ENABLED) },
]);

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

function listBackends() {
  return HERMES_BACKENDS.map((b) => ({ ...b }));
}

function getSandboxProfile() {
  return {
    languages: ['python', 'javascript', 'node'],
    timeoutMs: Number.parseInt(process.env.SIRAGPT_SANDBOX_TIMEOUT_MS || '10000', 10),
    maxOutputBytes: Number.parseInt(process.env.SIRAGPT_SANDBOX_MAX_OUTPUT || `${64 * 1024}`, 10),
    maxSourceBytes: Number.parseInt(process.env.SIRAGPT_SANDBOX_MAX_SOURCE || `${256 * 1024}`, 10),
    docker: isTruthy(process.env.SANDBOX_DOCKER),
  };
}

async function healthCheck() {
  let sandboxOk = false;
  let sandboxError = null;
  try {
    const result = await codeSandbox.run('print("ok")', { language: 'python', timeoutMs: 5000 });
    sandboxOk = result?.exitCode === 0 || String(result?.stdout || '').includes('ok');
  } catch (err) {
    sandboxError = err.message;
  }

  return {
    ok: sandboxOk,
    sandbox: { ok: sandboxOk, error: sandboxError },
    backends: listBackends(),
    profile: getSandboxProfile(),
  };
}

module.exports = {
  HERMES_BACKENDS,
  listBackends,
  getSandboxProfile,
  healthCheck,
};
