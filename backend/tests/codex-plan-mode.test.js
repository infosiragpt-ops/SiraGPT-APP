'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePlan, runPlanMode, buildPlanMessages } = require('../src/services/codex/plan-mode');

const VALID = { architecture: 'Vite SPA', pages: ['/'], components: ['Nav'], tasks: [{ id: 't1', title: 'init', status: 'pending' }] };

test('parsePlan accepts raw JSON, fenced JSON, and JSON in prose', () => {
  assert.deepEqual(parsePlan(JSON.stringify(VALID)).architecture, 'Vite SPA');
  assert.ok(parsePlan('```json\n' + JSON.stringify(VALID) + '\n```'));
  assert.ok(parsePlan('Aquí está el plan:\n' + JSON.stringify(VALID) + '\nEso es todo.'));
});

test('parsePlan normalises string pages/components and string tasks', () => {
  const plan = parsePlan(JSON.stringify({ architecture: 'x', pages: ['/', { name: '/about' }], components: ['A'], tasks: ['hacer algo'] }));
  assert.deepEqual(plan.pages, ['/', '/about']);
  assert.equal(plan.tasks[0].title, 'hacer algo');
  assert.equal(plan.tasks[0].status, 'pending');
});

test('parsePlan rejects shapes missing required fields', () => {
  assert.equal(parsePlan(JSON.stringify({ architecture: 'x', pages: ['/'], components: ['A'] })), null); // no tasks
  assert.equal(parsePlan(JSON.stringify({ pages: [], components: [], tasks: [] })), null); // no architecture
  assert.equal(parsePlan('no json here'), null);
});

test('runPlanMode emits plan_proposed and returns waiting_approval; passes NO tools', async () => {
  const events = [];
  let toolsSeen = 'unset';
  const llmTurn = async ({ tools }) => { toolsSeen = tools; return { text: JSON.stringify(VALID) }; };
  const eventStore = { appendEvent: async (runId, type, data) => events.push({ runId, type, data }) };
  const res = await runPlanMode({ run: { id: 'r1', mode: 'plan', prompt: 'haz una landing' }, project: { name: 'X' }, deps: { llmTurn, eventStore } });
  assert.equal(res.status, 'waiting_approval');
  assert.deepEqual(toolsSeen, []); // plan mode never offers mutating tools
  assert.equal(events[0].type, 'plan_proposed');
  assert.equal(events[0].data.architecture, 'Vite SPA');
});

test('runPlanMode retries once on a bad parse, then succeeds', async () => {
  const events = [];
  let n = 0;
  const llmTurn = async () => { n += 1; return { text: n === 1 ? 'lo siento, no entendí' : JSON.stringify(VALID) }; };
  const eventStore = { appendEvent: async (runId, type, data) => events.push({ runId, type, data }) };
  const res = await runPlanMode({ run: { id: 'r1', mode: 'plan' }, project: {}, deps: { llmTurn, eventStore } });
  assert.equal(res.status, 'waiting_approval');
  assert.equal(n, 2);
});

test('runPlanMode errors after two bad parses (no plan_proposed)', async () => {
  const events = [];
  const llmTurn = async () => ({ text: 'nunca devuelvo json' });
  const eventStore = { appendEvent: async (runId, type, data) => events.push({ runId, type, data }) };
  const res = await runPlanMode({ run: { id: 'r1', mode: 'plan' }, project: {}, deps: { llmTurn, eventStore } });
  assert.equal(res.status, 'error');
  assert.equal(events.length, 0);
});

test('runPlanMode surfaces an LLM transport error as error', async () => {
  const llmTurn = async () => { throw new Error('429 rate limited'); };
  const eventStore = { appendEvent: async () => {} };
  const res = await runPlanMode({ run: { id: 'r1', mode: 'plan' }, project: {}, deps: { llmTurn, eventStore } });
  assert.equal(res.status, 'error');
  assert.match(res.error, /429/);
});

test('buildPlanMessages includes the prompt and prior plan/feedback when given', () => {
  const { system, user } = buildPlanMessages({ project: { name: 'Tienda' }, prompt: 'vende zapatos', priorPlan: VALID, feedback: 'agrega carrito' });
  assert.match(system, /JSON/);
  assert.match(user, /vende zapatos/);
  assert.match(user, /agrega carrito/);
});
