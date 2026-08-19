'use strict';

/**
 * openai-adapter — concrete ProviderAdapter for the OpenAI SDK.
 *
 * Why this exists:
 *   ProviderRegistry (services/agents/provider-registry.js) supports
 *   capability-based routing + automatic failover, but it ships
 *   abstract — it has no concrete adapters. This module provides one
 *   that the bootstrap (./index.js) registers when OPENAI_API_KEY is
 *   set so the failover chain has a real provider to fall back to.
 *
 * Boundaries:
 *   - Lazy SDK import: the `openai` package is loaded the first time
 *     a method is called. This keeps `require('./openai-adapter')`
 *     cheap and lets callers introspect `.isAvailable()` without
 *     paying the SDK init cost up front.
 *   - Env-only config: the adapter reads OPENAI_API_KEY at call time
 *     (not at construction) so deploys can rotate the key without
 *     restarting the registry.
 *   - Prompt shape: complete() accepts the agent layer's
 *     `{ system, messages }` envelope and translates to the SDK's
 *     `chat.completions.create({ messages: [{ role, content }] })`.
 *   - Streaming: complete() is implemented; stream() defers to the
 *     base class until the chat endpoint adopts SSE in our agent
 *     layer.
 *
 * Tests inject a fake SDK via `_setClientForTests()` so the unit
 * suite never calls the real OpenAI API.
 */

const { ProviderAdapter } = require('../provider-registry');

const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.OPENAI_ADAPTER_MAX_TOKENS, 10) || 4096;
const DEFAULT_MODEL = process.env.OPENAI_ADAPTER_DEFAULT_MODEL || 'gpt-4o-mini';

// Models the adapter advertises. The list is informational — the real
// gate is `supports()`, which uses prefix matching so future model
// names (gpt-5, o3, etc.) don't require a code change.
const ADVERTISED_MODELS = Object.freeze([
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1',
  'o1-mini',
  'o3-mini',
]);

let _SdkClass = null;
let _client = null;

async function loadSdk() {
  if (_SdkClass) return _SdkClass;
  const mod = await import('openai');
  _SdkClass = mod.default || mod.OpenAI;
  if (typeof _SdkClass !== 'function') {
    throw new Error('openai SDK did not export a constructor');
  }
  return _SdkClass;
}

async function getClient() {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const Sdk = await loadSdk();
  _client = new Sdk({ apiKey });
  return _client;
}

class OpenAIAdapter extends ProviderAdapter {
  get name() { return 'openai'; }
  get models() { return [...ADVERTISED_MODELS]; }

  /**
   * Prefix match so future OpenAI models (gpt-5, o3, etc.) route here
   * automatically without an adapter update.
   */
  supports(model) {
    if (typeof model !== 'string') return false;
    const m = model.toLowerCase();
    return m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
  }

  /**
   * True only when the SDK can actually be used. The bootstrap calls
   * this BEFORE register() so we don't add a useless adapter into the
   * failover chain.
   */
  isAvailable() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  /**
   * Translate the agent envelope into the SDK shape. The agent layer
   * sends either a string (treated as a single user message) or an
   * object `{ system?, messages? }`. We normalise once here so the
   * rest of complete() works on a single shape.
   */
  static toMessages(prompt) {
    if (typeof prompt === 'string') {
      return { messages: [{ role: 'user', content: prompt }], system: null };
    }
    if (!prompt || typeof prompt !== 'object') {
      return { messages: [], system: null };
    }
    const system = typeof prompt.system === 'string' && prompt.system.length > 0
      ? prompt.system
      : null;
    const rawMessages = Array.isArray(prompt.messages) ? prompt.messages : [];
    const messages = rawMessages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
      .map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      }));
    return { system, messages };
  }

  async complete(prompt, opts = {}) {
    const client = await getClient();
    if (!client) {
      const err = new Error('openai adapter disabled: set OPENAI_API_KEY');
      err.code = 'openai_adapter_disabled';
      throw err;
    }

    const { system, messages } = OpenAIAdapter.toMessages(prompt);
    const finalMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    const model = opts.model || DEFAULT_MODEL;
    const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : DEFAULT_MAX_TOKENS;

    const resp = await client.chat.completions.create({
      model,
      messages: finalMessages,
      max_tokens: maxTokens,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
    });

    const choice = resp?.choices?.[0];
    const text = (choice?.message?.content) || '';
    return {
      text,
      model: resp?.model || model,
      usage: {
        input_tokens: resp?.usage?.prompt_tokens ?? 0,
        output_tokens: resp?.usage?.completion_tokens ?? 0,
        total_tokens: resp?.usage?.total_tokens ?? 0,
      },
      raw: resp || null,
    };
  }

  async health() {
    const t0 = Date.now();
    try {
      const client = await getClient();
      if (!client) return { ok: false, latency: 0, reason: 'no_api_key' };
      // Cheap probe: list models. The SDK throws on auth failure /
      // network outage, which is exactly what `health()` needs to
      // observe.
      await client.models.list();
      return { ok: true, latency: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latency: Date.now() - t0, error: err && err.message };
    }
  }
}

// ── Test seams ────────────────────────────────────────────────────────────
function _setClientForTests(client) { _client = client; }
function _resetClientForTests() { _client = null; _SdkClass = null; }

module.exports = {
  OpenAIAdapter,
  ADVERTISED_MODELS,
  DEFAULT_MODEL,
  _setClientForTests,
  _resetClientForTests,
};
