'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

// Verifies the orchestration LLM gateway loads even when its heavy SDK deps
// (`openai`, `opossum`) are not installed. They must only be resolved on first
// real call (clientFor / getBreaker). Mirrors the lazy-require pattern from
// document-* analyzers and r2-storage.js.

function withMissingModules(missing, fn) {
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function patched(request, parent, ...rest) {
    if (missing.has(request)) {
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

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

test('llm-gateway loads when optional SDK deps (openai, opossum) are missing', () => {
  const missing = new Set(['openai', 'opossum']);
  withMissingModules(missing, () => {
    const mod = freshRequire('../src/orchestration/llm-gateway');
    assert.ok(mod.LLMGateway, 'LLMGateway should be exported');
    assert.equal(typeof mod.classifyRateLimit, 'function');
    assert.equal(typeof mod.jitteredBackoff, 'function');
    assert.equal(typeof mod.scoreProvider, 'function');
    // Constructing the gateway should not eagerly resolve openai/opossum.
    const gw = new mod.LLMGateway({ env: {}, cache: { get: async () => null, set: async () => {} }, tracer: { startSpan: () => null } });
    assert.ok(gw, 'gateway instance should construct without optional deps');
  });
});

test('llm-gateway only resolves openai when clientFor is actually invoked', () => {
  const missing = new Set(['openai']);
  withMissingModules(missing, () => {
    const mod = freshRequire('../src/orchestration/llm-gateway');
    const gw = new mod.LLMGateway({ env: { OPENAI_API_KEY: 'sk-test' }, cache: { get: async () => null, set: async () => {} }, tracer: { startSpan: () => null } });
    // clientFor should throw the MODULE_NOT_FOUND from the lazy loader, proving
    // the dep is only touched at call time.
    assert.throws(
      () => gw.clientFor({ id: 'openai', envKey: 'OPENAI_API_KEY' }),
      err => err && /Cannot find module 'openai'/.test(err.message),
    );
  });
});
