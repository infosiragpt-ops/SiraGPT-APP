'use strict';

/**
 * deployments/flags — feature flag DEPLOYMENTS_V2.
 * Flag off ⇒ /api/deployments/* responde 404 (salvo /health, que SIEMPRE es 200
 * y reporta { ok, enabled } para que el frontend decida si monta el módulo).
 */

function isDeploymentsEnabled(env = process.env) {
  const v = String(env.DEPLOYMENTS_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

module.exports = { isDeploymentsEnabled };
