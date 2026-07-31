'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PLANNER_TASKS,
  planFleetTasks,
  fallbackFleetTasks,
} = require('../src/services/codex/fleet-orchestrator');
const {
  coerceBriefRecord,
} = require('../src/services/codex/project-brief-store');
const pools = require('../src/services/codex/department-pools');

test('fleet planner accepts more than 100 logical tasks', async () => {
  assert.ok(MAX_PLANNER_TASKS > 100);
  const result = await planFleetTasks({
    objective: 'Activar flota grande',
    desiredTasks: 180,
    planner: async () => ({
      content: JSON.stringify({
        tasks: Array.from({ length: 180 }, (_, index) => ({
          id: `task-${index + 1}`,
          title: `Tarea ${index + 1}`,
          role: index % 5 === 0 ? 'researcher' : 'writer',
          departmentId: 'product-engineering',
          dependsOn: [],
          acceptance: ['evidencia'],
        })),
      }),
    }),
  });
  assert.equal(result.source, 'planner');
  assert.ok(result.tasks.filter((task) => task.role !== 'qa').length >= 180);
});

test('fallback fleet materializes more than 100 logical tasks', () => {
  const tasks = fallbackFleetTasks({
    companyPlan: {
      workstreams: [
        {
          id: 'ws-1',
          departmentId: 'product-engineering',
          title: 'Build',
          tasks: Array.from({ length: 40 }, (_, i) => ({ title: `W${i}` })),
        },
        {
          id: 'ws-2',
          departmentId: 'market-intelligence',
          title: 'Research',
          tasks: Array.from({ length: 40 }, (_, i) => ({ title: `R${i}` })),
        },
        {
          id: 'ws-3',
          departmentId: 'sales',
          title: 'Sales',
          tasks: Array.from({ length: 40 }, (_, i) => ({ title: `S${i}` })),
        },
      ],
    },
    objective: 'Escalar a más de 100 agentes',
    logicalTasks: 150,
  });
  assert.ok(tasks.length >= 100, `expected >=100 tasks, got ${tasks.length}`);
});

test('string briefs coerce into companyProfile mission records', () => {
  const brief = coerceBriefRecord('Misión legada de prueba');
  assert.equal(brief.legacyBriefText, 'Misión legada de prueba');
  assert.equal(brief.companyProfile.mission, 'Misión legada de prueba');
});

test('department pools allow more than 100 physical seats', () => {
  assert.ok(pools.MAX_DEPARTMENT_POOL_SIZE > 100);
  assert.ok(pools.MAX_PROJECT_POOL_CAPACITY > 100);
});
