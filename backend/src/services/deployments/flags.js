'use strict';

/**
 * deployments/flags — feature flag DEPLOYMENTS_V2.
 * Flag off ⇒ /api/deployments/* responde 404 (salvo /health, que SIEMPRE es 200
 * y reporta { ok, enabled } para que el frontend decida si monta el módulo).
 *
 * Override runtime (SystemSettings vía services/flags/runtime-overrides) gana
 * sobre el env: kill-switch sin redeploy.
 */

const { wrapIsEnabled } = require('../flags/runtime-overrides');

function isDeploymentsEnabledBase(env = process.env) {
  const v = String(env.DEPLOYMENTS_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const isDeploymentsEnabled = wrapIsEnabled('DEPLOYMENTS_V2', isDeploymentsEnabledBase);

module.exports = { isDeploymentsEnabled, isDeploymentsEnabledBase };
