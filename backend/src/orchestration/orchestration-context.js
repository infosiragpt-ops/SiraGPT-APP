'use strict';

/**
 * orchestration-context — lazy-resolved context bag with all orchestration
 * subsystems. Each subsystem is only loaded on first access, keeping the
 * initial require() lightweight. No UI dependency.
 */

const { createUpstashSemanticCache } = require('./semantic-cache');
const { createLangfuseTracer } = require('./observability');
const { createAgentCheckpointStore } = require('./agent-checkpoint-store');
const { createR2ArtifactStorage } = require('./r2-storage');
const { createMemoryAdapter } = require('./memory-adapter');

function createOrchestrationContext({ env = process.env } = {}) {
  const semanticCache = createUpstashSemanticCache({ env });
  const langfuseTracer = createLangfuseTracer({ env });

  let _r2Storage = null;
  function getR2Storage() {
    if (!_r2Storage) _r2Storage = createR2ArtifactStorage({ env });
    return _r2Storage;
  }

  let _checkpointStore = null;
  function getCheckpointStore() {
    if (!_checkpointStore) _checkpointStore = createAgentCheckpointStore();
    return _checkpointStore;
  }

  let _memoryAdapter = null;
  function getMemoryAdapter() {
    if (!_memoryAdapter) _memoryAdapter = createMemoryAdapter();
    return _memoryAdapter;
  }

  // Lazy SSE module
  let _sse = null;
  function getSSE() {
    if (!_sse) _sse = require('./sse-stream');
    return _sse;
  }

  // Lazy search module
  let _search = null;
  function getSearch() {
    if (!_search) {
      const web = require('./web-search-tools');
      _search = { searchFreshContext: web.searchFreshContext, needsFreshWebContext: web.needsFreshWebContext };
    }
    return _search;
  }

  // Lazy multichannel
  let _multichannel = null;
  function getMultichannel() {
    if (!_multichannel) _multichannel = require('./multichannel/openclaw-adapter');
    return _multichannel;
  }

  // Lazy multi-agent
  let _multiAgent = null;
  function getMultiAgent() {
    if (!_multiAgent) _multiAgent = require('./multi-agent/team-router');
    return _multiAgent;
  }

  // Lazy tool registry from agent-tools
  let _toolRegistry = null;
  function getToolRegistry() {
    if (!_toolRegistry) {
      try { _toolRegistry = require('../services/agents/agent-tools'); } catch (_) { _toolRegistry = {}; }
    }
    return _toolRegistry;
  }

  // Lazy logger — use pino if available, else console
  let _logger = null;
  function getLogger() {
    if (!_logger) {
      try {
        _logger = require('../utils/logger');
      } catch (_) {
        _logger = console;
      }
    }
    return _logger;
  }

  return {
    semanticCache,
    langfuseTracer,
    get r2Storage() { return getR2Storage(); },
    get checkpointStore() { return getCheckpointStore(); },
    get memoryAdapter() { return getMemoryAdapter(); },
    get sse() { return getSSE(); },
    get search() { return getSearch(); },
    get multichannel() { return getMultichannel(); },
    get multiAgent() { return getMultiAgent(); },
    get toolRegistry() { return getToolRegistry(); },
    get logger() { return getLogger(); },
  };
}

module.exports = { createOrchestrationContext };
