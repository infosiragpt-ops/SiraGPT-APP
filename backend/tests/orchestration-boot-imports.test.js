'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

// Integration test: the full orchestration surface (index.js + every submodule
// it re-exports) must boot-import cleanly with all common optional deps absent.
// Mirrors the lazy-require pattern already proven for individual modules
// (llm-gateway, memory-adapter, r2-storage, document-* analyzers).

const MISSING_EXACT = new Set([
  'openai',
  'opossum',
  '@anthropic-ai/sdk',
  'langfuse',
  'mem0ai',
]);

const MISSING_PREFIXES = [
  '@aws-sdk/',
  '@langchain/langgraph',
];

function isMissing(request) {
  if (MISSING_EXACT.has(request)) return true;
  for (const p of MISSING_PREFIXES) {
    if (request === p || request.startsWith(p)) return true;
  }
  return false;
}

function withMissingModules(fn) {
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function patched(request, parent, ...rest) {
    if (isMissing(request)) {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return realResolve.call(this, request, parent, ...rest);
  };
  try {
    return fn();
  } finally {
    Module._resolveFilename = realResolve;
  }
}

const ORCHESTRATION_MODULES = [
  '../src/orchestration/llm-routing.config',
  '../src/orchestration/llm-gateway',
  '../src/orchestration/agent-checkpoint-store',
  '../src/orchestration/langgraph-engine',
  '../src/orchestration/memory-adapter',
  '../src/orchestration/document-pipeline',
  '../src/orchestration/observability',
  '../src/orchestration/r2-storage',
  '../src/orchestration/r2-artifact-bridge',
  '../src/orchestration/doc-pipeline-enhancer',
  '../src/orchestration/semantic-cache',
  '../src/orchestration/sse-stream',
  '../src/orchestration/web-search-tools',
  '../src/orchestration/ai-bridge',
  '../src/orchestration/multi-agent/team-router',
  '../src/orchestration/route-enricher',
  '../src/orchestration/gateway-adapter',
  '../src/orchestration/orchestration-context',
  '../src/orchestration/orchestration-wireup',
  '../src/orchestration/multichannel/openclaw-adapter',
  '../src/orchestration/parser-adapters/marker-adapter',
  '../src/orchestration/index',
];

function purgeOrchestrationCache() {
  const marker = `${path.sep}orchestration${path.sep}`;
  for (const id of Object.keys(require.cache)) {
    if (id.includes(marker)) delete require.cache[id];
  }
}

test('orchestration full surface boot-imports without optional deps', () => {
  withMissingModules(() => {
    purgeOrchestrationCache();
    for (const m of ORCHESTRATION_MODULES) {
      const mod = require(m);
      assert.ok(
        mod && (typeof mod === 'object' || typeof mod === 'function'),
        `module ${m} should export something`,
      );
    }
  });
});

test('orchestration index aggregates submodule exports without optional deps', () => {
  withMissingModules(() => {
    purgeOrchestrationCache();
    const idx = require('../src/orchestration/index');
    assert.ok(idx && typeof idx === 'object', 'index should export an object');
    assert.ok(Object.keys(idx).length > 0, 'index should expose aggregated exports');
  });
});
