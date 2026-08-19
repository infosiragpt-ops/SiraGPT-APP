'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouteEnricher, getRouteEnricher } = require('../src/orchestration/route-enricher');

function makeReq(orchestration = null) {
  return { app: { locals: { orchestration } } };
}

test('exports createRouteEnricher and getRouteEnricher', () => {
  assert.equal(typeof createRouteEnricher, 'function');
  assert.equal(typeof getRouteEnricher, 'function');
});

test('getRouteEnricher returns the same singleton across calls', () => {
  const a = getRouteEnricher();
  const b = getRouteEnricher();
  assert.equal(a, b);
});

test('enricher exposes the documented surface', () => {
  const enricher = createRouteEnricher();
  const expected = [
    'enrichSystemPrompt',
    'tryGatewayComplete',
    'attachSSE',
    'tryGatewayEmbed',
    'persistMemoryFact',
    'hasDocumentPipeline',
    'getR2Storage',
    'getWebSearch',
  ];
  for (const name of expected) {
    assert.equal(typeof enricher[name], 'function', `expected function: ${name}`);
  }
});

test('enrichSystemPrompt returns original prompt when orchestration is missing', async () => {
  const enricher = createRouteEnricher();
  const original = 'You are SiraGPT.';
  const out = await enricher.enrichSystemPrompt(makeReq(null), 'user-1', 'hello', original);
  assert.equal(out, original);
});

test('enrichSystemPrompt returns original when bridge has neither memory nor search', async () => {
  const enricher = createRouteEnricher();
  const original = 'system prompt';
  const orch = { bridge: { hasMemory: false, hasSearch: false } };
  const out = await enricher.enrichSystemPrompt(makeReq(orch), 'u', 'hi', original);
  assert.equal(out, original);
});

test('enrichSystemPrompt invokes bridge.enrichContext when available', async () => {
  const enricher = createRouteEnricher();
  let received = null;
  const orch = {
    bridge: {
      hasMemory: true,
      hasSearch: true,
      async enrichContext(payload) {
        received = payload;
        return { systemPrompt: 'enriched: ' + (payload.systemPrompt || '') };
      },
    },
  };
  const out = await enricher.enrichSystemPrompt(makeReq(orch), 'user-42', 'question', 'base');
  assert.equal(out, 'enriched: base');
  assert.equal(received.userId, 'user-42');
  assert.equal(received.systemPrompt, 'base');
  assert.deepEqual(received.messages, [{ role: 'user', content: 'question' }]);
});

test('enrichSystemPrompt falls back to original when bridge throws', async () => {
  const enricher = createRouteEnricher();
  const original = 'fallback';
  const orch = {
    bridge: {
      hasMemory: true,
      async enrichContext() { throw new Error('boom'); },
    },
  };
  const out = await enricher.enrichSystemPrompt(makeReq(orch), 'u', 'q', original);
  assert.equal(out, original);
});

test('tryGatewayComplete returns null when bridge has no gateway', async () => {
  const enricher = createRouteEnricher();
  const orch = { bridge: { hasGateway: false } };
  const out = await enricher.tryGatewayComplete(makeReq(orch), { messages: [] });
  assert.equal(out, null);
});

test('tryGatewayComplete returns null when orchestration is missing', async () => {
  const enricher = createRouteEnricher();
  const out = await enricher.tryGatewayComplete(makeReq(null), { messages: [] });
  assert.equal(out, null);
});

test('tryGatewayComplete forwards args to bridge.invokeLLM', async () => {
  const enricher = createRouteEnricher();
  let captured = null;
  const orch = {
    bridge: {
      hasGateway: true,
      async invokeLLM(args) { captured = args; return { content: 'ok' }; },
    },
  };
  const out = await enricher.tryGatewayComplete(makeReq(orch), {
    messages: [{ role: 'user', content: 'hi' }],
    taskType: 'speed',
    temperature: 0.2,
    userId: 'u-1',
  });
  assert.deepEqual(out, { content: 'ok' });
  assert.equal(captured.taskType, 'speed');
  assert.equal(captured.userId, 'u-1');
  assert.equal(captured.temperature, 0.2);
});

test('attachSSE returns null when bridge has no SSE capability', () => {
  const enricher = createRouteEnricher();
  assert.equal(enricher.attachSSE(makeReq(null), {}), null);
  assert.equal(enricher.attachSSE(makeReq({ bridge: { hasSSE: false } }), {}), null);
});

test('attachSSE delegates to bridge.attachSSEWithReplay when available', () => {
  const enricher = createRouteEnricher();
  let called = false;
  const orch = {
    bridge: {
      hasSSE: true,
      attachSSEWithReplay(req, res) { called = true; return { ok: true, req, res }; },
    },
  };
  const fakeRes = { sse: true };
  const result = enricher.attachSSE(makeReq(orch), fakeRes);
  assert.ok(called);
  assert.equal(result.ok, true);
  assert.equal(result.res, fakeRes);
});

test('hasDocumentPipeline reflects orchestration.configured.memory', () => {
  const enricher = createRouteEnricher();
  assert.equal(enricher.hasDocumentPipeline(makeReq(null)), false);
  assert.equal(enricher.hasDocumentPipeline(makeReq({ configured: { memory: false } })), false);
  assert.equal(enricher.hasDocumentPipeline(makeReq({ configured: { memory: true } })), true);
});

test('getR2Storage returns orchestration.r2 when present', () => {
  const enricher = createRouteEnricher();
  assert.equal(enricher.getR2Storage(makeReq(null)), null);
  const r2 = { upload: () => {} };
  assert.equal(enricher.getR2Storage(makeReq({ r2 })), r2);
});

test('getWebSearch returns orchestration.search when present', () => {
  const enricher = createRouteEnricher();
  assert.equal(enricher.getWebSearch(makeReq(null)), null);
  const search = { searchFreshContext: () => {} };
  assert.equal(enricher.getWebSearch(makeReq({ search })), search);
});

test('tryGatewayEmbed returns null when bridge is missing and forwards otherwise', async () => {
  const enricher = createRouteEnricher();
  assert.equal(await enricher.tryGatewayEmbed(makeReq(null), 'text'), null);
  const orch = {
    bridge: {
      async embedText(input, opts) {
        return { vector: [1, 2, 3], input, opts };
      },
    },
  };
  const out = await enricher.tryGatewayEmbed(makeReq(orch), 'hello', { model: 'voyage-3-large' });
  assert.deepEqual(out.vector, [1, 2, 3]);
  assert.equal(out.input, 'hello');
  assert.equal(out.opts.model, 'voyage-3-large');
});
