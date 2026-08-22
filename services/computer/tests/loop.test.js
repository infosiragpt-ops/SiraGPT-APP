'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentComputerLoop, MAX_STEPS, MAX_IDENTICAL, actionKey } = require('../backend/agent-computer-loop');

test('identical actions abort', async () => {
  let n = 0;
  const out = await runAgentComputerLoop({
    goal: 'x', cdpMode: true, taskId: 't1',
    stepFn: async () => ({ type: 'move', x: 10, y: 10 }),
    session: { action: async (a) => { n += 1; return { ok: true, a }; } },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'identical_actions');
  assert.equal(n, 2);
  assert.ok(out.steps.length <= MAX_IDENTICAL);
});

test('done stops', async () => {
  const out = await runAgentComputerLoop({ goal: 'x', stepFn: async () => ({ type: 'done' }), session: { action: async () => ({}) } });
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'done');
});

test('max steps', async () => {
  let i = 0;
  const out = await runAgentComputerLoop({ goal: 'x', stepFn: async () => ({ type: 'move', x: i++, y: 1 }), session: { action: async () => ({}) } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'max_steps');
  assert.equal(out.steps.length, MAX_STEPS);
});

test('actionKey stable', () => {
  assert.equal(actionKey({ type: 'move', x: 1 }), actionKey({ type: 'move', x: 1 }));
  assert.notEqual(actionKey({ type: 'move', x: 1 }), actionKey({ type: 'move', x: 2 }));
});
