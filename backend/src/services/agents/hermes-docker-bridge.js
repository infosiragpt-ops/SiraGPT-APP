'use strict';

/**
 * Hermes environment bridge — maps Hermes terminal backends to SiraGPT sandbox/runtime.
 * Covers docker, local, ssh-style isolation via code-sandbox + env flags.
 */

const codeSandbox = require('./code-sandbox');

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

// Static backend descriptors. Availability is evaluated lazily (per call) in
// listBackends() so env changes after process boot are reflected and require-time
// has no env side effects. `implemented` distinguishes backends SiraGPT actually
// wires today from planned/aspirational targets so callers don't present a stub
// as activatable.
const HERMES_BACKENDS = Object.freeze([
  { id: 'local', label: 'Local process', siragpt: 'code-sandbox + host-bash-tool', implemented: true },
  { id: 'docker', label: 'Docker container', siragpt: 'SANDBOX_DOCKER=1 when configured', implemented: true },
  { id: 'ssh', label: 'Remote SSH', siragpt: 'host-bash-tool with SSH_HOST env', implemented: true },
  { id: 'modal', label: 'Modal serverless', siragpt: 'planned via compute route', implemented: false },
  { id: 'daytona', label: 'Daytona sandbox', siragpt: 'planned via compute route', implemented: false },
  { id: 'vercel', label: 'Vercel sandbox', siragpt: 'planned via compute route', implemented: false },
]);

// Resolve a backend's availability against the CURRENT process env on every call.
function resolveAvailability(id) {
  switch (id) {
    case 'local':
      return true;
    case 'docker':
      return isTruthy(process.env.SANDBOX_DOCKER) || isTruthy(process.env.DOCKER_HOST);
    case 'ssh':
      return Boolean(process.env.SIRAGPT_SSH_HOST);
    case 'modal':
      return isTruthy(process.env.SIRAGPT_MODAL_ENABLED);
    case 'daytona':
      return isTruthy(process.env.SIRAGPT_DAYTONA_ENABLED);
    case 'vercel':
      return isTruthy(process.env.SIRAGPT_VERCEL_SANDBOX_ENABLED);
    default:
      return false;
  }
}

function listBackends() {
  return HERMES_BACKENDS.map((b) => ({ ...b, available: resolveAvailability(b.id) }));
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
    // code-sandbox.run takes a SINGLE options object. It was previously called
    // positionally — run('print("ok")', { language: 'python', ... }) — so both
    // `source` and `language` were undefined inside run(), which short-circuited
    // to { ok:false, stderr:'unsupported language: undefined' } and made the
    // sandbox always report unhealthy. Pass the object form.
    const result = await codeSandbox.run({ language: 'python', source: 'print("ok")', timeoutMs: 5000 });
    sandboxOk = result?.ok === true || String(result?.stdout || '').includes('ok');
    if (!sandboxOk && result?.stderr) {
      sandboxError = String(result.stderr).slice(0, 500);
    }
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
