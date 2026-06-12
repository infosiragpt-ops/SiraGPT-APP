'use strict';

/**
 * codex/flags — feature flag CODEX_AGENT_V2 (spec docs/codex-agent-ux.md §10).
 * Flag off ⇒ /api/codex/* responde 404 (salvo /health) y el worker no se registra.
 */

function isCodexV2Enabled(env = process.env) {
  const v = String(env.CODEX_AGENT_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

module.exports = { isCodexV2Enabled };
