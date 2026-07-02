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

// When CODEX_AGENT_OPEN_TO_ALL is on, every AUTHENTICATED user may drive the
// agent (the /code chat is the product surface); the allowlist then only
// matters as documentation. Default off — reversible without a deploy.
function openToAll(env = process.env) {
  const v = String(env.CODEX_AGENT_OPEN_TO_ALL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
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

module.exports = { canUseCodexAgent, publicAccess, parseAllowlist, openToAll };
