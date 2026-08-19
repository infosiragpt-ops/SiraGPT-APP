'use strict';

/**
 * sandbox/router — pick the strongest available code-execution backend.
 *
 * Strategy (configurable via `SANDBOX_PREFERENCE`):
 *   1. e2b   — strict isolation, paid SaaS / self-hosted Firecracker
 *   2. local — best-effort child_process bounded by timeout + stream caps
 *
 * The router is `executeCode(args)` — same shape that callers already
 * use against e2b-sandbox.executeCode and local-sandbox.executeLocal,
 * so wiring through the router is a drop-in change. The result object
 * carries `backend: 'e2b'|'local'|'none'` so the caller can attribute
 * latency / failures to the right layer.
 *
 * Why this exists:
 *   Today every caller must branch on `process.env.E2B_API_KEY` (or
 *   silently no-op when E2B is missing). The router collapses that
 *   branch into one place and adds the local fallback so a deployment
 *   without E2B still has a working code-interpreter surface — useful
 *   for self-hosted operators who can't pay for E2B or need an
 *   air-gapped install.
 */

const e2b    = require('./e2b-sandbox');
const local  = require('./local-sandbox');
const remote = require('./remote-driver');

// Priority: remote (Docker/Lenovo) > e2b > local
const DEFAULT_PREFERENCE = ['remote', 'e2b', 'local'];

function readPreference(env = process.env) {
  const raw = String(env.SANDBOX_PREFERENCE || '').trim().toLowerCase();
  if (!raw) return [...DEFAULT_PREFERENCE];
  const valid = new Set(['remote', 'e2b', 'local']);
  const parts = raw.split(/[,\s]+/).filter(Boolean).filter((p) => valid.has(p));
  return parts.length > 0 ? parts : [...DEFAULT_PREFERENCE];
}

function describeBackends(env = process.env) {
  const e2bCfg    = e2b.resolveE2BConfig(env);
  const remoteCfg = remote.resolveRemoteConfig(env);
  return {
    remote: { available: remoteCfg.enabled, url: remoteCfg.url || null },
    e2b:    { available: e2bCfg.enabled, configured: e2bCfg.configured },
    local:  { available: local.resolveLocalConfig(env).enabled },
    preference: readPreference(env),
  };
}

/**
 * Run code on the first available backend in the preference order.
 * Returns the backend's native result object plus a `backend` field
 * tagging which one served the request. When no backend is enabled,
 * returns `{ ok: false, code: 'sandbox_no_backend', backend: 'none' }`.
 *
 * Backend priority (highest isolation first):
 *   remote — Lenovo Docker sandbox via HTTPS (SANDBOX_SERVICE_URL + SANDBOX_API_KEY)
 *   e2b    — Firecracker cloud sandbox (E2B_API_KEY)
 *   local  — child_process with timeout/output cap (always available)
 */
async function executeCode(args = {}, env = process.env, opts = {}) {
  const preference = readPreference(env);

  for (const backend of preference) {
    if (backend === 'remote') {
      const cfg = remote.resolveRemoteConfig(env);
      if (!cfg.enabled) continue;
      const out = await remote.executeRemote(args, env, opts);
      // If remote is unreachable and not set to remote-only, fall through.
      if (out.code === 'remote_unreachable' && !cfg.remoteOnly) continue;
      return out;
    }
    if (backend === 'e2b') {
      const cfg = e2b.resolveE2BConfig(env);
      if (!cfg.enabled) continue;
      const out = await e2b.executeCode(args, env, opts);
      return { ...out, backend: 'e2b' };
    }
    if (backend === 'local') {
      const cfg = local.resolveLocalConfig(env);
      if (!cfg.enabled) continue;
      const out = await local.executeLocal(args, env, opts);
      return { ...out, backend: 'local' };
    }
  }

  return {
    ok: false,
    code: 'sandbox_no_backend',
    message: 'no sandbox backend enabled (set SANDBOX_SERVICE_URL+SANDBOX_API_KEY, E2B_API_KEY, or LOCAL_SANDBOX_ENABLED=1)',
    backend: 'none',
  };
}

module.exports = {
  executeCode,
  describeBackends,
  readPreference,
};
