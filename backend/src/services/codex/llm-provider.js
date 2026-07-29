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
const { toAnthropicMessages, cacheStableTranscriptPrefix, cacheEnabled } = require('./anthropic-turn');

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';
const FAILOVER_TTL_MS = 5 * 60 * 1000;
// Anthropic silently ignores cache breakpoints on prefixes under ~1024 tokens,
// and each request only gets 4 breakpoints — don't spend one on a system
// prompt too small to ever cache. Codex system prompts are many KB in practice.
const CACHE_MIN_SYSTEM_CHARS = 1024;

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

function modelFor(name, env, override = null) {
  const requested = clean(override);
  if (requested) {
    if (name === 'anthropic' && /^claude-[a-z0-9._-]+$/i.test(requested)) return requested;
    if (name === 'openrouter' && requested.includes('/')) return requested;
    if (name === 'cerebras' && !requested.includes('/') && !/^claude-/i.test(requested)) return requested;
  }
  if (name === 'anthropic') return clean(env.CODEX_ANTHROPIC_MODEL) || DEFAULT_ANTHROPIC_MODEL;
  if (name === 'openrouter') return clean(env.CODEX_OPENROUTER_MODEL) || DEFAULT_OPENROUTER_MODEL;
  return getCerebrasConfig({ env }).model;
}

/** Higher-capability providers get more room to write whole files. */
function defaultMaxTokensFor(name) {
  if (name === 'cerebras') return 2048;
  // Anthropic gets extra room: 8192 still truncated big write_file payloads.
  return name === 'anthropic' ? 16384 : 8192;
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
  const { system, turns } = toAnthropicMessages(messages);
  return { system, messages: turns };
}

function anthropicTextFrom(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

function toOpenAICompatibleMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const content = message.content.map((block) => {
      if (!block || typeof block !== 'object') return null;
      if (block.type === 'text' && typeof block.text === 'string') return { ...block };
      if (block.type === 'image_url') return { ...block };
      if (block.type !== 'image') return null;
      const source = block.source;
      if (
        source?.type !== 'base64'
        || !/^image\/(?:jpeg|png|webp|gif)$/.test(String(source.media_type || ''))
        || typeof source.data !== 'string'
      ) return null;
      return {
        type: 'image_url',
        image_url: {
          url: `data:${source.media_type};base64,${source.data.replace(/\s/g, '')}`,
        },
      };
    }).filter(Boolean);
    return {
      ...message,
      content: content.length ? content : '[Adjunto no compatible; usa el texto extraído disponible.]',
    };
  });
}

