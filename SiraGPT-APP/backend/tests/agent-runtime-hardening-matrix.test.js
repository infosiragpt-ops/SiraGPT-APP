'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentRuntimeHardeningMatrix,
  buildAgentRuntimeHardeningPromptBlock,
  hasAgentRuntimeIntent,
} = require('../src/services/agents/agent-runtime-hardening-matrix');
const { buildExecutionProfile } = require('../src/services/agents/agentic-execution-profile');
const openclawCapabilityKernel = require('../src/services/openclaw-capability-kernel');

test('agent runtime hardening matrix stays inactive for ordinary chat', () => {
  const matrix = buildAgentRuntimeHardeningMatrix({
    goal: 'Dame una respuesta corta sobre la luna',
    executionProfile: buildExecutionProfile({ goal: 'Dame una respuesta corta sobre la luna' }),
  });

  assert.equal(hasAgentRuntimeIntent('Dame una respuesta corta sobre la luna'), false);
  assert.equal(matrix.active, false);
  assert.deepEqual(matrix.lanes, []);
});

test('agent runtime hardening matrix does not activate for ordinary long-running software work', () => {
  const goal = 'Implement auth module with tests and deploy to staging';
  const openclawProfile = openclawCapabilityKernel.buildCapabilityProfile({ prompt: goal });
  const matrix = buildAgentRuntimeHardeningMatrix({
    goal,
    executionProfile: buildExecutionProfile({ goal }),
    openclawProfile,
  });

  assert.equal(openclawProfile.signals.likelyLongRunning, true);
  assert.equal(matrix.active, false);
});

test('agent runtime hardening matrix builds lanes for agent improvement work', () => {
  const goal = 'Sigamos mejorando los agentes del sofware';
  const matrix = buildAgentRuntimeHardeningMatrix({
    goal,
    executionProfile: buildExecutionProfile({ goal }),
    toolManifests: [{ name: 'run_tests' }, { name: 'host_file' }],
  });

  assert.equal(matrix.active, true);
  assert.equal(matrix.reason, 'agent_runtime_intent_detected');
  assert.ok(matrix.maturityScore >= 80);
  assert.ok(matrix.lanes.some((lane) => lane.id === 'intent_and_plan_contracts'));
  assert.ok(matrix.lanes.some((lane) => lane.id === 'tool_gate_integrity'));
  assert.ok(matrix.lanes.some((lane) => lane.id === 'durable_state_and_recovery'));
  assert.ok(matrix.recommendedTests.includes('backend/tests/agent-task-plan.test.js'));
  assert.ok(matrix.verificationGates.some((gate) => /Tool manifest coverage observed/.test(gate)));
});

test('agent runtime hardening matrix adds external-reference and bulk lanes for OpenClaw fusion', () => {
  const goal = 'Fusiona millones de lineas de OpenClaw como agente autonomo';
  const openclawProfile = openclawCapabilityKernel.buildCapabilityProfile({
    prompt: goal,
    toolNames: ['run_tests', 'host_file'],
  });
  const matrix = buildAgentRuntimeHardeningMatrix({
    goal,
    executionProfile: buildExecutionProfile({ goal }),
    openclawProfile,
  });

  assert.equal(matrix.active, true);
  assert.ok(matrix.lanes.some((lane) => lane.id === 'external_reference_boundary'));
  assert.ok(matrix.lanes.some((lane) => lane.id === 'bulk_activation_budget'));

  const prompt = buildAgentRuntimeHardeningPromptBlock(matrix);
  assert.match(prompt, /Agent runtime hardening matrix/);
  assert.match(prompt, /external_reference_boundary/);
  assert.match(prompt, /Verification gates/);
});
