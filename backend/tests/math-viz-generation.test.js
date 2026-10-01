'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveMath, streamSolve } = require('../src/services/math-solver');
const { generateViz, streamViz } = require('../src/services/viz-generator');
const { parseStructuredObject, clientForModel } = require('../src/services/ai/structured-generation');

const math = { topic: 'algebra', explanation: 'Sumamos 2 y 3.', python: '', answer_latex: '5' };
const viz = { format: 'chartjs', title: 'Datos proporcionados', explanation: 'Valores originales.', payload: {
  config: { type: 'bar', data: { labels: ['A', 'B'], datasets: [{ label: 'Ventas', data: [0, -3.5] }] } },
} };
const env = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']
  .map((key) => [key, 'test-structured-generation']));

function wire(raw, { status = 200, finishReason = 'stop' } = {}) {
  const requests = [];
  return { requests, clientOptions: { env, fetchImpl: async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), signal: options.signal });
    return new Response(JSON.stringify(status === 200
      ? { choices: [{ message: { content: raw }, finish_reason: finishReason }] }
      : { error: { message: raw } }), { status, headers: { 'content-type': 'application/json' } });
  } } };
}

for (const [surface, run, response] of [['math', solveMath, math], ['viz', generateViz, viz]]) {
  for (const [model, host, sentModel] of [
    ['grok-4.7', 'api.x.ai', 'grok-4.7'], ['x-ai/grok-4.7', 'api.x.ai', 'grok-4.7'],
    ['google/gemini-3.5-flash', 'generativelanguage.googleapis.com', 'gemini-3.5-flash'],
    ['deepseek-v4-flash', 'api.deepseek.com', 'deepseek-v4-flash'],
    ['deepseek/deepseek-v4-pro', 'api.deepseek.com', 'deepseek-v4-pro'],
    ['gpt-6-sol', 'api.openai.com', 'gpt-6-sol'],
    ['gpt-5', 'api.openai.com', 'gpt-5'],
    ['qwen/qwen3', 'openrouter.ai', 'qwen/qwen3'],
  ]) {
    test(`${surface} sends ${model} to its selected API without switching models`, async () => {
      const mock = wire(JSON.stringify(response));
      const result = await run({ prompt: 'Usa los valores originales.', model, clientOptions: mock.clientOptions });
      assert.equal(mock.requests.length, 1);
      assert.equal(new URL(mock.requests[0].url).hostname, host);
      assert.equal(mock.requests[0].body.model, sentModel);
      assert.ok(result.content);
      if (host === 'api.openai.com') {
        assert.equal(mock.requests[0].body.temperature, undefined);
        assert.ok(mock.requests[0].body.max_completion_tokens > 0);
        assert.equal(mock.requests[0].body.max_tokens, undefined);
      }
      if (surface === 'viz') assert.deepEqual(result.file.config.data.datasets[0].data, [0, -3.5]);
    });
  }
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'anthropic/claude-sonnet-5-5']) {
    test(`${surface} sends ${model} to the native selected API`, async () => {
      const calls = [];
      const controller = new AbortController();
      const result = await run({ prompt: 'Usa los valores originales.', model, signal: controller.signal,
        clientOptions: { env, anthropicSdkClient: { messages: { create: async (body, options) => {
          calls.push({ body, options });
          return { content: [{ type: 'text', text: JSON.stringify(response) }] };
        } } } } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.model, model.replace(/^anthropic\//, ''));
      assert.equal(calls[0].options.signal, controller.signal);
      assert.equal(calls[0].body.temperature, undefined);
      assert.ok(result.content);
      if (model.includes('sonnet')) assert.deepEqual(calls[0].body.thinking, { type: 'between_tools' });
    });
  }
}

test('math and viz stop when the selected connection is absent even if another key exists', async () => {
  for (const run of [solveMath, generateViz]) {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'grok-4.7']) {
      await assert.rejects(run({ prompt: 'Ejemplo', model, clientOptions: { env: { OPENAI_API_KEY: 'test-other' } } }),
        (error) => error.code === 'PROVIDER_CONNECTION_UNAVAILABLE');
    }
  }
});

test('balanced extraction preserves escaped strings and data with trailing prose/braces', async () => {
  const expected = { ...viz, explanation: 'Texto con llave } y comilla " sin alterar valores.' };
  const mock = wire('```json\n' + JSON.stringify(expected) + '\n```\nNota adicional: {usar datos originales}.');
  const result = await generateViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: mock.clientOptions });
  assert.deepEqual(result.parsed, expected);
  assert.equal(mock.requests.length, 1);
});

test('invalid Chart.js callback remains data, is never evaluated or retried, and yields a safe error', async () => {
  const malformed = '{"format":"chartjs","title":"Ventas","explanation":"Datos","payload":{"config":{"options":{"plugins":{"tooltip":{"callbacks":{"label":function(co){globalThis.__vizExecuted=true;return co;}}}}}}}}';
  const mock = wire(malformed);
  const events = [];
  for await (const event of streamViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: mock.clientOptions })) events.push(event);
  assert.equal(mock.requests.length, 1);
  assert.equal(globalThis.__vizExecuted, undefined);
  assert.equal(events.at(-1).code, 'E_CONTENT');
  assert.match(events.at(-1).error, /formato inválido.*Inténtalo/);
  assert.doesNotMatch(JSON.stringify(events), /function\(co|grok|api\.x\.ai|JSON parse/);
  assert.equal(events.some((event) => event.type === 'final'), false);
  assert.match(mock.requests[0].body.messages[0].content, /Never include JavaScript functions/);
});

