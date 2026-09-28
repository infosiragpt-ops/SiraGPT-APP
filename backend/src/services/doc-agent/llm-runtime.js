'use strict';

/**
 * LLM runtime for the document agent — which OpenAI-compatible provider runs
 * the tool-calling loop, and per-call failover between them.
 *
 * Production reality (2026-09-02): the loop was hard-wired to OpenRouter, so an
 * exhausted OpenRouter balance (HTTP 402) killed every Word/Excel/PPT edit even
 * though DeepSeek, Meta (Muse Spark), Gemini and xAI were all configured and
 * all accept native tool calls. This module builds an ordered candidate list
 * (explicit model first, then every configured provider of the ladder) and a
 * client wrapper that retries the SAME payload on the next candidate when a
 * provider fails with a transport/quota/auth error. The OpenAI tool-calling
 * wire format is shared by all of them, so a run can switch providers between
 * iterations without losing the tool-call history.
 *
 * Every provider failure feeds the shared funding memo (billing-failover /
 * provider-key-health) before it is rotated or rethrown: the picker shows
 * «Sin saldo» for an empty account, and ladders start at a funded provider.
 */

const billing = require('../ai/billing-failover');
const keyHealth = require('../../utils/provider-key-health');

const LADDER = Object.freeze([
  // DeepSeek native: V4 pro by default for document quality (AGENT_PRO_MODEL /
  // SIRAGPT_DOC_AGENT_DEEPSEEK_MODEL override); every V4 id accepts tool calls.
  { provider: 'DeepSeek', model: 'deepseek-v4-pro', keys: ['DEEPSEEK_API_KEY'], baseURL: 'https://api.deepseek.com/v1', modelEnv: ['SIRAGPT_DOC_AGENT_DEEPSEEK_MODEL', 'AGENT_PRO_MODEL'] },
  { provider: 'Meta', model: 'muse-spark-1.2', keys: ['MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY'], baseURL: 'https://api.meta.ai/v1', extra: { reasoning_effort: 'minimal' } },
  { provider: 'Gemini', model: 'gemini-3.5-flash', keys: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  { provider: 'xAI', model: 'grok-4.5', keys: ['XAI_API_KEY'], baseURL: 'https://api.x.ai/v1' },
  { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro', keys: ['OPENROUTER_API_KEY'], baseURL: null },
  { provider: 'OpenAI', model: 'gpt-5.6-sol', keys: ['OPENAI_API_KEY'], baseURL: 'https://api.openai.com/v1' },
]);

const PROVIDER_ALIASES = Object.freeze({
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  llama: 'Meta',
  gemini: 'Gemini',
  google: 'Gemini',
  xai: 'xAI',
  grok: 'xAI',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
});

function ladderEntry(provider) {
  return LADDER.find((e) => e.provider === provider) || null;
}

/** Provider implied by a bare model id (mirrors the chat router's conventions). */
function inferProvider(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return null;
  if (m.includes('/')) return 'OpenRouter';
  if (/^deepseek-/.test(m)) return 'DeepSeek';
  if (/^(muse-|llama-4)/.test(m)) return 'Meta';
  if (/^gemini-/.test(m)) return 'Gemini';
  if (/^grok-/.test(m)) return 'xAI';
  if (/^(gpt-|o[0-9])/.test(m)) return 'OpenAI';
  return null;
}

/** "Provider:model" or a bare model id → { provider, model } (provider may be null). */
function parseModelSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx > 0 && idx < 24 && !raw.slice(0, idx).includes('/')) {
    const alias = raw.slice(0, idx).trim().toLowerCase();
    const provider = PROVIDER_ALIASES[alias] || null;
    const model = raw.slice(idx + 1).trim();
    if (provider && model) return { provider, model };
  }
  return { provider: inferProvider(raw), model: raw };
}

// CI / local placeholders must not count as a configured provider (the
// agent runner used to refuse OpenRouter dummy keys the same way).
const PLACEHOLDER_KEY_RE = /dummy|not-used|ci-dummy|test-key|^your_|^sk-xxx|^changeme$/i;

