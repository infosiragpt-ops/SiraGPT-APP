'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_REQUEST_SCHEMA_VERSION,
  AgentAdapterContractError,
  assertAgentAdapter,
  assertAgentRequest,
  assertAgentOutcome,
  createImplementerRequest,
} = require('../src/services/codex/agent-adapters/contract');
const { nativeCodexAdapter } = require('../src/services/codex/agent-adapters/native-codex-adapter');

test('AgentAdapter v1 validates the native interface and implementer envelope', () => {
  assert.equal(assertAgentAdapter(nativeCodexAdapter), nativeCodexAdapter);
  const run = { id: 'run-1', mode: 'build', prompt: 'Build a real product', tier: 'pro' };
  const project = { id: 'project-1', name: 'Demo', workspacePath: 'projects/private-path' };
  const request = createImplementerRequest({ run, project, timeoutMs: 60_000, maxSteps: 24 });

  assert.equal(assertAgentRequest(request, { expectedRole: 'implementer' }), request);
  assert.equal(request.schemaVersion, AGENT_REQUEST_SCHEMA_VERSION);
  assert.notEqual(request.run, run);
  assert.notEqual(request.project, project);
  assert.deepEqual(request.run, { id: 'run-1', mode: 'build', prompt: 'Build a real product', tier: 'pro' });
  assert.deepEqual(request.project, { id: 'project-1', name: 'Demo' });
  assert.equal(Object.hasOwn(request.project, 'workspacePath'), false);
  assert.equal(request.workspace.ref, 'codex-project:project-1');
  assert.equal(request.workspace.ref.includes(project.workspacePath), false);
  assert.deepEqual(request.budget, { timeoutMs: 60_000, maxSteps: 24 });
  const outcome = { status: 'done', checkpoint: { id: 'cp-1' } };
  assert.equal(assertAgentOutcome(outcome), outcome);
});

test('AgentAdapter v1 rejects malformed adapters and envelopes with a typed error', () => {
  assert.throws(
    () => assertAgentAdapter({ id: 'bad', version: '1.0.0', capabilities() { return {}; } }),
    (err) => err instanceof AgentAdapterContractError && err.code === 'CODEX_AGENT_ADAPTER_CONTRACT_INVALID',
  );
  assert.throws(
    () => assertAgentRequest({ schemaVersion: 'unknown' }),
    (err) => err instanceof AgentAdapterContractError && /schemaVersion/.test(err.message),
  );
  assert.throws(
    () => createImplementerRequest({
      run: { id: 'run-1', mode: 'unknown', prompt: '' },
      project: null,
      timeoutMs: 60_000,
      maxSteps: 24,
    }),
    /run\.mode is unsupported/,
  );
  assert.throws(() => assertAgentOutcome(undefined), /must return an outcome object/);
  assert.throws(() => assertAgentOutcome({ status: 'mystery' }), /unsupported outcome status/);
});
