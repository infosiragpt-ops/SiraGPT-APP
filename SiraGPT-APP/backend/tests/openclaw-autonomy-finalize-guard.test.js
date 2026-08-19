'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const kernel = require('../src/services/openclaw-capability-kernel');
const {
  validateAgentTaskFinalize,
  validateOpenClawAutonomyFinalize,
} = require('../src/services/agents/openclaw-autonomy-finalize-guard');

function openclawProfile() {
  return kernel.buildCapabilityProfile({
    prompt: 'Fusiona OpenClaw con este software para que funcione como agente autonomo avanzado',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });
}

function stepsWith(actions) {
  return [{ step: 0, thought: 'Verificando', actions }];
}

function activeTaskPlan() {
  return {
    agentRuntimeHardening: { active: true },
    phases: [
      { id: 'orchestrate', role: 'orchestrator', requiredTools: [] },
      {
        id: 'agent_runtime_diagnostics',
        role: 'runtime_architect',
        requiredTools: ['run_tests'],
        checkpoint: 'Agent runtime checks pass.',
      },
      { id: 'supervision', role: 'supervision', requiredTools: ['finalize'] },
    ],
  };
}

test('OpenClaw autonomy finalize guard blocks plain finalize without runtime evidence', () => {
  const result = validateOpenClawAutonomyFinalize(openclawProfile(), {
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Listo' } }]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.active, true);
  assert.ok(result.missingTools.includes('runtime_evidence'));
  assert.match(result.message, /No successful tool evidence/);
  assert.deepEqual(result.repairActions, [{
    type: 'record_runtime_evidence',
    priority: 'critical',
    phaseId: null,
    tools: ['run_tests'],
    reason: 'openclaw_runtime_evidence_required',
    checkpoint: null,
  }]);
});

test('OpenClaw autonomy finalize guard requires run_tests for autonomous software fusion', () => {
  const result = validateOpenClawAutonomyFinalize(openclawProfile(), {
    steps: stepsWith([
      { tool: 'host_file', observation: { ok: true, path: 'backend/src/example.js' } },
      { tool: 'finalize', observation: { answer: 'Listo' } },
    ]),
  });

  assert.equal(result.ok, false);
  assert.ok(result.missingTools.includes('run_tests'));
  assert.match(result.repairInstructions, /Run deterministic tests/);
  assert.deepEqual(result.repairActions, [{
    type: 'complete_phase_evidence',
    priority: 'critical',
    phaseId: 'qa_tests',
    tools: ['run_tests'],
    reason: 'autonomous_fusion_tests_required',
    checkpoint: 'Deterministic runtime validation must pass before finalization.',
  }]);
});

test('OpenClaw autonomy finalize guard requires run_tests for bulk source fusion', () => {
  const bulk = kernel.buildCapabilityProfile({
    prompt: 'Son millones de lineas de codigo que tenemos que copiar y fusionar desde OpenClaw',
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });
  const result = validateOpenClawAutonomyFinalize(bulk, {
    steps: stepsWith([
      { tool: 'host_file', observation: { ok: true, path: 'backend/src/example.js' } },
      { tool: 'finalize', observation: { answer: 'Listo' } },
    ]),
  });

  assert.equal(result.ok, false);
  assert.ok(result.missingTools.includes('run_tests'));
  assert.equal(result.summary.signals.massiveSourceFusion, true);
});

test('OpenClaw autonomy finalize guard passes after successful run_tests', () => {
  const result = validateOpenClawAutonomyFinalize(openclawProfile(), {
    steps: stepsWith([
      { tool: 'run_tests', observation: { ok: true, passed: 3, failed: 0 } },
      { tool: 'finalize', observation: { answer: 'Listo' } },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.deepEqual(result.successfulTools, ['run_tests', 'finalize']);
});

test('validateAgentTaskFinalize composes base gates with OpenClaw autonomy gates', () => {
  const result = validateAgentTaskFinalize({
    finalizeProfile: { requiredTools: ['run_tests'], minimumToolCalls: { run_tests: 1 } },
    openclawRuntimeProfile: openclawProfile(),
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Listo' } }]),
  });

  assert.equal(result.ok, false);
  assert.ok(result.missingTools.includes('run_tests'));
});

test('validateAgentTaskFinalize blocks active task plans without progress evidence', () => {
  const result = validateAgentTaskFinalize({
    finalizeProfile: { requiredTools: [] },
    taskPlan: activeTaskPlan(),
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Listo' } }]),
  });

  assert.equal(result.ok, false);
  assert.ok(result.missingTools.includes('runtime_evidence'));
  assert.equal(result.autonomyProgress.status, 'blocked');
});

test('validateAgentTaskFinalize returns autonomy progress after verified active task plans', () => {
  const result = validateAgentTaskFinalize({
    finalizeProfile: { requiredTools: [] },
    taskPlan: activeTaskPlan(),
    steps: stepsWith([
      { tool: 'run_tests', observation: { ok: true, passed: 4, failed: 0 } },
      { tool: 'finalize', observation: { answer: 'Listo' } },
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.autonomyProgress.status, 'ready');
  assert.equal(
    result.autonomyProgress.phases.find((phase) => phase.id === 'agent_runtime_diagnostics').status,
    'satisfied'
  );
});

test('OpenClaw autonomy finalize guard skips ordinary non-OpenClaw long tasks', () => {
  const ordinary = kernel.buildCapabilityProfile({
    prompt: 'Investiga papers actuales y genera un reporte con fuentes',
    toolNames: ['web_search', 'memory_recall'],
  });
  const result = validateOpenClawAutonomyFinalize(ordinary, {
    steps: stepsWith([{ tool: 'finalize', observation: { answer: 'Reporte listo' } }]),
  });

  assert.equal(ordinary.signals.likelyLongRunning, true);
  assert.equal(result.ok, true);
  assert.equal(result.active, false);
});