test('incomplete JSON and invalid artifact shapes never produce a success', async () => {
  for (const raw of ['null', '[]', '{"format":"chartjs"', '{"format":"unknown","title":"X","explanation":"","payload":{}}', '{"format":"chartjs","title":"X","explanation":"","payload":{"config":{"type":"bar"}}}']) {
    const mock = wire(raw);
    await assert.rejects(generateViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: mock.clientOptions }), (e) => e.code === 'E_CONTENT');
    assert.equal(mock.requests.length, 1);
  }
  assert.throws(() => parseStructuredObject('{"data":[1,2]'), (e) => e.code === 'E_CONTENT');
});

test('provider failures are not retried or exposed verbatim in math/viz events', async () => {
  for (const stream of [streamSolve, streamViz]) {
    for (const status of [400, 402, 404, 429, 500]) {
      const mock = wire('raw provider detail sk-secret-not-real Bearer sensitive', { status });
      const events = [];
      for await (const event of stream({ prompt: 'Ejemplo', model: 'grok-4.7', clientOptions: mock.clientOptions })) events.push(event);
      assert.equal(mock.requests.length, 1, `status ${status}`);
      assert.equal(events.at(-1).type, 'error');
      assert.ok(['E_PROVIDER', 'E_QUOTA'].includes(events.at(-1).code));
      assert.doesNotMatch(JSON.stringify(events), /raw provider|sk-secret|Bearer|grok|OpenAI|xAI/);
    }
  }
});

test('unrenderable chart rows, series, datasets, types and callback strings are rejected', async () => {
  for (const [format, payload] of [
    ['recharts', { type: 'line', xKey: 'name', data: [{ name: 'A', value: 1 }], series: [null] }],
    ['recharts', { type: 'line', xKey: 'name', data: [null], series: [{ key: 'value' }] }],
    ['recharts', { type: 'line', xKey: 'name', data: [{ name: 'A', value: {} }], series: [{ key: 'value' }] }],
    ['chartjs', { config: { type: 'bar', data: { datasets: [null] } } }],
    ['chartjs', { config: { type: 'unsupported', data: { datasets: [{ data: [1] }] } } }],
    ['chartjs', { config: { type: 'bar', data: { datasets: [{ data: [1] }] }, options: { scales: { y: { ticks: { callback: 'function(value){return value}' } } } } } }],
    ['plotly', { data: [null] }],
  ]) {
    const mock = wire(JSON.stringify({ format, title: 'Valores', explanation: 'Datos.', payload }));
    await assert.rejects(generateViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: mock.clientOptions }), (e) => e.code === 'E_CONTENT');
    assert.equal(mock.requests.length, 1);
  }
});

test('valid Recharts gaps, zeros and negative values retain their exact meaning', async () => {
  const chart = { type: 'line', xKey: 'name', data: [{ name: 'A', value: null }, { name: 'B', value: 0 }, { name: 'C', value: -2 }], series: [{ key: 'value', name: 'Valor', color: '#123456' }] };
  const mock = wire(JSON.stringify({ format: 'recharts', title: 'Valores', explanation: 'Datos.', payload: chart }));
  const result = await generateViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: mock.clientOptions });
  assert.deepEqual(result.file.chart, chart);
});

test('only unsupported JSON-mode 400 allows one same-model compatibility request', async () => {
  const mock = wire(JSON.stringify(viz));
  const originalFetch = mock.clientOptions.fetchImpl;
  let attempts = 0;
  mock.clientOptions.fetchImpl = async (...args) => {
    attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: response_format" } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
    return originalFetch(...args);
  };
  await generateViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: mock.clientOptions });
  assert.equal(attempts, 2);
  assert.equal(mock.requests[0].body.response_format, undefined);
  assert.equal(mock.requests[0].body.model, 'grok-4.7');
});

test('cancellation and token truncation never deliver a partial chart or start another request', async () => {
  const controller = new AbortController();
  controller.abort();
  const mock = wire(JSON.stringify(viz));
  const events = [];
  for await (const event of streamViz({ prompt: 'Gráfica', model: 'grok-4.7', signal: controller.signal, clientOptions: mock.clientOptions })) events.push(event);
  assert.equal(mock.requests.length, 0);
  assert.equal(events.at(-1).code, 'E_CANCELLED');
  const truncated = wire(JSON.stringify(viz), { finishReason: 'length' });
  await assert.rejects(generateViz({ prompt: 'Gráfica', model: 'grok-4.7', clientOptions: truncated.clientOptions }), (e) => e.code === 'E_CONTENT');
  assert.equal(truncated.requests.length, 1);
});

test('production xAI adapter receives the same selected model and transport', async () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-structured-generation';
  try {
    const mock = wire(JSON.stringify(math));
    const resolved = clientForModel('x-ai/grok-4.7', { fetchImpl: mock.clientOptions.fetchImpl });
    assert.equal(resolved.provider, 'xAI');
    assert.equal(resolved.model, 'grok-4.7');
    await resolved.client.chat.completions.create({ model: resolved.model, messages: [] }, { maxRetries: 0 });
    assert.equal(new URL(mock.requests[0].url).hostname, 'api.x.ai');
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});
