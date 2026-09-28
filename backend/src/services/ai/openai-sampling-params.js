'use strict';

/**
 * openai-sampling-params — keep OpenAI first-party payloads free of sampling
 * knobs the model rejects.
 *
 * Prod 2026-09-27: `OpenAI:gpt-6-sol attempt 1/2 failed (bad_request): 400
 * Unsupported value: 'temperature' does not support 0.55 with this model.
 * Only the default (1) value is supported.` Reasoning-class models (o1/o3/o4,
 * gpt-5*, gpt-6*) accept only their default temperature/top_p and reject
 * presence/frequency penalties. Two layers:
 *
 *   1. `stripUnsupportedSampling(model, payload)` — omit the knobs up front for
 *      the known families (and for any model this process already saw reject
 *      a parameter).
 *   2. `unsupportedSamplingParamFromError(err)` + `rememberUnsupported` — the
 *      generic guard: a 400 «Unsupported value: 'temperature'» is retried ONCE
 *      without the offending parameter and the model is memoised so later
 *      calls skip it without a round-trip.
 *
 * `wrapOpenAIChatClient(client)` applies both to an OpenAI SDK client whose
 * transport is api.openai.com (never OpenRouter, where `openai/gpt-6-sol`
 * keeps `temperature`).
 */

const SAMPLING_PARAMS = Object.freeze(['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']);
const DEFAULT_ONLY_RE = /^(?:gpt-6|gpt-5|o1|o3|o4)(?:$|[-_.\d])/i;
const UNSUPPORTED_VALUE_RE = /Unsupported (?:value|parameter):?\s*'?(temperature|top_p|presence_penalty|frequency_penalty)'?/i;

// model (lowercase, provider prefix stripped) → Set<param>
const remembered = new Map();

function normalizeModel(model) {
  return String(model || '').trim().replace(/^openai\//i, '').toLowerCase();
}

/** True for OpenAI models that only accept their default sampling values. */
function isDefaultTemperatureOnlyModel(model) {
  const name = normalizeModel(model);
  if (!name) return false;
  return DEFAULT_ONLY_RE.test(name);
}

function rememberUnsupported(model, param) {
  const name = normalizeModel(model);
  const key = String(param || '').trim().toLowerCase();
  if (!name || !SAMPLING_PARAMS.includes(key)) return false;
  if (!remembered.has(name)) remembered.set(name, new Set());
  remembered.get(name).add(key);
  return true;
}

function rememberedUnsupported(model) {
  const set = remembered.get(normalizeModel(model));
  return set ? [...set] : [];
}

/**
 * Parameter name a provider 400 complains about, or null. Only the sampling
 * knobs this module manages — a `reasoning_effort` complaint stays with its
 * own guard in ai-service.
 */
function unsupportedSamplingParamFromError(err) {
  if (!err) return null;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status) || 0);
  if (status && status !== 400) return null;
  const nested = err.error && typeof err.error === 'object' ? String(err.error.message || '') : '';
  const text = `${err.message || ''} ${nested}`;
  const match = UNSUPPORTED_VALUE_RE.exec(text);
  if (!match) return null;
  const param = match[1].toLowerCase();
  // "Only the default (1) value is supported" / "does not support 0.55" are
  // the shapes OpenAI uses; a plain "Unsupported value" on another field
  // never matches because the regex names the parameter.
  return SAMPLING_PARAMS.includes(param) ? param : null;
}

/**
 * Remove sampling parameters the model rejects. Mutates and returns
 * `payload`; `payload.__strippedSampling` is never set — callers that need
 * the list use `samplingParamsToStrip`.
 */
function samplingParamsToStrip(model, payload) {
  if (!payload || typeof payload !== 'object') return [];
  const defaultOnly = isDefaultTemperatureOnlyModel(model);
  const memo = new Set(rememberedUnsupported(model));
  const out = [];
  for (const param of SAMPLING_PARAMS) {
    if (!Object.prototype.hasOwnProperty.call(payload, param)) continue;
    if (defaultOnly || memo.has(param)) out.push(param);
  }
  return out;
}

function stripUnsupportedSampling(model, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  for (const param of samplingParamsToStrip(model, payload)) delete payload[param];
  return payload;
}

/**
 * Wrap `client.chat.completions.create` so every OpenAI first-party call
 * strips the known-unsupported knobs and retries once (without the named
 * parameter) on «Unsupported value: 'temperature'». Idempotent; returns the
 * same client. Streaming and non-streaming calls behave the same because the
 * 400 is raised before the first byte.
 */
function wrapOpenAIChatClient(client, { provider = 'OpenAI', log = console } = {}) {
  const completions = client && client.chat && client.chat.completions;
  if (!completions || typeof completions.create !== 'function') return client;
  if (completions.__siraSamplingGuard) return client;
  const original = completions.create.bind(completions);
  const guarded = async function create(params, options) {
    const payload = params && typeof params === 'object' ? { ...params } : params;
    if (payload && typeof payload === 'object') stripUnsupportedSampling(payload.model, payload);
    try {
      return await original(payload, options);
    } catch (err) {
      const param = payload && typeof payload === 'object' ? unsupportedSamplingParamFromError(err) : null;
      if (!param || !Object.prototype.hasOwnProperty.call(payload, param)) throw err;
      rememberUnsupported(payload.model, param);
      try {
        log.warn(`[openai-sampling] ${provider}:${payload.model} rejected '${param}' (${String(err.message || '').slice(0, 120)}); retrying without it and memoising the model`);
      } catch (_) { /* logging is advisory */ }
      const retry = { ...payload };
      stripUnsupportedSampling(retry.model, retry);
      delete retry[param];
      return original(retry, options);
    }
  };
  try {
    Object.defineProperty(completions, 'create', { value: guarded, writable: true, configurable: true });
    Object.defineProperty(completions, '__siraSamplingGuard', { value: true, configurable: true });
  } catch (_) {
    return client;
  }
  return client;
}

function __resetForTests() { remembered.clear(); }

module.exports = {
  SAMPLING_PARAMS,
  isDefaultTemperatureOnlyModel,
  rememberUnsupported,
  rememberedUnsupported,
  samplingParamsToStrip,
  stripUnsupportedSampling,
  unsupportedSamplingParamFromError,
  wrapOpenAIChatClient,
  __resetForTests,
};
