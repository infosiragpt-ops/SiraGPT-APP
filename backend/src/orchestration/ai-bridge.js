'use strict';

/**
 * AI Bridge — connects the new orchestration layer (LLM Gateway, memory
 * adapter, web search, SSE replay) to the existing AI route handlers
 * without modifying their core logic.
 *
 * Usage:
 *   const { enrichContext, invokeLLM, searchIfNeeded } = req.app.locals.orchestration?.bridge || {};
 */

function createAIBridge({ gateway, memory, search, sse }) {
  const hasGateway = Boolean(gateway);
  const hasMemory = Boolean(memory);
  const hasSearch = Boolean(search);
  const hasSSE = Boolean(sse);

  async function enrichContext({ userId, systemPrompt = '', messages = [], files = [] } = {}) {
    const enriched = { systemPrompt, memoryFacts: [], searchResults: [] };

    if (hasMemory && userId) {
      try {
        const query = messages.length > 0
          ? messages[messages.length - 1]?.content?.slice(0, 500) || ''
          : '';
        if (query) {
          const facts = await memory.recall(userId, query, 5);
          enriched.memoryFacts = (facts || []).map(f => f.content || f.fact || f.text || String(f));
          if (enriched.memoryFacts.length > 0) {
            enriched.systemPrompt = `${systemPrompt || ''}\n\n[Relevant user memories]\n${enriched.memoryFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
          }
        }
      } catch (err) {
        try { console.warn('[ai-bridge] memory recall failed:', err.message); } catch (_) {}
      }
    }

    if (hasSearch && search.needsFreshWebContext) {
      const userPrompt = messages.length > 0
        ? messages[messages.length - 1]?.content || ''
        : '';
      if (search.needsFreshWebContext(userPrompt)) {
        try {
          const sr = await search.searchFreshContext(userPrompt.slice(0, 300));
          enriched.searchResults = sr.results || [];
          if (enriched.searchResults.length > 0) {
            const webBlock = enriched.searchResults.slice(0, 3)
              .map((r, i) => `${i + 1}. ${r.title || 'Result'}: ${r.content || r.snippet || r.text || ''}`.slice(0, 300))
              .join('\n');
            enriched.systemPrompt = `${enriched.systemPrompt || systemPrompt || ''}\n\n[Fresh web context]\n${webBlock}`;
          }
        } catch (err) {
          try { console.warn('[ai-bridge] web search failed:', err.message); } catch (_) {}
        }
      }
    }

    return enriched;
  }

  async function invokeLLM({ messages, prompt, files, taskType, temperature = 0.55, signal, stream = false, userId, cacheContext = {} } = {}) {
    if (!hasGateway || !gateway.complete) {
      return null;
    }
    try {
      const result = await gateway.complete({
        messages,
        prompt,
        files,
        taskType,
        temperature,
        signal,
        stream,
        cacheContext: { ...cacheContext, userId },
      });
      return result;
    } catch (err) {
      try { console.warn('[ai-bridge] LLM gateway invocation failed:', err.message); } catch (_) {}
      return { error: err.message, provider: 'none', model: 'none', response: null, causes: err.causes || [] };
    }
  }

  async function embedText(input, opts = {}) {
    if (!hasGateway || !gateway.embed) return null;
    try {
      return await gateway.embed({ input, ...opts });
    } catch (err) {
      try { console.warn('[ai-bridge] embedding failed:', err.message); } catch (_) {}
      return null;
    }
  }

  function attachSSEWithReplay(req, res) {
    if (!hasSSE || !sse.attachSSEStream) return null;
    return sse.attachSSEStream(req, res, sse.buffer);
  }

  return {
    enrichContext,
    invokeLLM,
    embedText,
    attachSSEWithReplay,
    hasGateway,
    hasMemory,
    hasSearch,
    hasSSE,
  };
}

module.exports = { createAIBridge };
