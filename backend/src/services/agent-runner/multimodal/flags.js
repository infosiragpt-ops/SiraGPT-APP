'use strict';

/**
 * F7 — Multimodal kill switches.
 *
 * SIRAGPT_AGENT_VISION / SIRAGPT_AGENT_VOICE / SIRAGPT_AGENT_COMPUTER:
 *   - an explicit value always wins (1/true/on vs 0/false/off);
 *   - unset → ON in production/dev, OFF under NODE_ENV=test so the
 *     existing F1–F5 suites never grow surprise tools.
 */

function parseSwitch(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return null;
}

function f7FlagEnabled(name, env = process.env) {
  const explicit = parseSwitch(env[name]);
  if (explicit !== null) return explicit;
  return env.NODE_ENV !== 'test';
}

function visionEnabled(env = process.env) {
  return f7FlagEnabled('SIRAGPT_AGENT_VISION', env);
}

function voiceEnabled(env = process.env) {
  return f7FlagEnabled('SIRAGPT_AGENT_VOICE', env);
}

function computerEnabled(env = process.env) {
  return f7FlagEnabled('SIRAGPT_AGENT_COMPUTER', env);
}

module.exports = {
  f7FlagEnabled,
  visionEnabled,
  voiceEnabled,
  computerEnabled,
};
