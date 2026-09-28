'use strict';

// A remote execute_python / bash that hit the sandbox transport timeout may
// still be running. Retrying it blindly doubled its side effects and could
// burn 3 × 130 s before the turn failed with tool_retry_exhausted
// (prod 2026-09-28, remote_sandbox_timeout burst). Exec tools now run once
// and hand the model an honest observation; read/list tools keep their
// retries. Offline.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop } = require('../src/services/agent-runner/loop');

function sandboxTimeout() {
  return Object.assign(new Error('remote_sandbox_timeout'), { code: 'OPERATION_TIMEOUT' });
}

function oneToolThenFinal(name, args = '{"code":"print(1)"}') {
  const seen = [];
  let calls = 0;
  const client = { chat: { completions: { create: async (payload) => {
    seen.push(payload.messages);
    calls += 1;
    if (calls === 1) {
      return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name, arguments: args } }] } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: 'Te explico lo que pasó.' } }] };
  } } } };
  return { client, seen, calls: () => calls };
}

const tool = (name) => [{ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }];

test('execute_python that times out in the sandbox runs once and the loop continues', async () => {
  const { client, seen, calls } = oneToolThenFinal('execute_python');
  let executions = 0;
  const messages = [{ role: 'user', content: 'Crea un Excel' }];
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages,
    tools: tool('execute_python'),
    executors: { execute_python: async () => { executions += 1; throw sandboxTimeout(); } },
    maxIterations: 3,
  });
  assert.equal(executions, 1, 'a non-idempotent command is never re-sent');
  assert.notEqual(result.stoppedReason, 'tool_retry_exhausted');
  assert.ok(calls() >= 2, 'the model sees the observation and keeps going');
  const observation = seen[1].find((m) => m.role === 'tool' && m.tool_call_id === 'x1');
  assert.equal(observation.content, 'ERROR: el entorno de documentos no respondió a tiempo; el comando puede no haberse completado.');
});

test('bash (alias of execute_bash) follows the same rule', async () => {
  const { client } = oneToolThenFinal('bash', '{"command":"ls"}');
  let executions = 0;
  await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: tool('execute_bash'),
    executors: { execute_bash: async () => { executions += 1; throw new Error('sandbox_timeout after 130000ms'); } },
    maxIterations: 3,
  });
  assert.equal(executions, 1);
});

test('read_file with the same transport timeout is still retried', async () => {
  const { client } = oneToolThenFinal('read_file', '{"path":"a.txt"}');
  let executions = 0;
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lee a.txt' }],
    tools: tool('read_file'),
    executors: { read_file: async () => { executions += 1; throw sandboxTimeout(); } },
    maxIterations: 3,
  });
  assert.equal(executions, 3, 'idempotent reads keep their retries');
  assert.equal(result.stoppedReason, 'tool_retry_exhausted');
});
