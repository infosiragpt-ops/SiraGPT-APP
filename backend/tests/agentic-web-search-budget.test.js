'use strict';

// Prod 2026-09-27: «noticias de hoy en Lima» (web search mode) ran 22 web
// searches in 6 agent steps — 74 s — although the route had already injected
// 10 fresh results into the prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _internal } = require('../src/services/agentic-chat-stream');

const { webSearchBudget, withWebSearchBudget } = _internal;

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

test('wiring: the route passes its fresh sources and the loop starts from them', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const ai = read('src/routes/ai.js');
  assert.match(ai, /webGrounding: Array\.isArray\(webSearchSources\) && webSearchSources\.length\s*\? \{ sources: webSearchSources\.length \}\s*: null,/);
  const stream = read('src/services/agentic-chat-stream.js');
  assert.match(stream, /if \(preGroundedSources > 0 && initialToolChoice === 'web_search'\) initialToolChoice = null;/);
  assert.match(stream, /tools = withWebSearchBudget\(tools, webLookupLimit\);/);
  assert.match(stream, /if \(!initialToolChoice && preGroundedSources === 0 && availableToolNames\.has\('web_search'\)\) \{/);
  assert.match(stream, /Ya tienes \$\{preGroundedSources\} resultados web recientes para esta pregunta en «Fresh Web Context»/);
});
