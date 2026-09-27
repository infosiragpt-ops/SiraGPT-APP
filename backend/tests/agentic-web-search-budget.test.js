'use strict';

// Prod 2026-09-27: «noticias de hoy en Lima» (web search mode) ran 22 web
// searches in 6 agent steps — 74 s — although the route had already injected
// 10 fresh results into the prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _internal } = require('../src/services/agentic-chat-stream');

const { webSearchBudget, webReadBudget, withWebSearchBudget, withWebReadBudget } = _internal;

test('budget: generous by default, two follow-ups when the route already searched', () => {
  assert.equal(webSearchBudget({ env: {} }), 8);
  assert.equal(webSearchBudget({ preGroundedSources: 10, env: {} }), 2);
  assert.equal(webSearchBudget({ env: { SIRAGPT_AGENTIC_WEB_SEARCH_BUDGET: '12' } }), 12);
  assert.equal(webSearchBudget({ preGroundedSources: 3, env: { SIRAGPT_AGENTIC_WEB_SEARCH_BUDGET: '1' } }), 1);
  for (const bad of ['0', '-3', 'x']) assert.equal(webSearchBudget({ env: { SIRAGPT_AGENTIC_WEB_SEARCH_BUDGET: bad } }), 8, bad);
});

test('web lookups past the budget answer «use what you have» without calling the provider', async () => {
  let providerCalls = 0;
  const webSearch = { name: 'web_search', execute: async () => { providerCalls += 1; return { ok: true, results: [] }; } };
  const readUrl = { name: 'read_url', execute: async () => ({ ok: true }) };
  const xSearch = { name: 'x_search', execute: async () => { providerCalls += 1; return { ok: true }; } };
  const tools = withWebSearchBudget([webSearch, readUrl, xSearch], 3);
  assert.equal(tools[1], readUrl, 'reading a page is not a search');
  assert.notEqual(tools[0], webSearch, 'the shared tool object is never mutated');
  assert.equal(webSearch.execute.name, 'execute');
  // Parallel dispatch in one step counts every call.
  const results = await Promise.all([tools[0].execute({}), tools[0].execute({}), tools[2].execute({}), tools[0].execute({})]);
  assert.equal(providerCalls, 3);
  assert.equal(results.filter((r) => r.budgetExhausted).length, 1);
  const last = await tools[0].execute({});
  assert.equal(last.ok, false);
  assert.match(last.error, /Límite de 3 búsquedas web en este turno alcanzado\. Responde ya con las fuentes que tienes/);
  assert.equal(providerCalls, 3);
});

// After #865 capped searches at 2, the same news turn still read 11 pages
// (~46 s) before answering.
test('page reads have their own budget: 12 by default, 3 when the route already searched', async () => {
  assert.equal(webReadBudget({ env: {} }), 12);
  assert.equal(webReadBudget({ preGroundedSources: 10, env: {} }), 3);
  assert.equal(webReadBudget({ env: { SIRAGPT_AGENTIC_WEB_READ_BUDGET: '5' } }), 5);
  let reads = 0;
  let searches = 0;
  const tools = withWebReadBudget(withWebSearchBudget([
    { name: 'web_search', execute: async () => { searches += 1; return { ok: true }; } },
    { name: 'web_fetch', execute: async () => { reads += 1; return { ok: true }; } },
    { name: 'read_url', execute: async () => { reads += 1; return { ok: true }; } },
    { name: 'python_exec', execute: async () => ({ ok: true }) },
  ], 1), 2);
  await Promise.all([tools[1].execute({}), tools[2].execute({}), tools[1].execute({})]);
  assert.equal(reads, 2, 'read_url and web_fetch share one budget');
  const blocked = await tools[2].execute({});
  assert.match(blocked.error, /Límite de 2 lecturas de página en este turno alcanzado\. Responde ya con lo que leíste/);
  await tools[0].execute({});
  assert.equal(searches, 1, 'searches keep their own counter');
  assert.deepEqual(await tools[3].execute({}), { ok: true });
});

test('wiring: the route passes its fresh sources and the loop starts from them', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const ai = read('src/routes/ai.js');
  assert.match(ai, /webGrounding: Array\.isArray\(webSearchSources\) && webSearchSources\.length\s*\? \{ sources: webSearchSources\.length \}\s*: null,/);
  const stream = read('src/services/agentic-chat-stream.js');
  assert.match(stream, /if \(preGroundedSources > 0 && initialToolChoice === 'web_search'\) initialToolChoice = null;/);
  assert.match(stream, /tools = withWebReadBudget\(withWebSearchBudget\(tools, webLookupLimit\), webReadLimit\);/);
  assert.match(stream, /if \(!initialToolChoice && preGroundedSources === 0 && availableToolNames\.has\('web_search'\)\) \{/);
  assert.match(stream, /Ya tienes \$\{preGroundedSources\} resultados web recientes para esta pregunta en «Fresh Web Context»/);
});
