'use strict';

/**
 * memory-llm-client — the OpenAI-compatible client used by fire-and-forget
 * memory extraction (long-term facts, personal lexicon). It used to be
 * `new OpenAI({ apiKey: OPENAI_API_KEY })` built inline per turn, so an
 * invalid OpenAI key silently killed memory. Now it is the same failover
 * ladder as the document agent (DeepSeek → Meta → Gemini → xAI → OpenRouter →
 * OpenAI, placeholder keys ignored, sticky demotion of a failing provider).
 *
 * The first rung is a cheap model with thinking OFF: DeepSeek V4 thinks by
 * default, and its reasoning ate most of the extraction's token budget (empty
 * or cut JSON → facts silently lost). SIRAGPT_MEMORY_LLM_MODEL overrides it;
 * SIRAGPT_DOC_AGENT_MODEL is deliberately NOT inherited (the document agent
 * wants the pro model, memory does not). Returns null when no provider is
 * configured so callers keep their existing "no client" no-op.
 */

const DEFAULT_MEMORY_MODEL = 'DeepSeek:deepseek-v4-flash';

let cached = null;
let cachedAt = 0;
const REFRESH_MS = 5 * 60 * 1000; // pick up key changes without a restart

/**
 * Ordered memory candidates. Only DeepSeek V4 ids get `thinking: disabled`
 * (other providers and older ids 400 on the field); llm-runtime's
 * payloadForCandidate spreads `extra` into that candidate's request only.
 */
function resolveMemoryLlmCandidates({ env = process.env } = {}) {
  const { resolveDocAgentCandidates } = require('./doc-agent/llm-runtime');
  const model = String((env && env.SIRAGPT_MEMORY_LLM_MODEL) || '').trim() || DEFAULT_MEMORY_MODEL;
  return resolveDocAgentCandidates({ model, env }).map((candidate) => (
    candidate.provider === 'DeepSeek' && /^deepseek-v4/i.test(String(candidate.model || ''))
      ? { ...candidate, extra: { ...(candidate.extra || {}), thinking: { type: 'disabled' } } }
      : candidate
  ));
}

function createMemoryLlmClient({ env = process.env, force = false, createClient = null } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < REFRESH_MS) return cached;
  try {
    const { createFailoverClient } = require('./doc-agent/llm-runtime');
    const candidates = resolveMemoryLlmCandidates({ env });
    if (!candidates.length) { cached = null; cachedAt = now; return null; }
    cached = createFailoverClient(candidates, {
      ...(typeof createClient === 'function' ? { createClient } : {}),
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

module.exports = { createMemoryLlmClient, resolveMemoryLlmCandidates, resetForTests, DEFAULT_MEMORY_MODEL };