async function callAnthropic({
  messages,
  temperature,
  maxTokens,
  signal,
  env,
  ctor,
  onTextDelta = null,
  onReasoningDelta = null,
  modelOverride = null,
  effort = null,
}) {
  const apiKey = clean(env.ANTHROPIC_API_KEY) || clean(env.SIRA_ANTHROPIC_API_KEY);
  // eslint-disable-next-line global-require
  const Anthropic = ctor || require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = modelFor('anthropic', env, modelOverride);
  const { system, messages: turns } = toAnthropicPayload(messages);
  // Prompt caching (CODEX_PROMPT_CACHE, default ON — GA, no beta header):
  // breakpoint on the system block plus the last completed turn of the stable
  // transcript prefix, so each agent step re-reads the shared prefix from
  // cache instead of re-processing it as full-price input.
  const useCache = cacheEnabled(env);
  const cacheSystem = useCache && typeof system === 'string' && system.length >= CACHE_MIN_SYSTEM_CHARS;
  const request = {
    model,
    system: system
      ? (cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system)
      : undefined,
    messages: useCache ? cacheStableTranscriptPrefix(turns) : turns,
    temperature,
    max_tokens: maxTokens,
  };
  if (['low', 'medium', 'high'].includes(String(effort || '').toLowerCase())) {
    request.output_config = { effort: String(effort).toLowerCase() };
  }
  let resp;
  let emitted = false;
  try {
    if ((typeof onTextDelta === 'function' || typeof onReasoningDelta === 'function') && typeof client.messages.stream === 'function') {
      const stream = client.messages.stream(request, signal ? { signal } : undefined);
      let pending = Promise.resolve();
      const enqueue = (callback, value) => {
        if (typeof callback !== 'function' || !value) return;
        emitted = true;
        pending = pending.then(() => Promise.resolve(callback(value))).catch(() => {});
      };
      stream.on('text', (delta) => enqueue(onTextDelta, delta));
      stream.on('thinking', (delta) => enqueue(onReasoningDelta, delta));
      resp = await stream.finalMessage();
      await pending;
    } else {
      resp = await client.messages.create(request, signal ? { signal } : undefined);
    }
  } catch (error) {
    if (emitted) error.partialResponse = true;
    throw error;
  }
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

async function callOpenAICompatible({
  messages,
  temperature,
  maxTokens,
  signal,
  model,
  client,
  providerLabel,
  onTextDelta = null,
  onReasoningDelta = null,
  effort = null,
}) {
  const shouldStream = typeof onTextDelta === 'function' || typeof onReasoningDelta === 'function';
  let resp;
  let emitted = false;
  try {
    const reasoning = ['low', 'medium', 'high'].includes(String(effort || '').toLowerCase()) && providerLabel === 'OpenRouter'
      ? { effort: String(effort).toLowerCase() }
      : null;
    resp = await client.chat.completions.create(
      {
        model,
        messages: toOpenAICompatibleMessages(messages),
        temperature,
        max_tokens: maxTokens,
        ...(reasoning ? { reasoning } : {}),
        ...(shouldStream ? { stream: true } : {}),
        ...(shouldStream && providerLabel === 'OpenRouter'
          ? { stream_options: { include_usage: true } }
          : {}),
      },
      signal ? { signal } : undefined,
    );
  } catch (error) {
    throw error;
  }
  if (shouldStream && resp && typeof resp[Symbol.asyncIterator] === 'function') {
    let content = '';
    let reasoning = '';
    let usage = {};
    let generationId = null;
    try {
      for await (const chunk of resp) {
        generationId = generationId || chunk?.id || null;
        if (chunk?.usage) usage = chunk.usage;
        const delta = chunk?.choices?.[0]?.delta || {};
        const textDelta = typeof delta.content === 'string' ? delta.content : '';
        const reasoningDelta = typeof delta.reasoning === 'string'
          ? delta.reasoning
          : (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
        if (textDelta) {
          emitted = true;
          content += textDelta;
          if (typeof onTextDelta === 'function') await onTextDelta(textDelta);
        }
        if (reasoningDelta) {
          emitted = true;
          reasoning += reasoningDelta;
          if (typeof onReasoningDelta === 'function') await onReasoningDelta(reasoningDelta);
        }
      }
    } catch (error) {
      if (emitted) error.partialResponse = true;
      throw error;
    }
    return {
      content,
      reasoning,
      usage: {
        tokensIn: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
        tokensOut: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
        provider: providerLabel,
        model,
        generationId,
      },
    };
  }
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
async function chatComplete({
  messages,
  temperature = 0.3,
  maxTokens,
  signal,
  env = process.env,
  now = Date.now,
  clients = {},
  onTextDelta = null,
  onReasoningDelta = null,
  model = null,
  effort = null,
} = {}) {
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
        out = await callAnthropic({
          messages,
          temperature,
          maxTokens: effectiveMax,
          signal,
          env,
          ctor: clients.anthropicCtor,
          onTextDelta,
          onReasoningDelta,
          modelOverride: model,
          effort,
        });
      } else if (name === 'openrouter') {
        const client = clients.openrouter || createOpenRouterClient(env, clients.openAICtor);
        out = await callOpenAICompatible({
          messages,
          temperature,
          maxTokens: effectiveMax,
          signal,
          model: modelFor('openrouter', env, model),
          client,
          providerLabel: 'OpenRouter',
          onTextDelta,
          onReasoningDelta,
          effort,
        });
      } else {
        const client = clients.cerebras || createCerebrasClient({ env });
        if (!client?.chat?.completions) throw new Error('cerebras client unavailable');
        out = await callOpenAICompatible({
          messages,
          temperature,
          maxTokens: effectiveMax,
          signal,
          model: modelFor('cerebras', env, model),
          client,
          providerLabel: 'Cerebras',
          onTextDelta,
          onReasoningDelta,
          effort,
        });
      }
      quarantine.delete(name);
      return out;
    } catch (err) {
      if (signal?.aborted) throw err; // cancellation is not a provider failure
      // Once a provider emitted visible deltas, fail closed instead of retrying
      // another rung and splicing two different answers into one transcript.
      if (err?.partialResponse) throw err;
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
  callAnthropic,
  callOpenAICompatible,
  toOpenAICompatibleMessages,
  resetQuarantine,
  FAILOVER_TTL_MS,
  LADDER,
};
