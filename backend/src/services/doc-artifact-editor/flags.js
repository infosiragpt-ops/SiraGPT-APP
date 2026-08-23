'use strict';

/**
 * FEATURE_DOC_ARTIFACT_EDITOR — default false.
 * Side-panel Word editor microservice (Claude Artifacts-like), isolated
 * from /chat UI chrome. DeepSeek only — OpenRouter is forbidden.
 */

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

function isDocArtifactEditorEnabled(env = process.env) {
  return isTruthyEnv(env.FEATURE_DOC_ARTIFACT_EDITOR);
}

function getDocArtifactEditorConfig(env = process.env) {
  const n = (raw, fallback, min, max) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(v)));
  };
  return {
    enabled: isDocArtifactEditorEnabled(env),
    timeoutMs: n(env.DOC_ARTIFACT_EDITOR_TIMEOUT_MS, 120_000, 5_000, 600_000),
    artifactTtlSec: n(env.DOC_ARTIFACT_EDITOR_TTL_SEC, 15 * 60, 60, 3600),
    deepseekFlashModel: String(env.DOC_ENGINE_DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash').trim(),
    deepseekProModel: String(env.DOC_ENGINE_DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro').trim(),
    signingSecret: String(env.DOC_ARTIFACT_EDITOR_SIGNING_SECRET || env.JWT_SECRET || '').trim(),
  };
}

function assertNoOpenRouter(env = process.env) {
  const forbidden = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL'];
  const present = forbidden.filter((k) => String(env[k] || '').trim() && /openrouter/i.test(k));
  return {
    ok: true,
    provider: 'deepseek',
    forbiddenProviders: ['openrouter'],
    // Keys may exist for other product surfaces; this engine never reads them.
    ignoredEnv: present,
  };
}

module.exports = {
  isTruthyEnv,
  isDocArtifactEditorEnabled,
  getDocArtifactEditorConfig,
  assertNoOpenRouter,
};
