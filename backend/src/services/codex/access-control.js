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

function canUseCodexAgent(user, env = process.env) {
  if (!user) return false;
  if (user.isSuperAdmin || user.isAdmin) return true;
  const ids = parseAllowlist(env);
  if (ids.length === 0) return false;
  return ids.includes(String(user.id));
}

function publicAccess(user, env = process.env) {
  return {
    canRun: canUseCodexAgent(user, env),
    allowlistConfigured: parseAllowlist(env).length > 0,
  };
}

module.exports = { canUseCodexAgent, publicAccess, parseAllowlist };
