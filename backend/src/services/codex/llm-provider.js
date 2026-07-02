'use strict';

/**
 * codex/llm-provider — resolves the best available LLM for the codex agent
 * loop and exposes a single provider-agnostic `chatComplete()`.
 *
 * Ladder (first configured wins, override with CODEX_LLM_PROVIDER):
 *   1. anthropic  — ANTHROPIC_API_KEY  (Claude; the loop keeps the prompted
 *      tool protocol, so no native tool_calls are needed)
 *   2. openrouter — OPENROUTER_API_KEY (OpenAI-compatible)
 *   3. cerebras   — CEREBRAS_API_KEY   (FlashGPT free tier; previous default)
 *
 * A provider that throws is quarantined for FAILOVER_TTL_MS and the call is
 * retried on the next rung, so a bad key / quota blip degrades quality instead
 * of failing the run. All clients are lazy-required and injectable for tests.
 */

const { getCerebrasConfig, createCerebrasClient } = require('../ai/cerebras-client');

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';
const FAILOVER_TTL_MS = 5 * 60 * 1000;

const LADDER = ['anthropic', 'openrouter', 'cerebras'];

// provider → epoch-ms until which it is quarantined. Module-level on purpose:
// one bad key shouldn't be re-probed on every single agent step.
const quarantine = new Map();

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function providerConfigured(name, env) {
  if (name === 'anthropic') return Boolean(clean(env.ANTHROPIC_API_KEY) || clean(env.SIRA_ANTHROPIC_API_KEY));
  if (name === 'openrouter') return Boolean(clean(env.OPENROUTER_API_KEY));
  if (name === 'cerebras') return getCerebrasConfig({ env }).enabled;
  return false;
}

function modelFor(name, env) {
  if (name === 'anthropic') return clean(env.CODEX_ANTHROPIC_MODEL) || DEFAULT_ANTHROPIC_MODEL;
  if (name === 'openrouter') return clean(env.CODEX_OPENROUTER_MODEL) || DEFAULT_OPENROUTER_MODEL;
  return getCerebrasConfig({ env }).model;
}

/** Higher-capability providers get more room to write whole files. */
function defaultMaxTokensFor(name) {
  return name === 'cerebras' ? 2048 : 8192;
}

/**
 * Ordered candidate list for this call: the forced provider alone, or every
 * configured rung of the ladder with quarantined ones pushed to the back
 * (still tried — better a quarantined provider than no answer at all).
 */
function resolveCandidates({ env = process.env, now = Date.now } = {}) {
  const forced = clean(env.CODEX_LLM_PROVIDER).toLowerCase();
  if (forced) return LADDER.includes(forced) && providerConfigured(forced, env) ? [forced] : [];
  const configured = LADDER.filter((name) => providerConfigured(name, env));
  const t = now();
  const healthy = configured.filter((name) => (quarantine.get(name) || 0) <= t);
  const sick = configured.filter((name) => (quarantine.get(name) || 0) > t);
  return [...healthy, ...sick];
}

