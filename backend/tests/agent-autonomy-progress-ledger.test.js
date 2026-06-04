'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutonomyProgressLedger,
  validateAutonomyProgress,
} = require('../src/services/agents/agent-autonomy-progress-ledger');

function stepsWith(actions) {
  return [{ step: 0, thought: 'Checking progress', actions }];
}

function activeAgentPlan() {
  return {
    agentRuntimeHardening: { active: true },
    phases: [
      { id: 'orchestrate', role: 'orchestrator', requiredTools: [] },
      {
        id: 'agent_runtime_diagnostics',
        role: 'runtime_architect',
        requiredTools: ['run_tests'],
        checkpoint: 'Agent gates are verified.',
      },
      {
        id: 'qa_tests',
        role: 'qa',
        requiredTools: ['run_tests'],
        checkpoint: 'Tests pass.',
      },
      { id: 'supervision', role: 'supervision', requiredTools: ['finalize'] },
    ],
  };
}

test('autonomy progress ledger stays inactive for ordinary plans', () => {
  const result = validateAutonomyProgress({
    taskPlan: {
      phases: [
        { id: 'source_research', requiredTools: ['web_search'] },
        { id: 'supervision', requiredTools: ['finalize'] },
      ],
    },
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Done' } }]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.active, false);
  assert.equal(result.ledger.status, 'inactive');
});

test('autonomy progress ledger blocks active plans without runtime evidence', () => {
  const result = validateAutonomyProgress({
    taskPlan: activeAgentPlan(),
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Done' } }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.active, true);
  assert.ok(result.missingTools.includes('runtime_evidence'));
  assert.equal(result.ledger.status, 'blocked');
  assert.equal(result.ledger.nextRequiredPhase, 'agent_runtime_diagnostics');
});

test('autonomy progress ledger blocks active plans when critical tests are missing', () => {
  const result = validateAutonomyProgress({
    taskPlan: activeAgentPlan(),
    steps: stepsWith([
      { tool: 'host_file', observation: { ok: true, path: 'backend/src/example.js' } },
      { tool: 'finalize', observation: { answer: 'Done' } },
    ]),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingTools, ['run_tests']);
  assert.match(result.message, /agent_runtime_diagnostics/);
});

test('autonomy progress ledger passes after successful critical verification', () => {
  const result = validateAutonomyProgress({
    taskPlan: activeAgentPlan(),
    steps: stepsWith([
      { tool: 'run_tests', observation: { ok: true, passed: 7, failed: 0 } },
      { tool: 'finalize', observation: { answer: 'Done' } },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ledger.status, 'ready');
  assert.equal(result.ledger.nonFinalizeTools.includes('run_tests'), true);
  assert.equal(
    result.ledger.phases.find((phase) => phase.id === 'agent_runtime_diagnostics').status,
    'satisfied'
  );
});

test('autonomy progress ledger waives critical verification only when tool is unavailable', () => {
  const result = validateAutonomyProgress({
    taskPlan: activeAgentPlan(),
    unavailableTools: ['run_tests'],
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Done' } }]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.ledger.status, 'ready');
  assert.deepEqual(result.ledger.waivedPhases, ['agent_runtime_diagnostics', 'qa_tests']);
});

test('autonomy progress ledger records deterministic counts and phase status', () => {
  const ledger = buildAutonomyProgressLedger({
    taskPlan: activeAgentPlan(),
    steps: stepsWith([
      { tool: 'run_tests', observation: { ok: true } },
      { tool: 'run_tests', observation: { ok: true } },
      { tool: 'host_file', observation: { error: 'denied' } },
      { tool: 'finalize', observation: { answer: 'Done' } },
    ]),
  });

  assert.deepEqual(ledger.successfulTools, { finalize: 1, run_tests: 2 });
  assert.equal(ledger.status, 'ready');
  assert.equal(ledger.missingPhases.length, 0);
});
