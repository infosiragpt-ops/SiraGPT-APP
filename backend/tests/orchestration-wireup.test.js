'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const wireupModule = require('../src/orchestration/orchestration-wireup');

test.beforeEach(() => {
  wireupModule.resetOrchestrationWireup();
});

test('exports the expected public surface', () => {
  assert.equal(typeof wireupModule.createOrchestrationWireup, 'function');
  assert.equal(typeof wireupModule.getOrchestrationWireup, 'function');
  assert.equal(typeof wireupModule.resetOrchestrationWireup, 'function');
});

test('getOrchestrationWireup returns the same singleton across calls', () => {
  const env = { ...process.env };
  const a = wireupModule.getOrchestrationWireup(env);
  const b = wireupModule.getOrchestrationWireup(env);
  assert.equal(a, b, 'second call should return the cached instance');
});

test('resetOrchestrationWireup clears the singleton so a new instance is built', () => {
  const env = { ...process.env };
  const first = wireupModule.getOrchestrationWireup(env);
  wireupModule.resetOrchestrationWireup();
  const second = wireupModule.getOrchestrationWireup(env);
  assert.notEqual(first, second, 'after reset, a fresh instance must be created');
});

test('wireup exposes the documented surface', () => {
  const w = wireupModule.getOrchestrationWireup({ ...process.env });
  assert.ok(w.gateway, 'gateway must be present');
  assert.equal(typeof w.getOrchestrator, 'function');
  assert.equal(typeof w.getDocumentParser, 'function');
  assert.equal(typeof w.health, 'function');
  // Adjacent subsystems exposed for callers that don't want to reach into the gateway
  for (const field of ['semanticCache', 'checkpointStore', 'r2Storage', 'memoryAdapter', 'sse', 'search', 'multichannel', 'multiAgent']) {
    assert.ok(field in w, `wireup must expose ${field}`);
  }
});

test('health() returns subsystem snapshot with expected shape', async () => {
  const w = wireupModule.getOrchestrationWireup({ ...process.env });
  const snapshot = await w.health();
  assert.equal(typeof snapshot.gateway, 'boolean');
  assert.equal(typeof snapshot.semanticCache, 'boolean');
  assert.equal(typeof snapshot.r2Storage, 'boolean');
  assert.equal(typeof snapshot.checkpointStore, 'boolean');
  assert.equal(typeof snapshot.memory, 'object');
  assert.equal(typeof snapshot.search, 'object');
  assert.equal(typeof snapshot.multichannel, 'object');
  assert.equal(typeof snapshot.multiAgent, 'object');
});

test('health() reflects search keys from env', async () => {
  const env = {
    ...process.env,
    TAVILY_API_KEY: 'test-tavily',
    EXA_API_KEY: '',
    FIRECRAWL_API_KEY: '',
    SEARXNG_URL: '',
  };
  const w = wireupModule.getOrchestrationWireup(env);
  const snapshot = await w.health();
  assert.equal(snapshot.search.tavily, true, 'tavily key present -> true');
  assert.equal(snapshot.search.exa, false, 'no exa key -> false');
  assert.equal(snapshot.search.firecrawl, false);
  assert.equal(snapshot.search.searxng, false);
});

test('health() reflects OpenClaw enabled flag from env', async () => {
  const enabledEnv = { ...process.env, OPENCLAW_ENABLED: 'true', OPENCLAW_CHANNELS: 'whatsapp,telegram' };
  const w1 = wireupModule.getOrchestrationWireup(enabledEnv);
  const s1 = await w1.health();
  assert.equal(s1.multichannel.enabled, true);
  assert.deepEqual(s1.multichannel.channels, ['whatsapp', 'telegram']);

  wireupModule.resetOrchestrationWireup();

  const disabledEnv = { ...process.env, OPENCLAW_ENABLED: 'false' };
  const w2 = wireupModule.getOrchestrationWireup(disabledEnv);
  const s2 = await w2.health();
  assert.equal(s2.multichannel.enabled, false);
});

test('health() reports the configured multi-agent framework', async () => {
  const env = { ...process.env, SIRAGPT_MULTI_AGENT_FRAMEWORK: 'crewai' };
  const w = wireupModule.getOrchestrationWireup(env);
  const snapshot = await w.health();
  assert.equal(snapshot.multiAgent.framework, 'crewai');
});