/** Anthropic requires alternating roles: coalesce runs of same-role messages. */
function toAnthropicPayload(messages) {
  let system = '';
  const turns = [];
  for (const m of messages || []) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'system') {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${m.content}`;
    else turns.push({ role, content: m.content });
  }
  if (turns.length === 0 || turns[0].role !== 'user') {
    turns.unshift({ role: 'user', content: 'Continúa.' });
  }
  return { system, messages: turns };
}

function anthropicTextFrom(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

async function callAnthropic({ messages, temperature, maxTokens, signal, env, ctor }) {
  const apiKey = clean(env.ANTHROPIC_API_KEY) || clean(env.SIRA_ANTHROPIC_API_KEY);
  // eslint-disable-next-line global-require
  const Anthropic = ctor || require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = modelFor('anthropic', env);
  const { system, messages: turns } = toAnthropicPayload(messages);
  const resp = await client.messages.create(
    {
      model,
      system: system || undefined,
      messages: turns,
      temperature,
      max_tokens: maxTokens,
    },
    signal ? { signal } : undefined,
  );
  return {
    content: anthropicTextFrom(resp),
    reasoning: '',
    usage: {
      tokensIn: Number(resp?.usage?.input_tokens ?? 0) || 0,
      tokensOut: Number(resp?.usage?.output_tokens ?? 0) || 0,
      provider: 'Anthropic',
      model,
      generationId: resp?.id || null,
    },
  };
}

async function callOpenAICompatible({ messages, temperature, maxTokens, signal, model, client, providerLabel }) {
  const resp = await client.chat.completions.create(
    { model, messages, temperature, max_tokens: maxTokens },
    signal ? { signal } : undefined,
  );
  const choice = resp?.choices?.[0]?.message || {};
  const content = typeof choice.content === 'string' ? choice.content : '';
  const reasoning = typeof choice.reasoning === 'string'
    ? choice.reasoning
    : (typeof choice.reasoning_content === 'string' ? choice.reasoning_content : '');
  const u = resp?.usage || {};
  return {
    content,
    reasoning,
    usage: {
      tokensIn: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
      tokensOut: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
      provider: providerLabel,
      model,
      generationId: resp?.id || null,
    },
  };
}

function createOpenRouterClient(env, OpenAICtor) {
  // eslint-disable-next-line global-require
  const OpenAI = OpenAICtor || require('openai');
  return new OpenAI({
    apiKey: clean(env.OPENROUTER_API_KEY),
    baseURL: clean(env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1',
  });
}

/**
 * One provider-agnostic completion. Tries each candidate in order; a throwing
 * provider is quarantined and the next rung is tried. Throws only when every
 * candidate failed (with the first error, the most meaningful one).
 */
async function chatComplete({ messages, temperature = 0.3, maxTokens, signal, env = process.env, now = Date.now, clients = {} } = {}) {
  const candidates = resolveCandidates({ env, now });
  if (candidates.length === 0) {
    throw new Error('codex llm-provider: no LLM provider configured (ANTHROPIC_API_KEY / OPENROUTER_API_KEY / CEREBRAS_API_KEY)');
  }

  let firstError = null;
  for (const name of candidates) {
    const effectiveMax = maxTokens || defaultMaxTokensFor(name);
    try {
      let out;
      if (name === 'anthropic') {
        out = await callAnthropic({ messages, temperature, maxTokens: effectiveMax, signal, env, ctor: clients.anthropicCtor });
      } else if (name === 'openrouter') {
        const client = clients.openrouter || createOpenRouterClient(env, clients.openAICtor);
        out = await callOpenAICompatible({ messages, temperature, maxTokens: effectiveMax, signal, model: modelFor('openrouter', env), client, providerLabel: 'OpenRouter' });
      } else {
        const client = clients.cerebras || createCerebrasClient({ env });
        if (!client?.chat?.completions) throw new Error('cerebras client unavailable');
        out = await callOpenAICompatible({ messages, temperature, maxTokens: effectiveMax, signal, model: modelFor('cerebras', env), client, providerLabel: 'Cerebras' });
      }
      quarantine.delete(name);
      return out;
    } catch (err) {
      if (signal?.aborted) throw err; // cancellation is not a provider failure
      if (!firstError) firstError = err;
      quarantine.set(name, now() + FAILOVER_TTL_MS);
      if (env.NODE_ENV !== 'test') {
        console.warn(`[codex llm-provider] ${name} failed (${String(err?.message || err).slice(0, 200)}) — trying next provider`);
      }
    }
  }
  throw firstError || new Error('codex llm-provider: all providers failed');
}

/** For health/telemetry: which provider+model would serve the next call. */
function describeActiveProvider({ env = process.env, now = Date.now } = {}) {
  const candidates = resolveCandidates({ env, now });
  if (candidates.length === 0) return { provider: null, model: null };
  return { provider: candidates[0], model: modelFor(candidates[0], env) };
}

/** Test hook: clear the module-level quarantine map. */
function resetQuarantine() {
  quarantine.clear();
}

module.exports = {
  chatComplete,
  resolveCandidates,
  describeActiveProvider,
  toAnthropicPayload,
  defaultMaxTokensFor,
  modelFor,
  providerConfigured,
  resetQuarantine,
  FAILOVER_TTL_MS,
  LADDER,
};
