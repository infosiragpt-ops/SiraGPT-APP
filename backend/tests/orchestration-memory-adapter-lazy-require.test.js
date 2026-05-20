'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

// Verifies the orchestration memory-adapter loads even when its optional
// external deps (`@prisma/client`) are not installed. They must only be
// resolved on first real call (prune). Mirrors the lazy-require pattern from
// llm-gateway.js, user-memory-store.js, and the document-* analyzers.

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

test('memory-adapter loads when optional dep (@prisma/client) is missing', () => {
  const missing = new Set(['@prisma/client']);
  withMissingModules(missing, () => {
    const mod = freshRequire('../src/orchestration/memory-adapter');
    assert.equal(typeof mod.createMemoryAdapter, 'function');
    assert.equal(typeof mod.addShortTerm, 'function');
    assert.equal(typeof mod.recallShortTerm, 'function');
    assert.equal(typeof mod.expireShortTerm, 'function');
    // Constructing the adapter should not eagerly resolve @prisma/client.
    const adapter = mod.createMemoryAdapter();
    assert.ok(adapter, 'adapter instance should construct without optional deps');
    assert.equal(typeof adapter.recall, 'function');
    assert.equal(typeof adapter.prune, 'function');
  });
});

test('memory-adapter capabilities() works without @prisma/client present', () => {
  const missing = new Set(['@prisma/client']);
  withMissingModules(missing, () => {
    const mod = freshRequire('../src/orchestration/memory-adapter');
    const adapter = mod.createMemoryAdapter();
    const caps = adapter.capabilities();
    assert.equal(caps.mem0Compatible, true);
    assert.equal(caps.semantic, true);
    assert.equal(caps.episodic, true);
    assert.equal(typeof caps.pgvector, 'boolean');
  });
});

test('memory-adapter short-term add/recall works without optional deps', () => {
  const missing = new Set(['@prisma/client']);
  withMissingModules(missing, () => {
    const mod = freshRequire('../src/orchestration/memory-adapter');
    const adapter = mod.createMemoryAdapter();
    adapter.add('user-1', 'hello world from siragpt', { importance: 0.3 });
    const results = mod.recallShortTerm('user-1', 'hello', 5);
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 1);
    assert.equal(results[0].source, 'short_term');
  });
});
