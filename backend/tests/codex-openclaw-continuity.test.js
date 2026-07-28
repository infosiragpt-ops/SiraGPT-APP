'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const continuity = require('../src/services/codex/openclaw-continuity');
const engine = require('../src/services/codex/proactive-engine');

test('openclaw continuity policy defaults favor permanent fleet work', () => {
  const policy = continuity.continuityPolicy({});
  assert.equal(policy.mode, 'permanent-fleet');
  assert.equal(policy.heartbeatMs, 2 * 60_000);
  assert.equal(policy.maxCyclesPerDay, 48);
  assert.equal(policy.dailyBudgetUsd, 25);
  assert.equal(policy.autoExecute, true);
  assert.equal(policy.activateAllDepartments, true);
});

test('proactive createRun paths request autoExecute for durable hours-long work', async () => {
  const created = [];
  const project = { id: 'p1', userId: 'u1', name: 'SiraGPT.COM', brief: { proactive: { enabled: true } } };
  const prisma = {
    codexProject: {
      findFirst: async () => project,
      findUnique: async () => project,
      update: async ({ data }) => {
        Object.assign(project, data);
        return project;
      },
    },
    codexRun: {
      findFirst: async () => null,
      findMany: async () => [],
    },
  };
  const res = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: {
        createRun: async (args) => {
          created.push(args);
          return { id: 'run-auto' };
        },
      },
      chatComplete: async () => ({ content: '{"title":"Mejora continua","goal":"Avanza el producto con evidencia."}' }),
    },
  });
  assert.equal(res.action, 'proposed');
  assert.equal(created[0].autoExecute, true);
});
