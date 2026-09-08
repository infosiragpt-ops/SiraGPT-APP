'use strict';

/**
 * agentes-coding/flags — feature flag AGENTES_CODING_V2 (spec
 * docs/agentes-arquitectura.md §Despliegue).
 * Flag off ⇒ /api/agentes-coding/* responde 404 (salvo /health) y ningún
 * worker/sandbox se provisiona. Mismo contrato que CODEX_AGENT_V2.
 */

function isAgentesCodingV2Enabled(env = process.env) {
  const v = String(env.AGENTES_CODING_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

module.exports = { isAgentesCodingV2Enabled };
