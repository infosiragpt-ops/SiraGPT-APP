'use strict';

const MODES = Object.freeze({
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
});

const VALID_MODES = new Set(Object.values(MODES));

class RbacConfigurationError extends Error {
  constructor(code = 'RBAC_ENFORCEMENT_MODE_INVALID') {
    super(code);
    this.name = 'RbacConfigurationError';
    this.code = code;
  }
}

function resolveRbacEnforcementMode(env = process.env) {
  const configured = typeof env?.RBAC_ENFORCEMENT_MODE === 'string'
    ? env.RBAC_ENFORCEMENT_MODE.trim().toLowerCase()
    : '';
  if (!configured) {
    return env?.NODE_ENV === 'production' ? MODES.ENFORCE : MODES.SHADOW;
  }
  if (!VALID_MODES.has(configured)) {
    if (env?.NODE_ENV === 'production') throw new RbacConfigurationError();
    return MODES.SHADOW;
  }
  return configured;
}

module.exports = {
  MODES,
  VALID_MODES,
  RbacConfigurationError,
  resolveRbacEnforcementMode,
};