function keyFor(entry, env) {
  for (const name of entry.keys) {
    const value = env && env[name];
    if (value && String(value).trim() && !PLACEHOLDER_KEY_RE.test(String(value).trim())) return String(value).trim();
  }
  return null;
}

function defaultModelFor(entry, env) {
  for (const name of entry.modelEnv || []) {
    const value = env && env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return entry.model;
}

/**
 * Ordered candidates: the explicit model (caller arg, else
 * SIRAGPT_DOC_AGENT_MODEL) on its provider first, then the ladder — only
 * providers with a configured key. Each candidate: { provider, model, apiKey,
 * baseURL, extra, headers }.
 */
function resolveDocAgentCandidates({ model, env = process.env } = {}) {
  const out = [];
  const seen = new Set();
  const push = (entry, chosenModel) => {
    if (!entry || seen.has(entry.provider)) return;
    const apiKey = keyFor(entry, env);
    if (!apiKey) return;
    seen.add(entry.provider);
    const baseURL = entry.provider === 'OpenRouter'
      ? ((env && env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1')
      : entry.baseURL;
    out.push({
      provider: entry.provider,
      model: chosenModel || defaultModelFor(entry, env),
      apiKey,
      baseURL,
      extra: entry.extra || null,
      headers: entry.provider === 'OpenRouter'
        ? { 'HTTP-Referer': (env && env.OPENROUTER_SITE_URL) || 'https://siragpt.app', 'X-Title': 'SiraGPT Document Agent' }
        : null,
    });
  };
  const explicit = parseModelSpec(model || (env && env.SIRAGPT_DOC_AGENT_MODEL));
  if (explicit && explicit.model) push(ladderEntry(explicit.provider || 'OpenRouter'), explicit.model);
  const pinned = out.length;
  for (const entry of LADDER) push(entry, null);
  // Ladder rungs known to be unfunded (or with a rejected key) go last, in
  // their original order: a run starts on a provider that can answer. They
  // are never dropped, and the explicit model keeps its place.
  const ladder = out.slice(pinned);
  const unfunded = ladder.filter((c) => providerUnfunded(c.provider, env));
  if (!unfunded.length) return out;
  return [...out.slice(0, pinned), ...ladder.filter((c) => !unfunded.includes(c)), ...unfunded];
}

function providerUnfunded(provider, env) {
  try { return Boolean(billing.isUnfunded(provider, env)); } catch (_) { return false; }
}

function resolveDocAgentRunCandidates({ model, env = process.env } = {}) {
  if (!String(model || '').trim()) return resolveDocAgentCandidates({ env });
  const raw = String(model).trim();
  // Picker rows can carry a provider-prefixed model id. A selected DeepSeek
  // row uses its own API; an explicit OpenRouter:model spec keeps the router.
  const direct = /^(deepseek|google|gemini|x-ai|xai|meta|openai)\/(.+)$/i.exec(raw);
  const provider = direct ? (PROVIDER_ALIASES[direct[1].toLowerCase().replace('-', '')] || null) : null;
  const spec = provider ? `${provider}:${direct[2]}` : raw;
  const selected = parseModelSpec(spec);
  const candidates = resolveDocAgentCandidates({ model: spec, env });
  // An unknown vendor/model slug must not become an implicit OpenRouter run.
  // The user can opt into that transport explicitly with OpenRouter:model.
  const implicitRouter = selected?.provider === 'OpenRouter' && !/^openrouter\s*:/i.test(raw);
  const match = implicitRouter ? null : candidates.find((candidate) => candidate.provider === selected?.provider && candidate.model === selected?.model);
  if (match) return [match];
  const error = new Error('El modelo seleccionado no está disponible. Reintenta o elige otro modelo.');
  error.code = 'E_PROVIDER';
  throw error;
}

function errorStatus(err) {
  if (!err) return null;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  return Number.isFinite(status) ? status : null;
}

/** Quota / auth / transport / server errors move to the next provider; model-side 400s do not. */
function isFailoverError(err) {
  const status = errorStatus(err);
  if (status !== null) {
    if ([401, 402, 403, 404, 408, 409, 425, 429].includes(status)) return true;
    return status >= 500;
  }
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /econn|enotfound|etimedout|eai_again|fetch failed|network|timed? ?out|socket hang up|aborted(?! by user)/.test(msg)
    && !/abort(ed)? by (user|caller)/.test(msg);
}

const SDK_MAX_RETRIES_DEFAULT = 1;
const LLM_TIMEOUT_MS_DEFAULT = 180_000;

// The loop's callModelWithRetry owns retries; SDK retries on top multiplied
// a permanent 429 into ~9 requests. 180 s fits an 8192-token document call.
function sdkMaxRetries(env = process.env) {
  const n = Number(env && env.SIRAGPT_DOC_AGENT_SDK_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.min(5, Math.floor(n)) : SDK_MAX_RETRIES_DEFAULT;
}

function llmTimeoutMs(env = process.env) {
  const n = Number(env && env.SIRAGPT_DOC_AGENT_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : LLM_TIMEOUT_MS_DEFAULT;
}

function defaultCreateClient(candidate, { anthropicSdkClient = null, env = process.env } = {}) {
  if (candidate.provider === 'Anthropic') {
    const { createAnthropicStreamingClient } = require('../ai/first-party-chat-clients');
    return createAnthropicStreamingClient({
      apiKey: candidate.apiKey,
      ...(anthropicSdkClient ? { sdkClient: anthropicSdkClient } : {}),
    });
  }
  // Lazy require: keeps this module loadable in tests without the SDK.
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: candidate.apiKey,
    baseURL: candidate.baseURL,
    maxRetries: sdkMaxRetries(env),
    timeout: llmTimeoutMs(env),
    ...(candidate.headers ? { defaultHeaders: candidate.headers } : {}),
  });
  if (candidate.provider !== 'OpenAI') return client;
  // GPT-5.x / o-series reject non-default sampling params; strip and retry.
  try {
    return require('../ai/openai-sampling-params').wrapOpenAIChatClient(client, { provider: 'OpenAI' });
  } catch (_) {
    return client;
  }
}

function payloadForCandidate(payload, candidate) {
  const provider = String(candidate.wireProvider || candidate.provider || '').toLowerCase();
  const request = { ...payload, model: candidate.model, ...(candidate.extra || {}) };
  // GPT-6 Sol/Luna accept Chat Completions function calls only at effort
  // "none". The document runner uses this API for its tool loop; preserve an
  // explicitly requested effort instead of silently replacing it.
  if (provider === 'openai'
    && /^gpt-6-(?:sol|luna)(?:-|$)/i.test(String(candidate.model || ''))
    && Array.isArray(request.tools) && request.tools.length > 0
    && !Object.prototype.hasOwnProperty.call(request, 'reasoning_effort')) {
    request.reasoning_effort = 'none';
  }
  if (Array.isArray(request.messages)) {
    request.messages = request.messages.map((message) => {
      if (!message || message.role !== 'assistant') return message;
      // The native Claude adapter keeps signed thinking/tool blocks in
      // non-enumerable properties on this exact assistant message object.
      if (provider === 'anthropic') return message;
      const hasReasoning = Object.prototype.hasOwnProperty.call(message, 'reasoning_content');
      if (provider === 'deepseek') {
        // Historical and synthetic tool turns were not produced by DeepSeek.
        // They still need the field when its thinking-mode request has tools.
        return hasReasoning || !Array.isArray(request.tools)
          ? message : { ...message, reasoning_content: '' };
      }
      if (!hasReasoning) return message;
      const { reasoning_content: _ignored, ...withoutReasoning } = message;
      return withoutReasoning;
    });
  }
  // A failover may change transports within one call. Adapt the token field
  // for the candidate that actually receives the payload, not the first one.
  if (provider === 'openai' && Object.prototype.hasOwnProperty.call(request, 'max_tokens')) {
    if (!Object.prototype.hasOwnProperty.call(request, 'max_completion_tokens')) request.max_completion_tokens = request.max_tokens;
    delete request.max_tokens;
  } else if (provider !== 'openai' && Object.prototype.hasOwnProperty.call(request, 'max_completion_tokens')) {
    if (!Object.prototype.hasOwnProperty.call(request, 'max_tokens')) request.max_tokens = request.max_completion_tokens;
    delete request.max_completion_tokens;
  }
  return request;
}

function isAbortLike(err, opts) {
  if (opts && opts.signal && opts.signal.aborted) return true;
  const name = String((err && err.name) || '');
  const code = String((err && err.code) || '');
  return name === 'AbortError' || name === 'APIUserAbortError' || code === 'ABORT_ERR';
}

function failureText(err) {
  if (!err) return '';
  const nested = err.error && typeof err.error === 'object' ? ` ${err.error.message || ''}` : '';
  return `${err.message || ''}${nested}`;
}

// «You requested up to N tokens, but can only afford M»: the account still
// has credit, only this reservation is too large. Memoising it would show
// «Sin saldo» for a provider that answers smaller requests. OpenRouter's
// wording carries both phrases («…or fewer max_tokens. … can only afford
// 12»), so the amount decides first; a tiny allowance is an empty account.
const AFFORDABLE_TOKENS_RE = /can only afford\s+(\d+)/i;
const RESERVATION_HINT_RE = /fewer max_tokens/i;
const MIN_USEFUL_AFFORDABLE_TOKENS = 1024;

function isReservationSizeError(err) {
  const text = failureText(err);
  const match = AFFORDABLE_TOKENS_RE.exec(text);
  if (match) return Number(match[1]) >= MIN_USEFUL_AFFORDABLE_TOKENS;
  return RESERVATION_HINT_RE.test(text);
}

// Same rule as the runner's retry policy (native-llm isNoCreditError):
// credit wording, never a quota window that reopens within the minute
// («limit: 10 per minute… retry in 29s» is a rate limit, not «Sin saldo»).
function isNoCreditFailure(err) {
  try {
    return require('../agent-runner/native-llm').isNoCreditError(err);
  } catch (_) {
    return billing.isBillingError(err);
  }
}

const INVALID_KEY_TEXT_RE = /invalid[_ ]api[_ ]key|incorrect api key|api key not valid/i;

/**
 * Content-free cause of a provider failure: 'billing' (empty account),
 * 'reservation' (credit left, but not for a reply this large), 'auth',
 * 'forbidden', 'rate_limit', 'unavailable' or 'other'.
 */
function classifyProviderFailure(err) {
  const status = errorStatus(err);
  const text = failureText(err);
  if (billing.isBillingError(err) && isNoCreditFailure(err)) {
    return isReservationSizeError(err) ? 'reservation' : 'billing';
  }
  if (status === 401 || INVALID_KEY_TEXT_RE.test(text) || /authentication_error|authentication failed/i.test(text)) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limit';
  if ((status !== null && (status >= 500 || status === 408)) || (status === null && isFailoverError(err))) return 'unavailable';
  return 'other';
}

/**
 * Feed the shared memo from a provider failure: an empty account →
 * billing-failover (the picker shows «Sin saldo», ladders skip it); a
 * rejected key → provider-key-health. A plain 403 (model not enabled for
 * this key) is not a dead key: embeddings/vision ladders keep using it.
 * Aborts, reservation-size 402s, per-minute quota windows and transient
 * faults record nothing.
 *
 * DeepSeek direct is special: with an OpenRouter key the chat answers the
 * same DeepSeek model through OpenRouter (routes/ai.js wrapDeepSeekClient),
 * so «Sin saldo» on the picker would be false. Only the direct key is
 * benched (key health, reason billing): unpinned ladders start elsewhere.
 * Never throws.
 */
function noteLlmProviderFailure(provider, apiKey, err, env = process.env) {
  try {
    if (!provider || !err || isAbortLike(err)) return;
    if (billing.isBillingError(err)) {
      if (!isNoCreditFailure(err) || isReservationSizeError(err)) return;
      if (billing.normProvider(provider) === 'deepseek' && billing.currentKeyFor('OpenRouter', env)) {
        if (apiKey) keyHealth.markRejected('deepseek', apiKey, err, env, { reason: 'billing' });
        return;
      }
      billing.markOutOfCredit(provider, err, env);
      return;
    }
    const forbiddenOnly = errorStatus(err) === 403 && !INVALID_KEY_TEXT_RE.test(failureText(err));
    if (apiKey && !forbiddenOnly && keyHealth.isInvalidKeyError(err)) {
      keyHealth.markRejected(String(provider).toLowerCase(), apiKey, err, env, { reason: 'auth' });
    }
  } catch (_) { /* the memo is advisory */ }
}

// The Retry-After hint of a rate limit, from headers or Gemini's "retry in 29s".
function retryAfterHintMs(err) {
  try {
    const fromHeaders = require('../agent-runner/native-llm').retryAfterMsFromError(err);
    if (fromHeaders != null) return fromHeaders;
  } catch (_) { /* optional */ }
  const match = /retry in\s+(\d+(?:\.\d+)?)\s*s/i.exec(failureText(err));
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * Content-free summary of the last provider failure, so callers that only
 * see a wrapped error can tell the user the real cause. Never carries the
 * provider's message text.
 */
function describeFailure(candidate, err) {
  const cause = classifyProviderFailure(err);
  const retryAfterMs = cause === 'rate_limit' ? retryAfterHintMs(err) : null;
  return {
    provider: candidate.provider,
    status: errorStatus(err),
    cause,
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
}

/**
 * OpenAI-compatible façade (`chat.completions.create`) over an ordered list of
 * candidates. A candidate that fails with a failover-class error is moved to
 * the end for the rest of this client's life (sticky success: once a provider
 * answered, later iterations keep using it). Non-failover errors propagate.
 */
function createFailoverClient(candidates, { createClient = defaultCreateClient, onFailover = () => {}, env = process.env } = {}) {
  const order = Array.isArray(candidates) ? candidates.filter(Boolean).slice() : [];
  if (!order.length) throw new Error('doc-agent: no LLM provider configured (DEEPSEEK_API_KEY, MODEL_API_KEY, GEMINI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY)');
  const clients = new Map();
  const attemptsLog = [];
  let lastFailure = null;
  const clientFor = (candidate) => {
    if (!clients.has(candidate.provider)) clients.set(candidate.provider, createClient(candidate));
    return clients.get(candidate.provider);
  };
  const create = async (payload, opts) => {
    let lastError = null;
    for (let i = 0; i < order.length; i += 1) {
      const candidate = order[0];
      try {
        const response = await clientFor(candidate).chat.completions.create(
          payloadForCandidate(payload, candidate),
          opts,
        );
        lastFailure = null;
        return response;
      } catch (err) {
        lastError = err;
        if (!isAbortLike(err, opts)) {
          // Before any wrapper replaces the error: the memo learns the real cause.
          noteLlmProviderFailure(candidate.provider, candidate.apiKey, err, env);
          lastFailure = describeFailure(candidate, err);
        }
        const last = order.length === 1 || i === order.length - 1;
        if (!isFailoverError(err) || last || (opts && opts.signal && opts.signal.aborted)) throw err;
        order.push(order.shift());
        const info = { from: candidate.provider, model: candidate.model, to: order[0].provider, status: errorStatus(err), message: String((err && err.message) || err).slice(0, 160) };
        attemptsLog.push(info);
        try { onFailover(info); } catch (_) { /* observer errors never break the run */ }
      }
    }
    throw lastError || new Error('doc-agent: every LLM provider failed');
  };
  return {
    chat: { completions: { create } },
    describe: () => ({
      provider: order[0].provider,
      model: order[0].model,
      failovers: attemptsLog.slice(),
      ...(lastFailure ? { lastFailure: { ...lastFailure } } : {}),
    }),
    candidates: () => order.map((c) => ({ provider: c.provider, model: c.model })),
  };
}

module.exports = {
  LADDER,
  inferProvider,
  parseModelSpec,
  keyFor,
  resolveDocAgentCandidates,
  resolveDocAgentRunCandidates,
  isFailoverError,
  classifyProviderFailure,
  noteLlmProviderFailure,
  createFailoverClient,
  defaultCreateClient,
};
