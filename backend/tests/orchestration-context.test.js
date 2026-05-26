'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrchestrationContext } = require('../src/orchestration/orchestration-context');

test('exports createOrchestrationContext', () => {
  assert.equal(typeof createOrchestrationContext, 'function');
});

test('context exposes eager subsystems on creation', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  // Eagerly initialized
  assert.ok(ctx.semanticCache, 'semanticCache must be created eagerly');
  assert.ok(ctx.langfuseTracer, 'langfuseTracer must be created eagerly');
});

test('context exposes lazy subsystem getters', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  for (const field of ['r2Storage', 'checkpointStore', 'memoryAdapter', 'sse', 'search', 'multichannel', 'multiAgent', 'toolRegistry', 'logger']) {
    assert.ok(field in ctx, `context must expose ${field}`);
    const value = ctx[field];
    assert.ok(value !== undefined, `${field} getter must not return undefined`);
  }
});

test('lazy subsystems memoize across accesses (same instance)', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  const r2A = ctx.r2Storage;
  const r2B = ctx.r2Storage;
  assert.equal(r2A, r2B, 'r2Storage must be memoized');

  const cpA = ctx.checkpointStore;
  const cpB = ctx.checkpointStore;
  assert.equal(cpA, cpB, 'checkpointStore must be memoized');

  const memA = ctx.memoryAdapter;
  const memB = ctx.memoryAdapter;
  assert.equal(memA, memB, 'memoryAdapter must be memoized');

  const sseA = ctx.sse;
  const sseB = ctx.sse;
  assert.equal(sseA, sseB, 'sse module must be memoized');
});

test('search lazy field exposes the expected web-search surface', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  const search = ctx.search;
  assert.ok(search, 'search must be exposed');
  assert.equal(typeof search.searchFreshContext, 'function');
  assert.equal(typeof search.needsFreshWebContext, 'function');
});

test('multichannel lazy field exposes the openclaw adapter', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  const mc = ctx.multichannel;
  assert.ok(mc, 'multichannel must be exposed');
  // openclaw-adapter exports createOpenClawAdapter + resolveOpenClawConfig
  assert.equal(typeof mc.createOpenClawAdapter, 'function');
  assert.equal(typeof mc.resolveOpenClawConfig, 'function');
});

test('multiAgent lazy field exposes the team-router', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  const ma = ctx.multiAgent;
  assert.ok(ma, 'multiAgent must be exposed');
});

test('logger lazy field exposes a usable logger (pino or console fallback)', () => {
  const ctx = createOrchestrationContext({ env: { ...process.env } });
  const logger = ctx.logger;
  assert.ok(logger, 'logger must be exposed');
  // Either pino-shaped or plain console — both have these methods
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.warn, 'function');
  assert.equal(typeof logger.error, 'function');
});

test('separate contexts have independent state', () => {
  const ctxA = createOrchestrationContext({ env: { ...process.env } });
  const ctxB = createOrchestrationContext({ env: { ...process.env } });
  // Eager subsystems are created per-context
  assert.notEqual(ctxA.semanticCache, ctxB.semanticCache, 'each context has its own semanticCache');
  assert.notEqual(ctxA.r2Storage, ctxB.r2Storage, 'each context has its own r2Storage');
});

test('context accepts custom env without mutating process.env', () => {
  const customEnv = {
    TAVILY_API_KEY: 'fake',
    SOMETHING_NEW: 'value',
  };
  const ctx = createOrchestrationContext({ env: customEnv });
  assert.ok(ctx, 'context must be created with custom env');
  // process.env should not have been polluted
  assert.equal(process.env.SOMETHING_NEW, undefined);
});
