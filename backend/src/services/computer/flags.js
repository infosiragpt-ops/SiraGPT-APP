'use strict';

/**
 * Flags for the per-member persistent Linux desktop.
 *
 * Public viewer host is computer.siragpt.com — never computer.chatagic.com.
 * DeepSeek only; OpenRouter model ids are rejected.
 * Sessions are always-on per member (no idle destroy TTL).
 */

function parseSwitch(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return null;
}

function agentComputerEnabled(env = process.env) {
  const next = parseSwitch(env.NEXT_PUBLIC_AGENT_COMPUTER);
  if (next !== null) return next;
  const server = parseSwitch(env.SIRAGPT_AGENT_COMPUTER);
  return server === true;
}

const PUBLIC_HOST = 'computer.siragpt.com';
const DEEPSEEK_FLASH = 'deepseek-v4-flash';
const DEEPSEEK_PRO = 'deepseek-v4-pro';
const MAX_CONTROL_STEPS = 25;
const REPEAT_ACTION_LIMIT = 3;

function publicComputerHost(env = process.env) {
  const raw = String(env.COMPUTER_PUBLIC_HOST || PUBLIC_HOST).trim().toLowerCase();
  if (!raw || raw.includes('chatagic')) return PUBLIC_HOST;
  return raw;
}

function resolveComputerModel(hint, env = process.env) {
  const raw = String(hint || env.COMPUTER_MODEL || DEEPSEEK_FLASH).trim().toLowerCase();
  if (!raw || raw.includes('openrouter') || raw.includes('anthropic') || raw.includes('gpt-')) {
    return DEEPSEEK_FLASH;
  }
  if (raw.includes('pro')) return DEEPSEEK_PRO;
  return DEEPSEEK_FLASH;
}

/**
 * DeepSeek Flash/Pro do not accept image parts unless the operator lists
 * the model in COMPUTER_VISION_MODELS. Default is no vision → CDP tree.
 */
function modelAcceptsImages(model, env = process.env) {
  const allow = String(env.COMPUTER_VISION_MODELS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(String(model || '').trim().toLowerCase());
}

function resolveObservationMode({ cdpMode, model, env = process.env } = {}) {
  const resolved = resolveComputerModel(model, env);
  if (cdpMode === true) return 'cdp';
  if (cdpMode === false && modelAcceptsImages(resolved, env)) return 'screenshot';
  if (!modelAcceptsImages(resolved, env)) return 'cdp';
  return 'cdp';
}

module.exports = {
  parseSwitch,
  agentComputerEnabled,
  publicComputerHost,
  resolveComputerModel,
  modelAcceptsImages,
  resolveObservationMode,
  PUBLIC_HOST,
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  MAX_CONTROL_STEPS,
  REPEAT_ACTION_LIMIT,
};
