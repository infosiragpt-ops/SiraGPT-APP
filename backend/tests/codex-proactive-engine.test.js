'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/codex/proactive-engine');

function fakePrisma({ project, activeRun = null, recentRuns = [] } = {}) {
  const state = { project: { ...project }, updates: [] };
  return {
    state,
    codexProject: {
      findFirst: async () => ({ ...state.project }),
      findMany: async () => [{ ...state.project }],
      update: async ({ data }) => {
        state.project = { ...state.project, ...data };
        state.updates.push(data);
        return { ...state.project };
      },
    },
    codexRun: {
      findFirst: async () => activeRun,
      findMany: async () => recentRuns,
    },
  };
}

const PROJECT = { id: 'p1', userId: 'u1', name: 'SiraGPT.COM', brief: { proactive: { enabled: true } } };

test('readProactiveState defaults + setProactive persists into brief JSON', async () => {
  assert.equal(engine.readProactiveState({ brief: null }).enabled, false);
  const prisma = fakePrisma({ project: { ...PROJECT, brief: { goal: 'x' } } });
  const out = await engine.setProactive({ prisma, projectId: 'p1', userId: 'u1', enabled: true });
  assert.equal(out.state.enabled, true);
  assert.ok(prisma.state.project.brief.proactive.enabled, 'written inside brief.proactive');
  assert.equal(prisma.state.project.brief.goal, 'x', 'rest of brief preserved');

  const off = await engine.setProactive({ prisma, projectId: 'p1', userId: 'u1', enabled: false });
  assert.equal(off.state.enabled, false);
});

test('cycle phase 1: proposes a department task as a [PROACTIVO] plan run', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  const created = [];
  const runService = { createRun: async (args) => { created.push(args); return { id: 'run-1' }; } };
  const chatComplete = async () => ({ content: '{"title":"Landing inicial","goal":"Crea la landing con hero y CTA."}' });

  const res = await engine.runCycle({ project: PROJECT, deps: { prisma, runService, chatComplete } });
  assert.equal(res.action, 'proposed');
  assert.equal(created.length, 1);
  assert.equal(created[0].mode, 'plan');
  assert.match(created[0].prompt, /^\[PROACTIVO · CEO Office\]/);
  assert.match(created[0].prompt, /Landing inicial/);
  const p = engine.readProactiveState(prisma.state.project);
  assert.equal(p.runsToday, 1);
  assert.equal(p.deptIndex, 1, 'round-robin advances');
});

test('cycle phase 2: auto-approves ONLY its own waiting plan (creates the build)', async () => {
  const ownPlan = { id: 'plan-9', mode: 'plan', status: 'waiting_approval', prompt: '[PROACTIVO · CEO Office] X: y' };
  const prisma = fakePrisma({ project: PROJECT, activeRun: ownPlan });
  const created = [];
  const runService = { createRun: async (args) => { created.push(args); return { id: 'build-1' }; } };

  const res = await engine.runCycle({ project: PROJECT, deps: { prisma, runService, chatComplete: async () => { throw new Error('must not be called'); } } });
  assert.equal(res.action, 'approved_plan');
  assert.equal(created[0].mode, 'build');
  assert.equal(created[0].planRunId, 'plan-9');
});

test('cycle never touches a HUMAN waiting plan and skips busy projects', async () => {
  const humanPlan = { id: 'plan-h', mode: 'plan', status: 'waiting_approval', prompt: 'haz una tienda' };
  const prisma = fakePrisma({ project: PROJECT, activeRun: humanPlan });
  const res = await engine.runCycle({ project: PROJECT, deps: { prisma, runService: { createRun: async () => { throw new Error('must not create'); } }, chatComplete: async () => ({ content: '{}' }) } });
  assert.equal(res.action, 'skipped_active');

  const running = { id: 'r', mode: 'build', status: 'running', prompt: '[PROACTIVO · x] y' };
  const prisma2 = fakePrisma({ project: PROJECT, activeRun: running });
  const res2 = await engine.runCycle({ project: PROJECT, deps: { prisma: prisma2, runService: {}, chatComplete: async () => ({ content: '{}' }) } });
  assert.equal(res2.action, 'skipped_active');
});

test('daily budget cap + explicit 0 disables proposals (falsy-0 respected)', async () => {
  const capped = { ...PROJECT, brief: { proactive: { enabled: true, dayKey: new Date().toISOString().slice(0, 10), runsToday: 6 } } };
  const prisma = fakePrisma({ project: capped });
  const res = await engine.runCycle({ project: capped, deps: { prisma, runService: {}, chatComplete: async () => ({ content: '{}' }) } });
  assert.equal(res.action, 'skipped_budget');

  const res0 = await engine.runCycle({ project: PROJECT, deps: { prisma: fakePrisma({ project: PROJECT }), runService: {}, chatComplete: async () => ({ content: '{}' }) }, env: { CODEX_PROACTIVE_MAX_PER_DAY: '0' } });
  assert.equal(res0.action, 'skipped_budget');
});

test('invalid model output → skipped_no_proposal with lastError recorded, no run created', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  const res = await engine.runCycle({ project: PROJECT, deps: { prisma, runService: { createRun: async () => { throw new Error('must not create'); } }, chatComplete: async () => ({ content: 'no json here' }) } });
  assert.equal(res.action, 'skipped_no_proposal');
  assert.match(engine.readProactiveState(prisma.state.project).lastError || '', /inválida/);
});

test('disabled project is a no-op; tickAll isolates per-project failures', async () => {
  const off = { ...PROJECT, brief: { proactive: { enabled: false } } };
  const res = await engine.runCycle({ project: off, deps: { prisma: fakePrisma({ project: off }) } });
  assert.equal(res.action, 'disabled');

  const prisma = fakePrisma({ project: PROJECT });
  prisma.codexRun.findFirst = async () => { throw new Error('db down'); };
  const results = await engine.tickAll({ deps: { prisma, runService: {}, chatComplete: async () => ({ content: '{}' }) } });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'error');
});

test('ticker gating: prod default-on, test default-off, env forces both ways', () => {
  assert.equal(engine.startProactiveTicker({ env: { NODE_ENV: 'test' } }), false);
  assert.equal(engine.startProactiveTicker({ env: { NODE_ENV: 'test', CODEX_PROACTIVE_ENABLED: '0' } }), false);
  assert.equal(engine.startProactiveTicker({ env: { NODE_ENV: 'production', CODEX_PROACTIVE_ENABLED: '0' } }), false);
  assert.equal(engine.startProactiveTicker({ env: { NODE_ENV: 'test', CODEX_PROACTIVE_ENABLED: '1' }, deps: { prisma: { codexProject: { findMany: async () => [] } } } }), true);
  engine.stopProactiveTicker();
});

test('extractJson tolerates fences and prose around the object', () => {
  assert.deepEqual(engine.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(engine.extractJson('claro: {"title":"x","goal":"y"} listo'), { title: 'x', goal: 'y' });
  assert.equal(engine.extractJson('nada'), null);
});
