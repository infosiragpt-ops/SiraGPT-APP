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
 */

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
  for (const entry of LADDER) push(entry, null);
  return out;
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

function defaultCreateClient(candidate) {
  // Lazy require: keeps this module loadable in tests without the SDK.
  const OpenAI = require('openai');
  return new OpenAI({
    apiKey: candidate.apiKey,
    baseURL: candidate.baseURL,
    ...(candidate.headers ? { defaultHeaders: candidate.headers } : {}),
  });
}

/**
 * OpenAI-compatible façade (`chat.completions.create`) over an ordered list of
 * candidates. A candidate that fails with a failover-class error is moved to
 * the end for the rest of this client's life (sticky success: once a provider
 * answered, later iterations keep using it). Non-failover errors propagate.
 */
function createFailoverClient(candidates, { createClient = defaultCreateClient, onFailover = () => {} } = {}) {
  const order = Array.isArray(candidates) ? candidates.filter(Boolean).slice() : [];
  if (!order.length) throw new Error('doc-agent: no LLM provider configured (DEEPSEEK_API_KEY, MODEL_API_KEY, GEMINI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY)');
  const clients = new Map();
  const attemptsLog = [];
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
          { ...payload, model: candidate.model, ...(candidate.extra || {}) },
          opts,
        );
        return response;
      } catch (err) {
        lastError = err;
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
    describe: () => ({ provider: order[0].provider, model: order[0].model, failovers: attemptsLog.slice() }),
    candidates: () => order.map((c) => ({ provider: c.provider, model: c.model })),
  };
}

module.exports = {
  LADDER,
  inferProvider,
  parseModelSpec,
  resolveDocAgentCandidates,
  isFailoverError,
  createFailoverClient,
};
