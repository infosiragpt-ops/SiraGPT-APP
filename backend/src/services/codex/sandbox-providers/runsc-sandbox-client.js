'use strict';

const crypto = require('node:crypto');
const {
  SandboxContractError,
  SandboxPolicyError,
  normalizeInstanceAttestation,
} = require('./contract');

class RunscSandboxClientError extends Error {
  constructor(code, message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'RunscSandboxClientError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function controllerUrl(env = process.env) {
  // Production runs the backend under PM2 on the host. The optional
  // controller publishes only to host loopback, so the safe process default
  // must work from that topology. The Docker-backend profile overrides this
  // explicitly with the controller service DNS name in Compose.
  const raw = String(env.CODEX_RUNSC_CONTROLLER_URL || 'http://127.0.0.1:4098').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new SandboxContractError('invalid_runsc_config', 'invalid runsc controller URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SandboxContractError('invalid_runsc_config', 'runsc controller URL must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

function controllerToken(env = process.env) {
  const value = String(env.CODEX_RUNSC_CONTROLLER_TOKEN || '').trim();
  if (value.length < 32) throw new SandboxContractError('invalid_runsc_config', 'runsc controller token is required');
  return value;
}

function workspaceKey(env = process.env) {
  const value = String(env.CODEX_RUNSC_WORKSPACE_KEY || '').trim();
  if (value.length < 32) throw new SandboxContractError('invalid_runsc_config', 'runsc workspace key is required');
  return value;
}

function controllerExecTimeout(env = process.env) {
  const value = env.CODEX_RUNSC_EXEC_TIMEOUT_MS === undefined
    ? 10 * 60 * 1000
    : Number(env.CODEX_RUNSC_EXEC_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 30 * 60 * 1000) {
    throw new SandboxContractError('invalid_runsc_config', 'runsc exec timeout must be an integer from 1000 to 1800000 ms');
  }
  return value;
}

function opaqueWorkspaceRef(projectId, key) {
  const id = String(projectId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new SandboxContractError('invalid_project_ref', 'project id cannot be converted into a sandbox reference');
  }
  return `ws_${crypto.createHmac('sha256', key).update(`sira-runsc-workspace-v1:${id}`).digest('base64url')}`;
}

function createRunscSandboxClient({
  fetchImpl = fetch,
  baseUrl,
  token,
  key,
  env = process.env,
  timeoutMs = 30_000,
  execTimeoutMs = controllerExecTimeout(env),
} = {}) {
  const endpoint = baseUrl || controllerUrl(env);
  const controlToken = token || controllerToken(env);
  const hmacKey = key || workspaceKey(env);
  const refs = new Map();

  async function call(method, path, body, { callTimeoutMs = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${controlToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new RunscSandboxClientError('controller_unreachable', `runsc controller unreachable: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new RunscSandboxClientError(json.error || 'controller_error', json.message || `controller http ${response.status}`, {
        status: response.status,
        body: json,
      });
    }
    return json;
  }

  function acceptSandboxResult(result, expectedWorkspaceRef) {
    const attestation = normalizeInstanceAttestation(result?.attestation);
    if (attestation.workspaceRef !== expectedWorkspaceRef || attestation.sandboxRef !== result?.sandboxRef) {
      throw new SandboxContractError('instance_attestation_mismatch', 'controller result does not match its inspect attestation');
    }
    return { ...result, attestation };
  }

  async function ensure(project, options = {}) {
    const ref = opaqueWorkspaceRef(project, hmacKey);
    const result = acceptSandboxResult(await call('POST', '/v1/sandboxes', {
      workspaceRef: ref,
      ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    }), ref);
    refs.set(String(project), result.sandboxRef);
    return result;
  }

  async function sandboxRefFor(project) {
    const cached = refs.get(String(project));
    if (cached) return { workspaceRef: opaqueWorkspaceRef(project, hmacKey), sandboxRef: cached };
    const created = await ensure(project);
    return { workspaceRef: created.attestation.workspaceRef, sandboxRef: created.sandboxRef };
  }

  function unavailable(operation) {
    throw new SandboxPolicyError(
      'sandbox_operation_unavailable',
      `${operation} is not enabled until the runsc workspace file and preview gateways are complete`,
    );
  }

  async function sandboxStatus(project) {
    const workspaceRef = opaqueWorkspaceRef(project, hmacKey);
    return acceptSandboxResult(
      await call('GET', `/v1/workspaces/${encodeURIComponent(workspaceRef)}`),
      workspaceRef,
    );
  }

  async function stopSandbox(project) {
    const ref = opaqueWorkspaceRef(project, hmacKey);
    return call('POST', `/v1/workspaces/${encodeURIComponent(ref)}/stop`);
  }

  return Object.freeze({
    initWorkspace: (project, options) => ensure(project, options),
    async exec(project, argv, options = {}) {
      const requestedTimeout = options.timeoutMs === undefined ? execTimeoutMs : Number(options.timeoutMs);
      if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1000 || requestedTimeout > execTimeoutMs) {
        throw new SandboxContractError('invalid_exec_timeout', `sandbox exec timeout must be between 1000 and ${execTimeoutMs} ms`);
      }
      const run = ({ sandboxRef }) => call('POST', `/v1/sandboxes/${encodeURIComponent(sandboxRef)}/exec`, {
        argv,
        timeoutMs: requestedTimeout,
      }, { callTimeoutMs: Math.max(timeoutMs, requestedTimeout + 10_000) });
      const current = await sandboxRefFor(project);
      try {
        return await run(current);
      } catch (error) {
        // A fresh client has no durable sandbox-ref cache, and GC may collect
        // a cached ref between commands. Retry only explicit not-found/gone
        // responses, which prove the command did not start. Network failures
        // remain ambiguous and are never replayed.
        const safelyDidNotStart = error instanceof RunscSandboxClientError
          && ([404, 410].includes(error.status)
            || (error.status === 409 && error.code === 'sandbox_not_running'));
        if (!safelyDidNotStart) throw error;
        refs.delete(String(project));
        return run(await sandboxRefFor(project));
      }
    },
    sandboxStatus,
    stopSandbox,
    async deleteSandbox(project) {
      const ref = opaqueWorkspaceRef(project, hmacKey);
      const result = await call('DELETE', `/v1/workspaces/${encodeURIComponent(ref)}`);
      refs.delete(String(project));
      return result;
    },
    async devStatus(project) {
      try {
        const status = await sandboxStatus(project);
        return {
          running: false,
          ready: false,
          sandboxRunning: status.state.running,
          previewTarget: status.previewTarget,
          attestation: status.attestation,
        };
      } catch (error) {
        if (!(error instanceof RunscSandboxClientError) || ![404, 410].includes(error.status)) throw error;
        refs.delete(String(project));
        return {
          running: false,
          ready: false,
          sandboxRunning: false,
          absent: true,
        };
      }
    },
    stopDev: stopSandbox,
    writeFiles: () => unavailable('writing workspace files'),
    readFile: () => unavailable('reading workspace files'),
    startDev: () => unavailable('starting previews'),
    exportWorkspace: () => unavailable('exporting workspace files'),
  });
}

module.exports = {
  RunscSandboxClientError,
  controllerUrl,
  controllerToken,
  workspaceKey,
  controllerExecTimeout,
  opaqueWorkspaceRef,
  createRunscSandboxClient,
};
