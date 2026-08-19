'use strict';

/**
 * Route Enricher — bridges the orchestration layer into existing
 * Express route handlers without modifying their core logic.
 *
 * Each enrichment is a pure function that reads from
 * `req.app.locals.orchestration` and returns augmentations to the
 * existing handler's request/response objects.
 *
 * Usage inside a route handler:
 *   const orch = require('../orchestration/route-enricher');
 *   // Enrich system prompt with memory + web search
 *   const ctx = await orch.enrichSystemPrompt(req, userId, prompt, existingSystemPrompt);
 *   // Use enhanced SSE streaming
 *   orch.attachSSE(req, res);
 *   // Try orchestration gateway for LLM call
 *   const result = await orch.tryGatewayComplete(req, { messages, ... });
 */

function createRouteEnricher() {
  /**
   * Enrich the system prompt with orchestration memory recall and
   * web search results. Returns the augmented system prompt string.
   * Falls back to the original prompt if orchestration is unavailable.
   */
  async function enrichSystemPrompt(req, userId, userMessage, currentSystemPrompt, opts = {}) {
    const orch = req?.app?.locals?.orchestration;
    const bridge = orch?.bridge;
    if (!bridge || (!bridge.hasMemory && !bridge.hasSearch)) {
      return currentSystemPrompt;
    }

    try {
      const messages = [{ role: 'user', content: userMessage || '' }];
      const enriched = await bridge.enrichContext({
        userId,
        systemPrompt: currentSystemPrompt || '',
        messages,
        files: opts.files || [],
      });
      return enriched.systemPrompt || currentSystemPrompt;
    } catch (err) {
      try { console.warn('[route-enricher] enrichSystemPrompt failed:', err.message); } catch (_) {}
      return currentSystemPrompt;
    }
  }

  /**
   * Try to complete an LLM call through the orchestration gateway.
   * Returns the gateway result on success, or null if the gateway
   * is unavailable / fails — the caller should fall through to the
   * existing provider flow.
   */
  async function tryGatewayComplete(req, { messages, prompt, files, taskType, temperature, signal, stream, userId, cacheContext } = {}) {
    const orch = req?.app?.locals?.orchestration;
    const bridge = orch?.bridge;
    if (!bridge || !bridge.hasGateway) return null;

    try {
      return await bridge.invokeLLM({
        messages,
        prompt,
        files,
        taskType,
        temperature,
        signal,
        stream,
        userId,
        cacheContext,
      });
    } catch (err) {
      try { console.warn('[route-enricher] tryGatewayComplete failed:', err.message); } catch (_) {}
      return null;
    }
  }

  /**
   * Attach enhanced SSE streaming (replay buffer, heartbeats,
   * backpressure) to the response. Returns the SSE helper or null.
   */
  function attachSSE(req, res) {
    const orch = req?.app?.locals?.orchestration;
    const bridge = orch?.bridge;
    if (!bridge || !bridge.hasSSE) return null;
    try {
      return bridge.attachSSEWithReplay(req, res);
    } catch (err) {
      try { console.warn('[route-enricher] attachSSE failed:', err.message); } catch (_) {}
      return null;
    }
  }

  /**
   * Generate embeddings through the orchestration gateway.
   * Returns the embedding result or null on failure.
   */
  async function tryGatewayEmbed(req, input, opts = {}) {
    const orch = req?.app?.locals?.orchestration;
    const bridge = orch?.bridge;
    if (!bridge) return null;
    try {
      return await bridge.embedText(input, opts);
    } catch (err) {
      try { console.warn('[route-enricher] tryGatewayEmbed failed:', err.message); } catch (_) {}
      return null;
    }
  }

  /**
   * Persist a memory fact through the orchestration memory adapter.
   * Fire-and-forget — never blocks the response.
   */
  function persistMemoryFact(req, userId, fact) {
    const orch = req?.app?.locals?.orchestration;
    if (!orch?.memory) return;
    try {
      // Mem0-compatible memory storage via long-term memory bridge
      const longTermMemory = require('../services/long-term-memory');
      longTermMemory.storeFact(userId, fact).catch(() => {});
    } catch (_) {}
  }

  /**
   * Check if orchestration document pipeline is available for
   * enhanced file processing.
   */
  function hasDocumentPipeline(req) {
    return !!(req?.app?.locals?.orchestration?.configured?.memory);
  }

  /**
   * Get the R2 artifact storage instance for presigned URLs.
   */
  function getR2Storage(req) {
    return req?.app?.locals?.orchestration?.r2 || null;
  }

  /**
   * Get the web search capability.
   */
  function getWebSearch(req) {
    return req?.app?.locals?.orchestration?.search || null;
  }

  return {
    enrichSystemPrompt,
    tryGatewayComplete,
    attachSSE,
    tryGatewayEmbed,
    persistMemoryFact,
    hasDocumentPipeline,
    getR2Storage,
    getWebSearch,
  };
}

// Singleton
let _instance = null;
function getRouteEnricher() {
  if (!_instance) _instance = createRouteEnricher();
  return _instance;
}

module.exports = { createRouteEnricher, getRouteEnricher };
