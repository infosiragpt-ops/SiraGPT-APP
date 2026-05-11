'use strict';

/**
 * gemini-adapter — concrete ProviderAdapter for Google Gemini.
 *
 * Backed by `@google/genai` (the v1 GA SDK) so that registry routing
 * for `gemini-*` models has a real implementation to fall back to.
 *
 * Boundaries:
 *   - Lazy SDK import: same pattern as openai-adapter — keeps the
 *     module require cheap and lets `isAvailable()` answer without a
 *     network call.
 *   - Env-driven gating: GOOGLE_API_KEY (or GEMINI_API_KEY as a
 *     fallback) must be set, otherwise the adapter declines to
 *     register and complete()/health() short-circuit with a typed
 *     error.
 */

const { ProviderAdapter } = require('../provider-registry');

const DEFAULT_MODEL = process.env.GEMINI_ADAPTER_DEFAULT_MODEL || 'gemini-2.5-flash';
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.GEMINI_ADAPTER_MAX_TOKENS, 10) || 4096;

const ADVERTISED_MODELS = Object.freeze([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-pro',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
]);

let _SdkClass = null;
let _client = null;

function pickApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
}

async function loadSdk() {
  if (_SdkClass) return _SdkClass;
  // Two distinct packages on disk; prefer the v1 GA (`@google/genai`)
  // and fall back to the legacy `@google/generative-ai` so a deploy
  // that has only one installed still works.
  try {
    const mod = await import('@google/genai');
    _SdkClass = mod.GoogleGenAI || mod.default || null;
  } catch {
    _SdkClass = null;
  }
  if (!_SdkClass) {
    const mod = await import('@google/generative-ai');
    _SdkClass = mod.GoogleGenerativeAI || mod.default || null;
  }
  if (typeof _SdkClass !== 'function') {
    throw new Error('Gemini SDK did not export a constructor');
  }
  return _SdkClass;
}

async function getClient() {
  if (_client) return _client;
  const apiKey = pickApiKey();
  if (!apiKey) return null;
  const Sdk = await loadSdk();
  _client = new Sdk({ apiKey });
  return _client;
}

class GeminiAdapter extends ProviderAdapter {
  get name() { return 'google'; }
  get models() { return [...ADVERTISED_MODELS]; }

  supports(model) {
    if (typeof model !== 'string') return false;
    return model.toLowerCase().startsWith('gemini-');
  }

  isAvailable() {
    return Boolean(pickApiKey());
  }

  /**
   * Translate the agent envelope into Gemini's `contents` shape.
   * Gemini uses { role: 'user'|'model', parts: [{ text }] } — we map
   * 'assistant' → 'model' and stringify non-string content.
   */
  static toContents(prompt) {
    if (typeof prompt === 'string') {
      return { contents: [{ role: 'user', parts: [{ text: prompt }] }], systemInstruction: null };
    }
    if (!prompt || typeof prompt !== 'object') {
      return { contents: [], systemInstruction: null };
    }
    const systemInstruction = typeof prompt.system === 'string' && prompt.system.length > 0
      ? { parts: [{ text: prompt.system }] }
      : null;
    const rawMessages = Array.isArray(prompt.messages) ? prompt.messages : [];
    const contents = rawMessages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'model'))
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }],
      }));
    return { contents, systemInstruction };
  }

  async complete(prompt, opts = {}) {
    const client = await getClient();
    if (!client) {
      const err = new Error('gemini adapter disabled: set GOOGLE_API_KEY (or GEMINI_API_KEY)');
      err.code = 'gemini_adapter_disabled';
      throw err;
    }

    const model = opts.model || DEFAULT_MODEL;
    const { contents, systemInstruction } = GeminiAdapter.toContents(prompt);

    // The v1 SDK exposes `client.models.generateContent`; the legacy
    // SDK uses `client.getGenerativeModel(...).generateContent`. We
    // try the new shape first, then fall back.
    let response;
    if (client.models && typeof client.models.generateContent === 'function') {
      response = await client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: systemInstruction || undefined,
          maxOutputTokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : DEFAULT_MAX_TOKENS,
          temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
        },
      });
    } else if (typeof client.getGenerativeModel === 'function') {
      const m = client.getGenerativeModel({
        model,
        systemInstruction: systemInstruction || undefined,
      });
      response = await m.generateContent({ contents });
    } else {
      throw new Error('Gemini SDK shape unknown — neither v1 nor legacy entrypoint found');
    }

    const text = extractText(response);
    return {
      text,
      model,
      usage: {
        input_tokens: response?.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response?.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: response?.usageMetadata?.totalTokenCount ?? 0,
      },
      raw: response || null,
    };
  }

  async health() {
    if (!pickApiKey()) return { ok: false, latency: 0, reason: 'no_api_key' };
    // Without a cheap public probe in the v1 SDK, treat env presence
    // as "configured". A real outage will surface on the first
    // complete() call and trip the registry's circuit breaker.
    return { ok: true, latency: 0 };
  }
}

function extractText(response) {
  // v1 SDK shape: response.text or response.candidates[0].content.parts
  if (typeof response?.text === 'string') return response.text;
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('');
}

// ── Test seams ────────────────────────────────────────────────────────────
function _setClientForTests(client) { _client = client; }
function _resetClientForTests() { _client = null; _SdkClass = null; }

module.exports = {
  GeminiAdapter,
  ADVERTISED_MODELS,
  DEFAULT_MODEL,
  _setClientForTests,
  _resetClientForTests,
};
