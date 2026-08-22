'use strict';

/**
 * FEATURE_SDIE_V2 — SIRA Document Intelligence Engine v2.
 *
 * When enabled, /chat and /code document+summary turns compile a RequestSpec
 * and walk the full document instead of top-k RAG + free-form LLM.
 *
 * FEATURE_DOC_ENGINE (OOXML transformToTemplate / source-preserving edit)
 * stays on its own path. SDIE never claims mutation/transform turns.
 */

const FLAG_NAME = 'FEATURE_SDIE_V2';
const DOC_ENGINE_FLAG = 'FEATURE_DOC_ENGINE';

function parseFlag(raw, defaultOn) {
  if (raw == null || raw === '') return defaultOn;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return defaultOn;
}

/**
 * Default ON so the screenshot regression is fixed once the flag is
 * deployed. Operators can disable with FEATURE_SDIE_V2=0.
 */
function isSdieV2Enabled(env = process.env) {
  return parseFlag(env[FLAG_NAME], true);
}

/**
 * Existing OOXML / Word-transform engine. SDIE must not steal those turns.
 * Honours FEATURE_DOC_ENGINE when set; otherwise the live edit detectors
 * (isDocumentEditRequest) remain the authority.
 */
function isDocEngineEnabled(env = process.env) {
  return parseFlag(env[DOC_ENGINE_FLAG], true);
}

function envFlagEnabled(raw, defaultOn = false) {
  return parseFlag(raw, defaultOn);
}

module.exports = {
  FLAG_NAME,
  DOC_ENGINE_FLAG,
  isSdieV2Enabled,
  isDocEngineEnabled,
  envFlagEnabled,
  parseFlag,
};
