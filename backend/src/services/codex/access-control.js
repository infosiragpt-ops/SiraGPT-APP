'use strict';

/**
 * Codex Agent V2 access gate.
 *
 * Running generated code in production is high-trust. The feature flag decides
 * whether the subsystem exists; this gate decides who may create projects,
 * create/cancel runs, and start/export previews.
 */

function parseAllowlist(env = process.env) {
  return String(env.CODEX_AGENT_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ISOLATED_RUNNER_MODES = new Set([
  'sandbox',
  'opensandbox',
  'kubernetes',
  'gvisor',
  'kata',
  'microvm',
  'e2b',
]);

/**
 * Public multi-tenant execution is only safe when each workspace is backed by
 * an actual isolation boundary. A shared process/container is still useful for
 * trusted canaries, but CODEX_AGENT_OPEN_TO_ALL must never turn it into a
 * public remote-code-execution service by itself.
 */
function multiTenantIsolationReady(env = process.env) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') return true;
  const mode = String(env.CODEX_RUNNER_ISOLATION_MODE || '').trim().toLowerCase();
  return ISOLATED_RUNNER_MODES.has(mode);
}

function openToAllRequested(env = process.env) {
  const v = String(env.CODEX_AGENT_OPEN_TO_ALL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// Effective public access: the operator must request it AND production must
// advertise a real sandbox provider. Default off — reversible without deploy.
function openToAll(env = process.env) {
  return openToAllRequested(env) && multiTenantIsolationReady(env);
}

function canUseCodexAgent(user, env = process.env) {
  if (!user) return false;
  if (openToAll(env)) return true;
  if (user.isSuperAdmin || user.isAdmin) return true;
  const ids = parseAllowlist(env);
  if (ids.length === 0) return false;
  return ids.includes(String(user.id));
}

function publicAccess(user, env = process.env) {
  return {
    canRun: canUseCodexAgent(user, env),
    allowlistConfigured: parseAllowlist(env).length > 0 || openToAll(env),
  };
}

module.exports = {
  canUseCodexAgent,
  publicAccess,
  parseAllowlist,
  openToAll,
  openToAllRequested,
  multiTenantIsolationReady,
  ISOLATED_RUNNER_MODES,
};
