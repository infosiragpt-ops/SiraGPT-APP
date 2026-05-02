'use strict';

/**
 * anthropic-native — official Anthropic SDK provider for the
 * `callUserSelectedModel` adapter.
 *
 * Why this exists: today the chat path routes Claude calls through
 * OpenRouter's OpenAI-compatible surface (see
 * `backend/src/services/ai-service.js` line ~56). That works, but it
 * loses Claude-specific behavior such as the dedicated `system`
 * field, structured tool use and the official streaming envelope.
 * Phase 8F installs `@anthropic-ai/sdk` and exposes a provider factory
 * compatible with the `providers.anthropic` slot in
 * `backend/src/services/sira/model-adapter.js`. The module is
 * self-contained and opt-in: it is only active when both
 * `ANTHROPIC_API_KEY` is set and `ANTHROPIC_NATIVE_ENABLED` is not
 * explicitly `false`. Otherwise the existing OpenRouter compatibility
 * path stays in charge.
 *
 * Risk control:
 * - The official SDK is loaded lazily via dynamic ESM import so the
 *   module is safe to require from the existing CommonJS backend even
 *   on hosts that have not configured Anthropic.
 * - When the env is missing, `createAnthropicProvider()` returns null,
 *   which the model adapter treats as "use the stub / fall back".
 * - Provider invocations bubble errors up so the LiteLLM gateway's
 *   circuit breaker keeps observing failures.
 */

const DEFAULT_MAX_TOKENS = Number(process.env.ANTHROPIC_NATIVE_MAX_TOKENS) || 4096;

let _SdkClass = null;
let _client = null;

function isEnabled(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) return false;
  if (env.ANTHROPIC_NATIVE_ENABLED === 'false') return false;
  return true;
}

async function loadSdkClass() {
  if (_SdkClass) return _SdkClass;
  const mod = await import('@anthropic-ai/sdk');
  _SdkClass = mod.default || mod.Anthropic;
  if (typeof _SdkClass !== 'function') {
    throw new Error('@anthropic-ai/sdk did not export a constructor');
  }
  return _SdkClass;
}

/**
 * Lazily instantiate the SDK client. Returns null when the env-flag
 * is off, so the model adapter can fall back to the stub.
 *
 * Tests can inject a stub client via `_setClientForTests`.
 */
async function getClient() {
  if (_client) return _client;
  if (!isEnabled()) return null;
  const Sdk = await loadSdkClass();
  _client = new Sdk({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Convert SiraGPT internal message shape to Anthropic's `messages`
 * payload.
 *
 * Anthropic expects only `user` and `assistant` roles; `system` is a
 * top-level field. `tool` and `function` roles are not modelled here
 * — Phase 8F is text-only so the existing chat router can opt into
 * native Claude. Tool-use serialization is a follow-up phase.
 *
 * Each message content can be a string or an array of content blocks
 * (text only for now). Stringified JSON is used as a fallback for
 * non-string payloads to mirror the stub provider's behavior.
 */
function toAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content ?? ''),
    }));
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * Provider function compatible with the `providers.anthropic` slot in
 * `callUserSelectedModel`. Throws when the SDK is not configured so
 * the adapter's circuit breaker / fallback can react.
 */
async function callAnthropic({
  selectedModel,
  systemPrompt,
  messages,
  responseFormat = 'text',
} = {}) {
  const client = await getClient();
  if (!client) {
    const err = new Error(
      'anthropic-native disabled: set ANTHROPIC_API_KEY (and leave ANTHROPIC_NATIVE_ENABLED unset or true)'
    );
    err.code = 'anthropic_native_disabled';
    throw err;
  }

  const resp = await client.messages.create({
    model: selectedModel?.modelId || 'claude-sonnet-4-6',
    max_tokens: DEFAULT_MAX_TOKENS,
    system: typeof systemPrompt === 'string' && systemPrompt.length > 0
      ? systemPrompt
      : undefined,
    messages: toAnthropicMessages(messages),
  });

  const text = extractText(resp?.content);

  let parsed = null;
  if (responseFormat === 'json' || responseFormat === 'json_schema') {
    try { parsed = JSON.parse(text); }
    catch { parsed = null; }
  }

  return {
    text,
    parsed,
    usage: {
      input_tokens: resp?.usage?.input_tokens ?? 0,
      output_tokens: resp?.usage?.output_tokens ?? 0,
    },
    raw: resp ?? null,
  };
}

/**
 * Factory that the model-adapter (or a future production wiring
 * module) calls to obtain a provider function. Returns null when the
 * native SDK is disabled — callers must check before substituting.
 */
function createAnthropicProvider() {
  if (!isEnabled()) return null;
  return callAnthropic;
}

// Test-only hooks: avoid importing the live SDK inside unit tests.
function _setClientForTests(client) { _client = client; }
function _resetClientForTests() { _client = null; _SdkClass = null; }

module.exports = {
  createAnthropicProvider,
  isEnabled,
  callAnthropic,
  toAnthropicMessages,
  extractText,
  _setClientForTests,
  _resetClientForTests,
};
