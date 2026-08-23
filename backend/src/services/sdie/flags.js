'use strict';

/**
 * FEATURE_SDIE_V2 — SIRA Document Intelligence Engine v2.
 *
 * Flag style matches live FEATURE_* gates (FEATURE_DOC_ENGINE=1,
 * deployments/flags.js, codex/flags.js):
 *   v === '1' || v === 'true' || v === 'on'
 *
 * Unset defaults ON so the screenshot regression is fixed on deploy
 * (production has FEATURE_DOC_ENGINE=1 but no FEATURE_SDIE* yet).
 * Operators disable with FEATURE_SDIE_V2=0.
 *
 * FEATURE_DOC_ENGINE (OOXML transformToTemplate / source-preserving edit)
 * stays on its own path. SDIE never claims mutation/transform turns.
 */

const FLAG_NAME = 'FEATURE_SDIE_V2';
const DOC_ENGINE_FLAG = 'FEATURE_DOC_ENGINE';

function truthyFlag(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function isSdieV2Enabled(env = process.env) {
  const raw = env[FLAG_NAME];
  if (raw == null || raw === '') return true;
  return truthyFlag(raw);
}

/**
 * Existing OOXML / Word-transform engine. Unset treated as on so this
 * module never disables the live FEATURE_DOC_ENGINE=1 path.
 */
function isDocEngineEnabled(env = process.env) {
  const raw = env[DOC_ENGINE_FLAG];
  if (raw == null || raw === '') return true;
  return truthyFlag(raw);
}

function parseFlag(raw, defaultOn) {
  if (raw == null || raw === '') return defaultOn;
  return truthyFlag(raw);
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
  truthyFlag,
};
