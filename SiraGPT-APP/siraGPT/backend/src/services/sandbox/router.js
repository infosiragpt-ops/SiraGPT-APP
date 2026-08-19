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

const e2b = require('./e2b-sandbox');
const local = require('./local-sandbox');

const DEFAULT_PREFERENCE = ['e2b', 'local'];

function readPreference(env = process.env) {
  const raw = String(env.SANDBOX_PREFERENCE || '').trim().toLowerCase();
  if (!raw) return [...DEFAULT_PREFERENCE];
  const parts = raw.split(/[,\s]+/).filter(Boolean).filter((p) => p === 'e2b' || p === 'local');
  return parts.length > 0 ? parts : [...DEFAULT_PREFERENCE];
}

function describeBackends(env = process.env) {
  const e2bCfg = e2b.resolveE2BConfig(env);
  return {
    e2b: { available: e2bCfg.enabled, configured: e2bCfg.configured },
    local: { available: local.resolveLocalConfig(env).enabled },
    preference: readPreference(env),
  };
}

/**
 * Run code on the first available backend in the preference order.
 * Returns the backend's native result object plus a `backend` field
 * tagging which one served the request. When no backend is enabled,
 * returns `{ ok: false, code: 'sandbox_no_backend', backend: 'none' }`.
 */
async function executeCode(args = {}, env = process.env, opts = {}) {
  const preference = readPreference(env);

  for (const backend of preference) {
    if (backend === 'e2b') {
      const cfg = e2b.resolveE2BConfig(env);
      if (!cfg.enabled) continue;
      const out = await e2b.executeCode(args, env, opts);
      return { ...out, backend: 'e2b' };
    }
    if (backend === 'local') {
      const cfg = local.resolveLocalConfig(env);
      if (!cfg.enabled) continue;
      // The local backend supports python / node / bash; e2b also
      // supports javascript / typescript / r. If the caller requested
      // a language only e2b serves and e2b is disabled, the local
      // backend will reply `sandbox_language_not_allowed` — surface
      // the error verbatim so the caller can degrade gracefully.
      const out = await local.executeLocal(args, env, opts);
      return { ...out, backend: 'local' };
    }
  }

  return {
    ok: false,
    code: 'sandbox_no_backend',
    message: 'no sandbox backend is enabled (set E2B_API_KEY or LOCAL_SANDBOX_ENABLED=1)',
    backend: 'none',
  };
}

module.exports = {
  executeCode,
  describeBackends,
  readPreference,
};
