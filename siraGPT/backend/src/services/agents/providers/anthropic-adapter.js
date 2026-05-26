'use strict';

/**
 * anthropic-adapter — concrete ProviderAdapter for Anthropic Claude.
 *
 * Wraps the existing `services/providers/anthropic-native.js`
 * (`callAnthropic`) so the agent layer can talk to the same SDK the
 * chat path already uses, while exposing the ProviderAdapter contract
 * required for capability-based routing + automatic failover.
 *
 * Boundaries:
 *   - Lazy availability check: `isAvailable()` reflects the
 *     `anthropic-native.isEnabled()` gate so the bootstrap can decide
 *     whether to register the adapter at all.
 *   - Prompt translation lives in OpenAIAdapter.toMessages-style here
 *     because Anthropic also wants `system` + `messages` separately,
 *     and the agent envelope is the same.
 *   - Streaming: complete() only. The anthropic-native helper does not
 *     stream today; when it does, mirror complete() into stream().
 */

const { ProviderAdapter } = require('../provider-registry');
const native = require('../../providers/anthropic-native');

const DEFAULT_MODEL = process.env.ANTHROPIC_ADAPTER_DEFAULT_MODEL || 'claude-sonnet-4-6';

const ADVERTISED_MODELS = Object.freeze([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  // Older families are still routable via the prefix match in
  // supports(); listing them here is informational only.
  'claude-3-5-sonnet',
  'claude-3-opus',
]);

class AnthropicAdapter extends ProviderAdapter {
  get name() { return 'anthropic'; }
  get models() { return [...ADVERTISED_MODELS]; }

  /**
   * Prefix match so future Claude families route here without a code
   * change. The 'claude-' prefix covers every published Anthropic
   * model name; if Anthropic ever ships a model with a different
   * prefix, extend this branch then.
   */
  supports(model) {
    if (typeof model !== 'string') return false;
    return model.toLowerCase().startsWith('claude-');
  }

  isAvailable() {
    return native.isEnabled();
  }

  /**
   * Translate the agent envelope into anthropic-native's
   * `{ selectedModel, systemPrompt, messages }`. We keep the helper
   * contract narrow — anthropic-native already handles SDK-shape
   * conversion (toAnthropicMessages) and the 1M-context beta header.
   */
  async complete(prompt, opts = {}) {
    if (!native.isEnabled()) {
      const err = new Error('anthropic adapter disabled: set ANTHROPIC_API_KEY');
      err.code = 'anthropic_adapter_disabled';
      throw err;
    }

    let system = null;
    let messages = [];
    if (typeof prompt === 'string') {
      messages = [{ role: 'user', content: prompt }];
    } else if (prompt && typeof prompt === 'object') {
      if (typeof prompt.system === 'string' && prompt.system.length > 0) {
        system = prompt.system;
      }
      if (Array.isArray(prompt.messages)) {
        messages = prompt.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
      }
    }

    const model = opts.model || DEFAULT_MODEL;
    const result = await native.callAnthropic({
      selectedModel: { modelId: model },
      systemPrompt: system,
      messages,
      responseFormat: opts.responseFormat || 'text',
    });

    return {
      text: result.text || '',
      model,
      usage: {
        input_tokens: result?.usage?.input_tokens || 0,
        output_tokens: result?.usage?.output_tokens || 0,
        total_tokens: (result?.usage?.input_tokens || 0) + (result?.usage?.output_tokens || 0),
      },
      raw: result?.raw || null,
    };
  }

  async health() {
    // The native helper does not expose a health probe; surfacing
    // `isEnabled()` is the cheapest accurate signal — a misconfigured
    // adapter shows ok:false without spending a token on a trial call.
    if (!native.isEnabled()) return { ok: false, latency: 0, reason: 'not_enabled' };
    return { ok: true, latency: 0 };
  }
}

module.exports = {
  AnthropicAdapter,
  ADVERTISED_MODELS,
  DEFAULT_MODEL,
};
