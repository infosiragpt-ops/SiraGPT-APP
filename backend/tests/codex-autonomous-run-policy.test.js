'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/services/codex/autonomous-run-policy');

test('auto-execution marker is durable but never reaches the agent prompt', () => {
  const stored = policy.withAutoExecutePrompt('Construye una app de inventario');
  assert.equal(policy.isAutoExecutePrompt(stored), true);
  assert.equal(policy.stripAutoExecutePrompt(stored), 'Construye una app de inventario');
  assert.equal(policy.withAutoExecutePrompt(stored), stored);
});

test('deep autonomous software work receives an hours-long bounded budget', () => {
  const run = {
    prompt: policy.withAutoExecutePrompt(
      'Integra OpenClaw y construye frontend, backend, base de datos y pruebas durante horas.',
    ),
  };
  const resolved = policy.deriveAutonomousRunPolicy({
    run,
    profile: {
      signals: {
        wantsAutonomousAgent: true,
        externalRepoAdaptation: true,
      },
    },
    env: {},
  });

  assert.equal(resolved.autoExecute, true);
  assert.equal(resolved.depth, 'deep');
  assert.equal(resolved.timeoutMs, 4 * 60 * 60_000);
  assert.equal(resolved.maxSteps, 120);
  assert.equal(resolved.verifyDevServer, true);
});

test('ordinary interactive runs preserve the current short budget', () => {
  const env = {
    CODEX_RUN_TIMEOUT_MS: '60000',
    CODEX_MAX_STEPS: '7',
  };
  const resolved = policy.deriveAutonomousRunPolicy({
    run: { prompt: 'cambia el color del botón' },
    env,
  });
  assert.equal(resolved.autoExecute, false);
  assert.equal(resolved.depth, 'interactive');
  assert.equal(resolved.timeoutMs, 60_000);
  assert.equal(resolved.maxSteps, 7);
  assert.equal(resolved.verifyDevServer, false);
  assert.equal(policy.buildAutonomousRunEnv(env, resolved), env);
});
