'use strict';

/**
 * codex/flags — feature flag CODEX_AGENT_V2 (spec docs/codex-agent-ux.md §10).
 * Flag off ⇒ /api/codex/* responde 404 (salvo /health) y el worker no se registra.
 *
 * El check base lee env (build/restart); un override runtime persistido en
 * SystemSettings (services/flags/runtime-overrides) gana sobre el env para
 * poder apagar/encender sin redeploy durante un incidente.
 */

const { wrapIsEnabled } = require('../flags/runtime-overrides');

function isCodexV2EnabledBase(env = process.env) {
  const v = String(env.CODEX_AGENT_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const isCodexV2Enabled = wrapIsEnabled('CODEX_AGENT_V2', isCodexV2EnabledBase);

module.exports = { isCodexV2Enabled, isCodexV2EnabledBase };
