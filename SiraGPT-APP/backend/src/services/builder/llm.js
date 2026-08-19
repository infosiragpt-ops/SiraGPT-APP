'use strict';

/**
 * siraGPT Builder · LLM adapter (tiers).
 *
 * A thin, optional bridge to the free FlashGPT/Cerebras tier for the agentic
 * intake. It is deliberately *fail-open to determinism*: when no API key is
 * configured, or the call errors/times out/returns junk, every function
 * returns `null` so the caller (e.g. question-generator) falls back to the
 * static question bank. The static path keeps the engine fully testable with
 * zero network and keeps CI green without any provider secret.
 *
 * Injectable for tests: pass `createClient` (a () => OpenAI-like client) and
 * `env` to exercise the success path without real network.
 */

const { getCerebrasConfig, createCerebrasClient } = require('../ai/cerebras-client');

/** True when a free-tier LLM is configured and usable. */
function isLlmAvailable({ env = process.env } = {}) {
  return getCerebrasConfig({ env }).enabled;
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('builder-llm: timeout')), timeoutMs);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Run a single chat completion. Returns the assistant text, or `null` on any
 * failure (not configured, network error, timeout, unexpected shape).
 */
async function complete({
  system,
  user,
  env = process.env,
  createClient = createCerebrasClient,
  temperature = 0.4,
  maxTokens = 700,
  timeoutMs = 12_000,
} = {}) {
  const cfg = getCerebrasConfig({ env });
  if (!cfg.enabled) return null;

  let client;
  try {
    client = createClient({ env });
  } catch {
    return null;
  }
  if (!client || !client.chat || !client.chat.completions) return null;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  try {
    const resp = await withTimeout(
      client.chat.completions.create({ model: cfg.model, messages, temperature, max_tokens: maxTokens }),
      timeoutMs,
    );
    const text = resp?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Extract the first JSON object/array from a model response — tolerant of
 * ```json fences and surrounding prose. Returns the parsed value or `null`.
 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  // Narrow to the outermost {...} or [...] if there's leading/trailing prose.
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start !== -1 && end !== -1 && end > start) body = body.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** complete() + JSON parse. Returns the parsed object/array or `null`. */
async function completeJson(opts) {
  const text = await complete(opts);
  if (text == null) return null;
  return extractJson(text);
}

module.exports = { isLlmAvailable, complete, completeJson, extractJson };
