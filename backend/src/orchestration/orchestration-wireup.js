'use strict';

/**
 * OrchestrationWireup — singleton integration layer that connects all
 * orchestration modules into a unified runtime. All modules follow
 * the lazy-require pattern from CLAUDE.md so this file loads instantly
 * even when optional deps (opossum, langchain, @aws-sdk, etc.) are
 * absent in a fresh checkout.
 *
 * Consumers:
 *   const { gateway, orchestrator, search } = require('./orchestration-wireup');
 *
 * No UI changes. No route changes. Just internal wiring behind Express.
 */

let _singleton = null;

function createOrchestrationWireup(env = process.env) {
  const { LLMGateway } = require('./llm-gateway');
  const { createOrchestrationContext } = require('./orchestration-context');

  const ctx = createOrchestrationContext({ env });

  const gateway = new LLMGateway({
    env,
    cache: ctx.semanticCache,
    tracer: ctx.langfuseTracer,
  });

  // Lazy orchestrator — falls back to sequential runner when @langchain/langgraph
  // or PG checkpoints are not available.
  let _orchestrator = null;
  function getOrchestrator() {
    if (!_orchestrator) {
      const { createLangGraphOrchestrator } = require('./langgraph-engine');
      _orchestrator = createLangGraphOrchestrator({
        gateway,
        checkpointStore: ctx.checkpointStore,
        tracer: ctx.langfuseTracer,
        tools: ctx.toolRegistry,
        logger: ctx.logger,
      });
    }
    return _orchestrator;
  }

  // Lazy document parser dispatch — uses Marker/Docling/MarkItDown Python CLIs
  // when available, falling back to Node.js-native parsers.
  let _documentParser = null;
  function getDocumentParser() {
    if (!_documentParser) {
      const { createDocumentParserDispatch } = require('./document-parser-dispatch');
      _documentParser = createDocumentParserDispatch({ env });
    }
    return _documentParser;
  }

  return {
    gateway,
    getOrchestrator,
    getDocumentParser,
    semanticCache: ctx.semanticCache,
    checkpointStore: ctx.checkpointStore,
    r2Storage: ctx.r2Storage,
    memoryAdapter: ctx.memoryAdapter,
    sse: ctx.sse,
    search: ctx.search,
    multichannel: ctx.multichannel,
    multiAgent: ctx.multiAgent,
    langfuseTracer: ctx.langfuseTracer,
    logger: ctx.logger,

    /** Health probe — reports status of every orchestration subsystem */
    async health() {
      const checks = {
        gateway: true,
        semanticCache: ctx.semanticCache?.enabled ?? false,
        r2Storage: ctx.r2Storage?.enabled ?? false,
        checkpointStore:
          Boolean(ctx.checkpointStore?.put) && Boolean(ctx.checkpointStore?.get),
        memory: ctx.memoryAdapter?.capabilities?.() ?? {},
        search: {
          tavily: Boolean(env.TAVILY_API_KEY),
          exa: Boolean(env.EXA_API_KEY),
          firecrawl: Boolean(env.FIRECRAWL_API_KEY),
          searxng: Boolean(env.SEARXNG_URL),
        },
        multichannel: {
          enabled: env.OPENCLAW_ENABLED === 'true',
          channels: (env.OPENCLAW_CHANNELS || '').split(',').filter(Boolean),
        },
        multiAgent: {
          framework: env.SIRAGPT_MULTI_AGENT_FRAMEWORK || 'builtin',
        },
      };
      return checks;
    },
  };
}

function getOrchestrationWireup(env = process.env) {
  if (!_singleton) {
    _singleton = createOrchestrationWireup(env);
  }
  return _singleton;
}

/** Reset singleton (test-only) */
function resetOrchestrationWireup() {
  _singleton = null;
}

module.exports = {
  createOrchestrationWireup,
  getOrchestrationWireup,
  resetOrchestrationWireup,
};
