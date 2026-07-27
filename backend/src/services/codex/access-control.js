'use strict';

/**
 * Codex Agent V2 access gate.
 *
 * Running generated code in production is high-trust. The feature flag decides
 * whether the subsystem exists; this gate decides who may create projects,
 * create/cancel runs, and start/export previews.
 */

const { getSandboxRuntime } = require('./sandbox-provider');

function parseAllowlist(env = process.env) {
  return String(env.CODEX_AGENT_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Public multi-tenant execution is only safe when each workspace is backed by
 * an actual isolation boundary. A shared process/container is still useful for
 * trusted canaries, but CODEX_AGENT_OPEN_TO_ALL must never turn it into a
 * public remote-code-execution service by itself.
 */
function multiTenantIsolationReady(_env = process.env, runtime = getSandboxRuntime()) {
  const attestation = runtime?.attestation;
  return attestation?.isolation?.isolated === true
    && attestation.isolation.tenantScope === 'workspace'
    && attestation.capabilities?.publicMultiTenant === true;
}

function openToAllRequested(env = process.env) {
  const v = String(env.CODEX_AGENT_OPEN_TO_ALL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// Effective public access: the operator must request it AND the boot-selected
// provider must attest a real workspace boundary. Default off.
function openToAll(env = process.env, runtime = getSandboxRuntime()) {
  return openToAllRequested(env) && multiTenantIsolationReady(env, runtime);
}

function canUseCodexAgent(user, env = process.env, runtime = getSandboxRuntime()) {
  if (!user) return false;
  if (openToAll(env, runtime)) return true;
  if (user.isSuperAdmin || user.isAdmin) return true;
  const ids = parseAllowlist(env);
  if (ids.length === 0) return false;
  return ids.includes(String(user.id));
}

function publicAccess(user, env = process.env, runtime = getSandboxRuntime()) {
  return {
    canRun: canUseCodexAgent(user, env, runtime),
    allowlistConfigured: parseAllowlist(env).length > 0 || openToAll(env, runtime),
  };
}

module.exports = {
  canUseCodexAgent,
  publicAccess,
  parseAllowlist,
  openToAll,
  openToAllRequested,
  multiTenantIsolationReady,
};
