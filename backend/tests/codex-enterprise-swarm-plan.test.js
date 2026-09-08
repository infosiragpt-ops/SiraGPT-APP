'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/services/codex/company-autopilot-planner');
const {
  buildEnterpriseSwarmTasks,
} = require('../src/services/codex/enterprise-swarm-plan');

function plan() {
  return planner.buildCompanyAutopilotPlan({
    companyOperatingProfile: {
      companyMode: 'existing',
      companyName: 'SiraGPT',
      mission: 'Construir software útil.',
      vision: 'Ser el mejor agente de código.',
    },
    readiness: {},
  });
}

test('builds an exact bounded logical task graph with one final integrator', () => {
  const tasks = buildEnterpriseSwarmTasks({
    plan: plan(),
    objective: 'Mejorar el producto y verificarlo.',
    logicalTasks: 64,
  });
  assert.equal(tasks.length, 64);
  assert.equal(tasks.filter((task) => task.role === 'integrator').length, 1);
  assert.equal(tasks.at(-1).key, 'swarm-integrate');
  assert.deepEqual(tasks.at(-1).dependsOn, ['swarm-review']);
});

test('external effects become review tasks and never executable actions', () => {
  const tasks = buildEnterpriseSwarmTasks({
    plan: plan(),
    objective: 'Gestionar la empresa.',
  });
  const external = tasks.filter((task) => task.input?.kind === 'external_effect');
  assert.ok(external.length > 0);
  assert.ok(external.every((task) => task.role === 'reviewer'));
  assert.ok(external.every((task) => /No ejecutes el efecto externo/.test(task.input.instruction)));
});

test('parallel agents are read-only and writers are serialized into the integrator', () => {
  const tasks = buildEnterpriseSwarmTasks({
    plan: plan(),
    objective: 'Crear una aplicación completa.',
    logicalTasks: 1000,
  });
  assert.equal(tasks.length, 1000);
  assert.ok(tasks.slice(0, -1).every((task) => task.role !== 'writer'));
  assert.equal(tasks.filter((task) => task.role === 'integrator').length, 1);
});

test('scales to 10_000 logical research agents with a single integrator', () => {
  const tasks = buildEnterpriseSwarmTasks({
    plan: plan(),
    objective: 'Escalar la flota a capacidad enterprise.',
    logicalTasks: 10_000,
  });
  assert.equal(tasks.length, 10_000);
  assert.equal(tasks.filter((task) => task.role === 'integrator').length, 1);
  assert.equal(tasks.at(-1).key, 'swarm-integrate');
  assert.ok(tasks.filter((task) => task.role === 'read-only').length >= 9_000);
});
