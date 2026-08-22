'use strict';

/**
 * Feature flags for the Grok-bot-style agent-computer microservice.
 *
 * NEXT_PUBLIC_AGENT_COMPUTER / SIRAGPT_AGENT_COMPUTER must be *explicitly*
 * 1/true/on to mount ComputerViewer and expose /api/agent-computer.
 *
 * This is stricter than F7 multimodal `computerEnabled()` (which defaults
 * ON outside NODE_ENV=test). Existing Selkies/PNG department panes stay
 * unchanged when the flag is unset or off.
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

function cdpDefaultEnabled(env = process.env) {
  const explicit = parseSwitch(env.COMPUTER_CDP_DEFAULT);
  if (explicit !== null) return explicit;
  return true;
}

const DEEPSEEK_FLASH = 'deepseek-v4-flash';
const DEEPSEEK_PRO = 'deepseek-v4-pro';

function resolveComputerModel(hint, env = process.env) {
  const raw = String(hint || env.COMPUTER_MODEL || DEEPSEEK_FLASH).trim().toLowerCase();
  if (!raw) return DEEPSEEK_FLASH;
  if (raw.includes('pro')) return DEEPSEEK_PRO;
  return DEEPSEEK_FLASH;
}

/**
 * DeepSeek V4 Flash/Pro on this stack do not accept image parts unless the
 * operator explicitly lists the model in COMPUTER_VISION_MODELS.
 */
function modelAcceptsImages(model, env = process.env) {
  const allow = String(env.COMPUTER_VISION_MODELS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(String(model || '').trim().toLowerCase());
}

function resolveObservationMode({ cdpMode, model, env = process.env } = {}) {
  const resolvedModel = resolveComputerModel(model, env);
  if (cdpMode === true) return 'cdp';
  if (cdpMode === false && modelAcceptsImages(resolvedModel, env)) return 'screenshot';
  if (!modelAcceptsImages(resolvedModel, env)) return 'cdp';
  if (cdpDefaultEnabled(env)) return 'cdp';
  return 'screenshot';
}

module.exports = {
  parseSwitch,
  agentComputerEnabled,
  cdpDefaultEnabled,
  resolveComputerModel,
  modelAcceptsImages,
  resolveObservationMode,
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
};
