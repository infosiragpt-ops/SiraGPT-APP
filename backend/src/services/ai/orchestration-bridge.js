'use strict';

/**
 * orchestration-bridge — plugs backend/src/orchestration/ modules into
 * existing ai-service.js flow. All changes behind SIRAGPT_ORCHESTRATION_ENABLED=1.
 * When disabled, behavior is byte-for-byte identical to prior.
 */

let _bridge = null;

function createOrchestrationBridge(env = process.env) {
  const enabled = env.SIRAGPT_ORCHESTRATION_ENABLED === '1';

  let _wireup = null;
  function getWireup() {
    if (!_wireup && enabled) {
      try {
        _wireup = require('../orchestration/orchestration-wireup').getOrchestrationWireup(env);
      } catch (_) { /* unavailable */ }
    }
    return _wireup;
  }

  async function enrichSystemPrompt({ userId, userMessage, existingSystemPrompt = '' } = {}) {
    if (!enabled || !userId) return { blocks: [] };
    const w = getWireup();
    if (!w) return { blocks: [] };
    const blocks = [];
    try {
      const memories = await w.memoryAdapter.recall(userId, userMessage, 5);
      if (memories && memories.length > 0) {
        const lines = memories.map((m, i) =>
          `  ${i + 1}. [${m.category || m.source || 'knowledge'}, score:${(m.score || 0).toFixed(2)}] ${m.content || m.text || ''}`
        );
        blocks.push(`## USER MEMORY (${memories.length} recalled)\n${lines.join('\n')}`);
      }
    } catch (_) {}
    try {
      if (w.search.needsFreshWebContext(userMessage)) {
        const results = await w.search.searchFreshContext(userMessage);
        if (results.results?.length) {
          const sources = results.results.slice(0, 5).map(r =>
            `  - [${r.title || 'source'}](${r.url || ''}): ${(r.content || '').slice(0, 300)}`
          );
          blocks.push(`## CURRENT EVENTS CONTEXT (via ${results.provider})\n${sources.join('\n')}\n\nUse these sources if relevant.`);
        }
      }
    } catch (_) {}
    try { await w.memoryAdapter.add(userId, userMessage, { category: 'conversation', importance: 0.4, confidence: 0.7 }); } catch (_) {}
    return { blocks };
  }

  async function checkSemanticCache({ prompt, messages, model, temperature, context = {} } = {}) {
    if (!enabled) return null;
    const w = getWireup();
    if (!w?.semanticCache?.enabled) return null;
    const { semanticCacheKey, shouldBypassSemanticCache } = require('../orchestration/semantic-cache');
    const promptText = prompt || (messages?.map?.(m => m.content)?.join('\n')) || '';
    if (shouldBypassSemanticCache({ prompt: promptText })) return null;
    try { return await w.semanticCache.get(semanticCacheKey({ prompt: promptText, context, model, temperature })); } catch (_) { return null; }
  }

  async function storeSemanticCache({ prompt, messages, model, temperature, response, context = {} } = {}) {
    if (!enabled) return;
    const w = getWireup();
    if (!w?.semanticCache?.enabled) return;
    const { semanticCacheKey, resolveCacheTtlSeconds, shouldBypassSemanticCache } = require('../orchestration/semantic-cache');
    const { detectTaskType } = require('../orchestration/llm-routing.config');
    const promptText = prompt || (messages?.map?.(m => m.content)?.join('\n')) || '';
    if (shouldBypassSemanticCache({ prompt: promptText })) return;
    const ttl = resolveCacheTtlSeconds(detectTaskType({ prompt: promptText }), env);
    try { await w.semanticCache.set(semanticCacheKey({ prompt: promptText, context, model, temperature }), response, ttl); } catch (_) {}
  }

  function recordLLMCall({ provider, model, latencyMs, tokensIn, tokensOut, costUsd, userId, prompt } = {}) {
    if (!enabled) return;
    const w = getWireup();
    if (!w?.langfuseTracer) return;
    try { w.langfuseTracer.recordLLMMetrics({ provider, model, latencyMs, tokens: { in: tokensIn, out: tokensOut }, costUsd, userId, prompt: String(prompt || '').slice(0, 200) }); } catch (_) {}
  }

  async function storeArtifact({ userId, fileName, body, contentType } = {}) {
    if (!enabled) return null;
    const w = getWireup();
    if (!w?.r2Storage?.enabled) return null;
    const { safeKey } = require('../orchestration/r2-storage');
    try {
      const key = safeKey({ userId: String(userId || 'anon'), fileName, prefix: 'artifacts' });
      await w.r2Storage.put({ key, body, contentType });
      const url = await w.r2Storage.signedGetUrl(key);
      return { key, url, storage: 'r2' };
    } catch (err) { return null; }
  }

  async function health() {
    if (!enabled) return { enabled: false };
    const w = getWireup();
    if (!w) return { enabled: false, wireup: 'unavailable' };
    try { return await w.health(); } catch (_) { return { enabled: false, error: _.message }; }
  }

  return { enabled, enrichSystemPrompt, checkSemanticCache, storeSemanticCache, recordLLMCall, storeArtifact, health };
}

function getOrchestrationBridge(env) {
  if (!_bridge) _bridge = createOrchestrationBridge(env);
  return _bridge;
}
function resetOrchestrationBridge() { _bridge = null; }

module.exports = { createOrchestrationBridge, getOrchestrationBridge, resetOrchestrationBridge };
