'use strict';

/**
 * cerebras-client — thin factory around the OpenAI SDK pointing at the
 * Cerebras Cloud inference endpoint (`api.cerebras.ai/v1`).
 *
 * Cerebras is OpenAI-API compatible for `chat.completions` (streaming +
 * non-streaming), so we can reuse the same client surface every other
 * provider in this codebase uses (Gemini, OpenRouter, DeepSeek). The
 * adapter exists so route code does not have to remember the base URL or
 * env key, and so a single place owns the "is Free IA available?" check.
 *
 * The user-facing brand is "Free IA" (per the product spec in the
 * /Users/luis/Downloads/SIraGPT.docx product brief). The default model
 * is `llama-3.1-8b` — Cerebras's fastest free-tier Llama 3.1 SKU.
 *
 * Env vars (all optional):
 *   CEREBRAS_API_KEY        — required to actually make calls. When
 *                             missing, `isFreeIaConfigured()` returns
 *                             false and `createCerebrasClient()` returns
 *                             null so callers can degrade gracefully.
 *   CEREBRAS_BASE_URL       — override the base URL (default
 *                             https://api.cerebras.ai/v1).
 *   FREE_IA_MODEL_ID        — override the model name reported by the
 *                             helper (default `llama-3.1-8b`).
 *   FREE_IA_DISPLAY_NAME    — UI label shown in the model picker
 *                             (default `Free IA`).
 *
 * Public API:
 *   getCerebrasConfig({ env }) → { enabled, apiKey, baseURL, model, displayName, reason }
 *   isFreeIaConfigured({ env }) → boolean
 *   createCerebrasClient({ env, OpenAICtor? }) → OpenAI client | null
 *   buildFreeIaModelDescriptor({ env }) → { name, provider, displayName, ... }
 */

const DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';
const DEFAULT_MODEL = 'llama-3.1-8b';
const DEFAULT_DISPLAY_NAME = 'Free IA';
const PROVIDER_NAME = 'Cerebras';

let _OpenAICtor = null;
function loadOpenAI() {
  if (_OpenAICtor) return _OpenAICtor;
  // eslint-disable-next-line global-require
  _OpenAICtor = require('openai');
  return _OpenAICtor;
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getCerebrasConfig({ env = process.env } = {}) {
  const apiKey = cleanString(env.CEREBRAS_API_KEY);
  const baseURL = cleanString(env.CEREBRAS_BASE_URL) || DEFAULT_BASE_URL;
  const model = cleanString(env.FREE_IA_MODEL_ID) || DEFAULT_MODEL;
  const displayName = cleanString(env.FREE_IA_DISPLAY_NAME) || DEFAULT_DISPLAY_NAME;

  if (!apiKey) {
    return {
      enabled: false,
      apiKey: '',
      baseURL,
      model,
      displayName,
      provider: PROVIDER_NAME,
      reason: 'no_api_key',
    };
  }

  let parsedBaseURL;
  try {
    parsedBaseURL = new URL(baseURL).toString().replace(/\/+$/, '');
  } catch (_err) {
    return {
      enabled: false,
      apiKey,
      baseURL,
      model,
      displayName,
      provider: PROVIDER_NAME,
      reason: 'invalid_base_url',
    };
  }

  return {
    enabled: true,
    apiKey,
    baseURL: parsedBaseURL,
    model,
    displayName,
    provider: PROVIDER_NAME,
    reason: 'ok',
  };
}

function isFreeIaConfigured({ env = process.env } = {}) {
  return getCerebrasConfig({ env }).enabled;
}

function createCerebrasClient({ env = process.env, OpenAICtor } = {}) {
  const cfg = getCerebrasConfig({ env });
  if (!cfg.enabled) return null;
  const Ctor = OpenAICtor || loadOpenAI();
  return new Ctor({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
}

/**
 * Build the descriptor used by /api/ai/models (and the model picker) for
 * the Free IA entry. Safe to call even when Cerebras isn't configured —
 * the caller decides whether to surface the entry based on `enabled`.
 */
function buildFreeIaModelDescriptor({ env = process.env } = {}) {
  const cfg = getCerebrasConfig({ env });
  return {
    id: `__virtual_${cfg.model.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}__`,
    name: cfg.model,
    displayName: cfg.displayName,
    provider: cfg.provider,
    description: 'Modelo gratuito SiraGPT (Cerebras Llama 3.1 8B) — usado como fallback cuando el plan se agota.',
    type: 'TEXT',
    icon: 'CerebrasLogo',
    virtual: true,
    enabled: cfg.enabled,
  };
}

module.exports = {
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_DISPLAY_NAME,
  getCerebrasConfig,
  isFreeIaConfigured,
  createCerebrasClient,
  buildFreeIaModelDescriptor,
};
