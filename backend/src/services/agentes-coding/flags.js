'use strict';

/**
 * agentes-coding/flags — feature flag AGENTES_CODING_V2
 * (docs/agentes-arquitectura.md §10, docs/oss-catalog.md).
 *
 * Default OFF in every environment, including production. Flag off ⇒
 * GET /api/agentes-coding/health still returns 200 with enabled:false
 * and every other /api/agentes-coding/* path is 404. Default /agentes
 * UX must not change (UI-lock).
 */

const FLAG = 'AGENTES_CODING_V2';

function isAgentesCodingV2Enabled(env = process.env) {
  // Only DEV adapters exist today. Production requires a reviewed isolated
  // provider and acceptance; an environment toggle cannot certify either.
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  const v = String(env.AGENTES_CODING_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

module.exports = { isAgentesCodingV2Enabled, FLAG };
