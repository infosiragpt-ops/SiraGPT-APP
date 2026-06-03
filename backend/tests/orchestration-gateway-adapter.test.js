'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  enrichWithWebSearch,
  gatewayComplete,
  getCache,
  getTracer,
  getMemoryAdapter,
  getSSEBuffer,
  enrichUserContext,
  embedTexts,
  resetOrchestrationCache,
  toOpenAIResponseFormat,
} = require('../src/orchestration/gateway-adapter');
const { needsFreshWebContext } = require('../src/orchestration/web-search-tools');

test('gateway-adapter exports all expected functions', function() {
  assert.equal(typeof enrichWithWebSearch, 'function');
  assert.equal(typeof gatewayComplete, 'function');
  assert.equal(typeof getCache, 'function');
  assert.equal(typeof getTracer, 'function');
  assert.equal(typeof getMemoryAdapter, 'function');
  assert.equal(typeof getSSEBuffer, 'function');
  assert.equal(typeof enrichUserContext, 'function');
  assert.equal(typeof embedTexts, 'function');
  assert.equal(typeof resetOrchestrationCache, 'function');
  assert.equal(typeof toOpenAIResponseFormat, 'function');
});

test('enrichWithWebSearch returns null for non-fresh queries', async function() {
  var result = await enrichWithWebSearch('explique la teoria de grafos', { env: {} });
  assert.equal(result, null);
});

test('enrichWithWebSearch returns null when no paid keys and free tier is empty', async function() {
  assert.ok(needsFreshWebContext('cual es la noticia mas actual sobre AI hoy 2026'));
  // Stub the free tier empty so this stays hermetic and asserts the no-results path.
  var freeSearch = { search: async function() { return { results: [], provider: null }; } };
  var result = await enrichWithWebSearch('cual es la noticia mas actual sobre AI hoy 2026', { env: {}, freeSearch });
  assert.equal(result, null);
});

test('enrichWithWebSearch injects fresh context via free key-less tier when no paid keys', async function() {
  var freeSearch = {
    search: async function() {
      return { results: [{ title: 'AI hoy', url: 'https://example.org/ai', snippet: 'novedad' }], provider: 'duckduckgo' };
    },
  };
  var result = await enrichWithWebSearch('cual es la noticia mas actual sobre AI hoy 2026', { env: {}, freeSearch });
  assert.ok(result);
  assert.equal(result.source, 'free:duckduckgo');
  assert.ok(result.block.includes('Fresh Web Context'));
  assert.ok(result.block.includes('AI hoy'));
});

test('enrichWithWebSearch returns null on network failure', async function() {
  var failingFetch = function() { throw new Error('network unreachable'); };
  // Free tier also disabled so nothing falls back to real network.
  var result = await enrichWithWebSearch('noticias de ultima hora sobre el clima hoy', {
    env: {},
    fetchImpl: failingFetch,
    disableFreeTier: true,
  });
  assert.equal(result, null);
});

test('getTracer returns tracer object with expected methods', function() {
  resetOrchestrationCache();
  var tracer = getTracer();
  assert.equal(typeof tracer, 'object');
  assert.equal(typeof tracer.startSpan, 'function');
  assert.equal(typeof tracer.enabled, 'boolean');
});

test('getTracer is disabled without Langfuse keys', function() {
  resetOrchestrationCache();
  var tracer = getTracer({ env: {} });
  assert.equal(tracer.enabled, false);
});

test('getMemoryAdapter returns adapter or null when DB unavailable', function() {
  resetOrchestrationCache();
  var adapter = getMemoryAdapter();
  if (adapter === null) {
    assert.ok(true, 'memory adapter gracefully returned null without DB');
    return;
  }
  assert.equal(typeof adapter, 'object');
  assert.equal(typeof adapter.recall, 'function');
  assert.equal(typeof adapter.buildMemoryPrompt, 'function');
  assert.equal(typeof adapter.storeFact, 'function');
  assert.equal(typeof adapter.capabilities, 'function');
});

test('getMemoryAdapter capabilities include pgvector, rag, mem0Compatible when available', function() {
  resetOrchestrationCache();
  var adapter = getMemoryAdapter();
  if (adapter === null) {
    assert.ok(true, 'memory adapter gracefully returned null without DB');
    return;
  }
  var caps = adapter.capabilities();
  assert.equal(typeof caps.pgvector, 'boolean');
  assert.equal(caps.rag, true);
  assert.equal(caps.mem0Compatible, true);
  assert.equal(caps.semantic, true);
  assert.equal(caps.episodic, true);
});

test('getSSEBuffer returns replay buffer with push and since', function() {
  resetOrchestrationCache();
  var buffer = getSSEBuffer();
  assert.equal(typeof buffer.push, 'function');
  assert.equal(typeof buffer.since, 'function');
  assert.equal(buffer.size(), 0);
  buffer.push('token', { text: 'hello' });
  assert.ok(buffer.size() >= 1);
  var events = buffer.since('0');
  assert.ok(events.length >= 1);
});

test('toOpenAIResponseFormat converts Anthropic response to OpenAI format', function() {
  var anthropicResult = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    response: {
      content: [{ text: 'Hello from Anthropic', type: 'text' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  var result = toOpenAIResponseFormat(anthropicResult);
  assert.ok(result.choices);
  assert.equal(result.choices[0].message.content, 'Hello from Anthropic');
  assert.equal(result.choices[0].message.role, 'assistant');
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.model, 'claude-opus-4-7');
});

test('toOpenAIResponseFormat returns null for null input', function() {
  assert.equal(toOpenAIResponseFormat(null), null);
});

test('toOpenAIResponseFormat passes through OpenAI-format responses', function() {
  var openaiResult = {
    provider: 'openai',
    model: 'gpt-4o',
    response: {
      choices: [{ message: { content: 'Hello', role: 'assistant' }, index: 0 }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      model: 'gpt-4o',
    },
  };
  var result = toOpenAIResponseFormat(openaiResult);
  assert.equal(result.choices[0].message.content, 'Hello');
  assert.equal(result.usage.total_tokens, 8);
});

test('enrichUserContext returns empty object when no userId', async function() {
  var result = await enrichUserContext({ userId: null, prompt: 'test' });
  assert.deepEqual(result, {});
});

test('embedTexts returns empty array for empty input', async function() {
  var result = await embedTexts([]);
  assert.deepEqual(result, []);
});

test('resetOrchestrationCache clears all singletons', function() {
  getTracer({ env: {} });
  getSSEBuffer();
  resetOrchestrationCache();
  var fresh = getTracer({ env: {} });
  assert.equal(typeof fresh, 'object');
  assert.equal(typeof fresh.startSpan, 'function');
});

test('tracer span lifecycle is best-effort and never throws', function() {
  resetOrchestrationCache();
  var tracer = getTracer({ env: {} });
  var threw = false;
  try {
    var span = tracer.startSpan('test.span', { foo: 'bar' });
    assert.equal(typeof span, 'object');
    assert.equal(typeof span.end, 'function');
    span.end({ result: 'ok' });
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false);
});
