'use strict';

/**
 * Public display helpers for SiraCode.
 *
 * The /agentes picker model hits its own API (see user-model-choice).
 * Responses and UI copy must never print DeepSeek, OpenRouter, or a raw
 * model_id. Brand labels stay Spanish / product-facing.
 */

const FORBIDDEN_DISPLAY = /\b(deepseek|openrouter|model_id|modelid)\b/i;

function publicModelLabel(model) {
  const raw = String(model || '').trim();
  if (!raw) return 'Modelo';
  if (FORBIDDEN_DISPLAY.test(raw)) return 'Modelo';
  if (/[/:]/.test(raw) && /gpt|claude|gemini|kimi|grok|llama|qwen|mistral|deepseek/i.test(raw)) {
    return 'Modelo';
  }
  return raw.slice(0, 80);
}

function assertSafePublicText(text, label = 'payload') {
  const blob = typeof text === 'string' ? text : JSON.stringify(text);
  if (FORBIDDEN_DISPLAY.test(blob)) {
    const err = new Error(`${label} leaked a forbidden provider or model id`);
    err.code = 'sira_code_display_leak';
    throw err;
  }
  return text;
}

function sanitizePublicObject(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return FORBIDDEN_DISPLAY.test(value) ? 'Modelo' : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizePublicObject(item));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/model_id|modelId|providerID|providerId/i.test(key)) continue;
      out[key] = sanitizePublicObject(item);
    }
    return out;
  }
  return value;
}

module.exports = {
  FORBIDDEN_DISPLAY,
  publicModelLabel,
  assertSafePublicText,
  sanitizePublicObject,
};
