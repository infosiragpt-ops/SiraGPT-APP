'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAIBridge } = require('../src/orchestration/ai-bridge');

test('exports createAIBridge', () => {
  assert.equal(typeof createAIBridge, 'function');
});

test('capability flags reflect injected deps', () => {
  const empty = createAIBridge({});
  assert.equal(empty.hasGateway, false);
  assert.equal(empty.hasMemory, false);
  assert.equal(empty.hasSearch, false);
  assert.equal(empty.hasSSE, false);

  const full = createAIBridge({ gateway: {}, memory: {}, search: {}, sse: {} });
  assert.equal(full.hasGateway, true);
  assert.equal(full.hasMemory, true);
  assert.equal(full.hasSearch, true);
  assert.equal(full.hasSSE, true);
});

test('enrichContext returns the original prompt when memory + search are absent', async () => {
  const bridge = createAIBridge({});
  const out = await bridge.enrichContext({
    userId: 'u1',
    systemPrompt: 'base',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(out.systemPrompt, 'base');
  assert.deepEqual(out.memoryFacts, []);
  assert.deepEqual(out.searchResults, []);
});

test('enrichContext recalls memory facts and appends to system prompt', async () => {
  const memory = {
    async recall(userId, query, k) {
      assert.equal(userId, 'u1');
      assert.equal(query, 'last message');
      assert.equal(k, 5);
      return [{ content: 'fact A' }, { fact: 'fact B' }, { text: 'fact C' }];
    },
  };
  const bridge = createAIBridge({ memory });
  const out = await bridge.enrichContext({
    userId: 'u1',
    systemPrompt: 'base',
    messages: [{ role: 'user', content: 'last message' }],
  });
  assert.deepEqual(out.memoryFacts, ['fact A', 'fact B', 'fact C']);
  assert.ok(out.systemPrompt.startsWith('base'));
  assert.ok(out.systemPrompt.includes('[Relevant user memories]'));
  assert.ok(out.systemPrompt.includes('1. fact A'));
  assert.ok(out.systemPrompt.includes('3. fact C'));
});

test('enrichContext does not recall memory when userId is missing', async () => {
  let called = false;
  const memory = { async recall() { called = true; return [{ content: 'x' }]; } };
  const bridge = createAIBridge({ memory });
  const out = await bridge.enrichContext({
    userId: null,
    systemPrompt: 'base',
    messages: [{ role: 'user', content: 'msg' }],
  });
  assert.equal(called, false, 'memory.recall must not be called without userId');
  assert.deepEqual(out.memoryFacts, []);
});

test('enrichContext swallows memory recall errors without breaking', async () => {
  const memory = { async recall() { throw new Error('mem boom'); } };
  const bridge = createAIBridge({ memory });
  const out = await bridge.enrichContext({
    userId: 'u1',
    systemPrompt: 'base',
    messages: [{ role: 'user', content: 'msg' }],
  });
  assert.equal(out.systemPrompt, 'base', 'failure must not mutate the prompt');
  assert.deepEqual(out.memoryFacts, []);
});

test('enrichContext skips web search when prompt does not need fresh context', async () => {
  let searchCalled = false;
  const search = {
    needsFreshWebContext: () => false,
    async searchFreshContext() { searchCalled = true; return { results: [] }; },
  };
  const bridge = createAIBridge({ search });
  await bridge.enrichContext({
    userId: 'u1',
    systemPrompt: 'base',
    messages: [{ role: 'user', content: 'static question' }],
  });
  assert.equal(searchCalled, false);
});

test('enrichContext runs web search and folds it into system prompt when needed', async () => {
  const search = {
    needsFreshWebContext: (text) => /noticias/.test(text),
    async searchFreshContext(query) {
      return {
        results: [
          { title: 'News1', content: 'body1' },
          { title: 'News2', snippet: 'body2' },
        ],
      };
    },
  };
  const bridge = createAIBridge({ search });
  const out = await bridge.enrichContext({
    userId: 'u1',
    systemPrompt: 'base',
    messages: [{ role: 'user', content: 'cuáles son las noticias de hoy' }],
  });
  assert.equal(out.searchResults.length, 2);
  assert.ok(out.systemPrompt.includes('[Fresh web context]'));
  assert.ok(out.systemPrompt.includes('News1'));
});

test('invokeLLM returns null when gateway has no complete()', async () => {
  const bridge = createAIBridge({});
  assert.equal(await bridge.invokeLLM({ messages: [] }), null);

  const stub = createAIBridge({ gateway: {} }); // gateway present but no .complete
  assert.equal(await stub.invokeLLM({ messages: [] }), null);
});

test('invokeLLM forwards args and userId via cacheContext', async () => {
  let captured = null;
  const gateway = { async complete(args) { captured = args; return { text: 'ok' }; } };
  const bridge = createAIBridge({ gateway });
  const out = await bridge.invokeLLM({
    messages: [{ role: 'user', content: 'q' }],
    prompt: 'system',
    taskType: 'speed',
    temperature: 0.9,
    userId: 'u-7',
    cacheContext: { hint: 'fast' },
  });
  assert.deepEqual(out, { text: 'ok' });
  assert.equal(captured.taskType, 'speed');
  assert.equal(captured.temperature, 0.9);
  assert.equal(captured.cacheContext.userId, 'u-7');
  assert.equal(captured.cacheContext.hint, 'fast');
});

test('invokeLLM returns error envelope when gateway throws', async () => {
  const gateway = { async complete() { const err = new Error('rate-limited'); err.causes = ['provider:openai']; throw err; } };
  const bridge = createAIBridge({ gateway });
  const out = await bridge.invokeLLM({ messages: [], userId: 'u' });
  assert.equal(out.error, 'rate-limited');
  assert.equal(out.provider, 'none');
  assert.equal(out.model, 'none');
  assert.deepEqual(out.causes, ['provider:openai']);
});

test('embedText returns null when gateway has no embed', async () => {
  const bridge = createAIBridge({});
  assert.equal(await bridge.embedText('input'), null);
  const stub = createAIBridge({ gateway: {} });
  assert.equal(await stub.embedText('input'), null);
});

test('embedText forwards input + opts to gateway.embed', async () => {
  let captured = null;
  const gateway = { async embed(args) { captured = args; return { vector: [0.1, 0.2] }; } };
  const bridge = createAIBridge({ gateway });
  const out = await bridge.embedText('hello', { model: 'voyage-3-large' });
  assert.deepEqual(out.vector, [0.1, 0.2]);
  assert.equal(captured.input, 'hello');
  assert.equal(captured.model, 'voyage-3-large');
});

test('embedText returns null when gateway.embed throws', async () => {
  const gateway = { async embed() { throw new Error('embed-boom'); } };
  const bridge = createAIBridge({ gateway });
  assert.equal(await bridge.embedText('x'), null);
});

test('attachSSEWithReplay returns null when sse is absent or lacks attachSSEStream', () => {
  assert.equal(createAIBridge({}).attachSSEWithReplay({}, {}), null);
  assert.equal(createAIBridge({ sse: { buffer: {} } }).attachSSEWithReplay({}, {}), null);
});

test('attachSSEWithReplay delegates to sse.attachSSEStream with buffer', () => {
  let received = null;
  const sse = {
    buffer: { id: 'buf' },
    attachSSEStream(req, res, buffer) { received = { req, res, buffer }; return { ok: true }; },
  };
  const bridge = createAIBridge({ sse });
  const req = { reqId: 1 };
  const res = { resId: 2 };
  const out = bridge.attachSSEWithReplay(req, res);
  assert.deepEqual(out, { ok: true });
  assert.equal(received.req, req);
  assert.equal(received.res, res);
  assert.equal(received.buffer.id, 'buf');
});
