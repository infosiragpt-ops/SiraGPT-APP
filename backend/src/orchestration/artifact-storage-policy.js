'use strict';

const { enabled: r2Enabled } = require('./r2-storage');

/**
 * Production policy: large agent artifacts should use R2 when configured.
 */
function requireDurableArtifactStorage(env = process.env) {
  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const force = env.SIRAGPT_REQUIRE_R2_ARTIFACTS === '1';
  if (!isProd && !force) {
    return { ok: true, mode: 'local', required: false };
  }
  if (r2Enabled(env)) {
    return { ok: true, mode: 'r2', required: true };
  }
  return {
    ok: false,
    mode: 'missing_r2',
    required: true,
    error: 'R2 artifact storage is required in production (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)',
  };
}

function assertArtifactStorageReady(env = process.env) {
  const policy = requireDurableArtifactStorage(env);
  if (!policy.ok) {
    const err = new Error(policy.error);
    err.code = 'ARTIFACT_STORAGE_NOT_CONFIGURED';
    throw err;
  }
  return policy;
}

module.exports = {
  requireDurableArtifactStorage,
  assertArtifactStorageReady,
};
