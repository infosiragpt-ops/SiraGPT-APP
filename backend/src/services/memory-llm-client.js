'use strict';

/**
 * memory-llm-client — the OpenAI-compatible client used by fire-and-forget
 * memory extraction (long-term facts, personal lexicon). It used to be
 * `new OpenAI({ apiKey: OPENAI_API_KEY })` built inline per turn, so an
 * invalid OpenAI key silently killed memory. Now it is the same failover
 * ladder as the document agent (DeepSeek → Meta → Gemini → xAI → OpenRouter →
 * OpenAI, placeholder keys ignored, sticky demotion of a failing provider).
 * Override the model with SIRAGPT_MEMORY_LLM_MODEL. Returns null when no
 * provider is configured so callers keep their existing "no client" no-op.
 */

let cached = null;
let cachedAt = 0;
const REFRESH_MS = 5 * 60 * 1000; // pick up key changes without a restart

function createMemoryLlmClient({ env = process.env, force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < REFRESH_MS) return cached;
  try {
    const { resolveDocAgentCandidates, createFailoverClient } = require('./doc-agent/llm-runtime');
    const candidates = resolveDocAgentCandidates({ model: env.SIRAGPT_MEMORY_LLM_MODEL || null, env });
    if (!candidates.length) { cached = null; cachedAt = now; return null; }
    cached = createFailoverClient(candidates, {
      onFailover: (info) => console.warn(`[memory-llm] failover ${info.from} → ${info.to} (${info.status || ''} ${info.message || ''})`),
    });
    cachedAt = now;
    return cached;
  } catch (err) {
    console.warn('[memory-llm] unavailable:', err && err.message);
    cached = null;
    cachedAt = now;
    return null;
  }
}

function resetForTests() { cached = null; cachedAt = 0; }

module.exports = { createMemoryLlmClient, resetForTests };
