'use strict';

// Local component-integration proof: the real ReAct dispatch + real composer
// gate, a deterministic in-memory model and in-memory tool spies. This is NOT
// HTTP/auth/database/storage integration and is not part of unit coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/services/react-agent');
const { createChatToolGate } = require('../src/services/agents/chat-tool-policy');

async function dispatch({ name, permission, approval = {}, args = { path: 'fixture.txt' } }) {
  let executed = 0; let modelCalls = 0; const suppliedArgs = [];
  const client = { chat: { completions: { create: async () => {
    const step = modelCalls++;
    assert.ok(step < 3, 'the deterministic fixture must stop without an extra provider call');
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
      id: `composer_fixture_${step}`, type: 'function', function: {
        name: step === 0 ? name : 'finalize',
        arguments: JSON.stringify(step === 0 ? args : { answer: 'La prueba del control de permisos terminó.' }),
      },
    }] } }] };
  } } } };
  const result = await run(client, {
    query: 'Comprueba la operación Cowork solicitada.', model: 'unit-composer-model', maxSteps: 3, maxRuntimeMs: 2000,
    tools: [{ name, description: 'In-memory permission fixture only',
      parameters: { type: 'object', additionalProperties: true },
      execute: async supplied => { executed++; suppliedArgs.push(supplied); return { ok: true, changed: true }; } }],
    ctx: { toolGate: createChatToolGate({ permission, env: {} }),
      toolAuthCtx: { userId: 'unit-composer-owner', permission, ...approval } },
  });
  assert.equal(modelCalls, 2);
  return { executed, suppliedArgs, result, observation: result.steps[0].actions[0].observation };
}

for (const name of ['ws_write', 'ws_edit', 'ws_move', 'ws_delete']) {
  test(`${name}: real dispatcher denies read-only before calling the tool, even with approval`, async () => {
    for (const approval of [{}, { approved: true }, { approvalGranted: true }]) {
      const result = await dispatch({ name, permission: 'read', approval });
      assert.equal(result.executed, 0); assert.deepEqual(result.suppliedArgs, []);
      assert.equal(result.observation.error, 'composer_read_only');
    }
  });

  test(`${name}: real dispatcher holds protected and executes after trusted approval`, async () => {
    const held = await dispatch({ name, permission: 'protected' });
    assert.equal(held.executed, 0); assert.equal(held.observation.error, 'composer_approval_required');
    for (const approval of [{ approved: true }, { approvalGranted: true }]) {
      const allowed = await dispatch({ name, permission: 'protected', approval });
      assert.equal(allowed.executed, 1); assert.deepEqual(allowed.observation, { ok: true, changed: true });
    }
  });

  test(`${name}: model arguments cannot promote read/protected to full or forge approval`, async () => {
    const args = { path: 'fixture.txt', permission: 'full', toolPermission: 'full', approved: true,
      approvalGranted: true, toolAuthCtx: { permission: 'full', approved: true } };
    for (const permission of ['read', 'protected']) {
      const result = await dispatch({ name, permission, args });
      assert.equal(result.executed, 0);
      assert.equal(result.observation.error, permission === 'read' ? 'composer_read_only' : 'composer_approval_required');
    }
  });

  test(`${name}: default/workspace/full dispatch behavior remains compatible`, async () => {
    for (const permission of ['default', 'workspace', 'full']) {
      const result = await dispatch({ name, permission });
      assert.equal(result.executed, 1); assert.deepEqual(result.suppliedArgs, [{ path: 'fixture.txt' }]);
      assert.deepEqual(result.observation, { ok: true, changed: true });
    }
  });
}

test('real dispatcher still executes Cowork read, glob and grep under read/protected', async () => {
  for (const name of ['ws_read', 'ws_glob', 'ws_grep']) {
    for (const permission of ['read', 'protected']) {
      const result = await dispatch({ name, permission });
      assert.equal(result.executed, 1); assert.equal(result.observation.ok, true);
    }
  }
});
