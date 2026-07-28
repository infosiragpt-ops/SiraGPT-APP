'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/codex/proactive-engine');
const {
  socialResourceKeyForConnection,
} = require('../src/services/codex/company-resources');

function socialKey(platform) {
  return socialResourceKeyForConnection({
    id: `connection-${platform}`,
    platform,
    accountId: `account-${platform}`,
  });
}

function fakePrisma({ project, activeRun = null, recentRuns = [] } = {}) {
  const state = { project: { ...project }, updates: [] };
  return {
    state,
    codexProject: {
      findFirst: async () => ({ ...state.project }),
      findUnique: async () => ({ ...state.project }),
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
    codexRunMetric: {
      aggregate: async () => ({ _sum: { costOriginalUsd: 0, costAppliedUsd: 0 } }),
    },
    codexUsageEntry: {
      findMany: async () => [],
    },
  };
}

const PROJECT = { id: 'p1', userId: 'u1', name: 'SiraGPT.COM', brief: { proactive: { enabled: true } } };

test('readProactiveState defaults + setProactive persists into brief JSON', async () => {
  assert.equal(engine.readProactiveState({ brief: null }).enabled, false);
  assert.equal(engine.readProactiveState({ brief: null }).dailyBudgetUsd, null);
  const prisma = fakePrisma({ project: { ...PROJECT, brief: { goal: 'x' } } });
  const out = await engine.setProactive({ prisma, projectId: 'p1', userId: 'u1', enabled: true });
  assert.equal(out.state.enabled, true);
  assert.ok(prisma.state.project.brief.proactive.enabled, 'written inside brief.proactive');
  assert.equal(prisma.state.project.brief.goal, 'x', 'rest of brief preserved');

  const off = await engine.setProactive({ prisma, projectId: 'p1', userId: 'u1', enabled: false });
  assert.equal(off.state.enabled, false);
});

test('mixed legacy and current metric rows count the larger cost per row', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  prisma.codexRunMetric.findMany = async () => [
    { costOriginalUsd: 1.25, costAppliedUsd: 0.5 },
    { costOriginalUsd: null, costAppliedUsd: 2 },
    { costOriginalUsd: 0.75, costAppliedUsd: 1 },
  ];
  const result = await require('../src/services/codex/project-budget').costTodayUsd({
    prisma,
    projectId: PROJECT.id,
    now: new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(result, 4.25);
});

test('company budget includes autonomous usage outside CodexRun metrics', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  prisma.codexRunMetric.findMany = async () => [
    { costOriginalUsd: 1, costAppliedUsd: 0.5 },
  ];
  prisma.codexUsageEntry = {
    findMany: async ({ where }) => {
      assert.equal(where.projectId, PROJECT.id);
      return [{ costOriginalUsd: 0.75, costAppliedUsd: 0.75 }];
    },
  };
  const result = await require('../src/services/codex/project-budget').costTodayUsd({
    prisma,
    projectId: PROJECT.id,
    now: new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(result, 1.75);
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
  assert.match(created[0].prompt, /\[SIRA_PROACTIVE_META\]/);
  const p = engine.readProactiveState(prisma.state.project);
  assert.equal(p.runsToday, 1);
  assert.equal(p.deptIndex, 1, 'round-robin advances');
});

test('proposal retries an open failed task and only accepts a different remediation', async () => {
  const calls = [];
  const proposal = await engine.proposeTask({
    project: { id: 'p-ledger', name: 'SiraGPT', brief: {} },
    department: { id: 'product-engineering', name: 'Producto', mission: 'Mejora el producto.' },
    recentRuns: [],
    fileTree: 'src/App.tsx',
    notes: '',
    ledger: [{
      runId: 'run-failed',
      department: 'Producto',
      title: 'Corrige checkout roto',
      outcome: 'failed',
      learnings: ['El contrato de pagos no acepta currency vacía.'],
      ts: '2026-07-25T10:00:00.000Z',
    }],
    objectives: [],
    chatComplete: async ({ messages }) => {
      calls.push(messages.map((message) => ({ ...message })));
      if (calls.length === 1) {
        return {
          content: '{"title":"Corrige checkout roto","goal":"Repite el cambio anterior."}',
        };
      }
      return {
        content: '{"title":"Valida moneda antes del pago","goal":"Añade validación previa de currency y una prueba de regresión."}',
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0][1].content, /FALLOS ABIERTOS DEL LEDGER/);
  assert.match(calls[0][1].content, /failureKey=corrige-checkout-roto/);
  assert.match(calls[1].at(-1).content, /PROPUESTA RECHAZADA/);
  assert.equal(proposal.title, 'Valida moneda antes del pago');
});

test('proposal is skipped when the model repeats the same open failure twice', async () => {
  let calls = 0;
  const proposal = await engine.proposeTask({
    project: { id: 'p-ledger', name: 'SiraGPT', brief: {} },
    department: { id: 'product-engineering', name: 'Producto', mission: 'Mejora el producto.' },
    recentRuns: [],
    fileTree: '',
    notes: '',
    ledger: [{
      runId: 'run-failed',
      title: 'Corrige checkout roto',
      outcome: 'failed',
    }],
    objectives: [],
    chatComplete: async () => {
      calls += 1;
      return {
        content: '{"title":"Corrige checkout roto","goal":"Vuelve a intentar exactamente lo mismo."}',
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(proposal, null);
});

test('concurrent schedulers acquire one proactive lease per project', async () => {
  const project = {
    ...PROJECT,
    id: 'lease-project',
    brief: { proactive: { enabled: true } },
  };
  const prisma = fakePrisma({ project });
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let completeResolve;
  const complete = new Promise((resolve) => { completeResolve = resolve; });
  const first = engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => ({ id: 'leased-run' }) },
      chatComplete: async () => {
        enteredResolve();
        await complete;
        return { content: '{"title":"Tarea única","goal":"Ejecuta una sola propuesta."}' };
      },
    },
  });
  await entered;
  const second = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not run'); } },
      chatComplete: async () => { throw new Error('must not call'); },
    },
  });
  assert.equal(second.action, 'skipped_cycle_leased');
  completeResolve();
  assert.equal((await first).action, 'proposed');
});

test('CEO Office grounds planning in readiness and persists the shared company profile', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  prisma.socialConnection = { findMany: async () => [] };
  prisma.user = { findUnique: async () => ({ gmailTokens: null }) };
  const created = [];
  let messages = [];
  const result = await engine.runCycle({
    project: PROJECT,
    deps: {
      prisma,
      runService: {
        createRun: async (args) => {
          created.push(args);
          return { id: 'run-profile' };
        },
      },
      chatComplete: async (args) => {
        messages = args.messages;
        return {
          content: JSON.stringify({
            title: 'Define negocio base',
            goal: 'Documenta misión, visión, oferta y cliente objetivo con la evidencia disponible.',
            acceptanceCriteria: ['El perfil operativo queda persistido'],
            objectives: [{
              id: 'business-foundation',
              title: 'Definir la empresa',
              metric: 'campos confirmados',
              target: '4',
              status: 'active',
              priority: 1,
            }],
            companyProfile: {
              stage: 'existing',
              mission: 'Ayudar a empresas a ejecutar trabajo con agentes.',
              vision: 'Ser el mejor agente de código empresarial.',
              offer: 'Software operativo con agentes.',
              targetCustomer: 'Empresas digitales.',
            },
          }),
        };
      },
    },
  });

  assert.equal(result.action, 'proposed');
  assert.equal(created.length, 1);
  assert.match(messages[1].content, /Brechas verificadas/);
  assert.match(messages[1].content, /No hay cuentas sociales OAuth conectadas/);
  assert.equal(prisma.state.project.brief.companyProfile.stage, 'existing');
  assert.equal(prisma.state.project.brief.companyProfile.autonomy.socialPublishing, 'review');
  assert.equal(prisma.state.project.brief.objectives[0].id, 'business-foundation');
});

test('CEO Office refreshes a stale business audit and uses its prioritized gaps', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  let analyzerCalls = 0;
  let proposalMessages = [];
  const result = await engine.runCycle({
    project: PROJECT,
    deps: {
      prisma,
      businessAnalyzer: {
        analyzeBusiness: async () => {
          analyzerCalls += 1;
          return {
            version: 1,
            generatedAt: '2026-07-28T18:00:00.000Z',
            projectId: PROJECT.id,
            companyName: PROJECT.name,
            status: 'gaps_detected',
            score: 25,
            networkUsed: false,
            websiteUrl: null,
            signals: [{
              id: 'landing',
              label: 'Landing publica',
              status: 'blocked',
              evidence: 'No hay landing publica.',
              sources: [],
            }],
            gaps: [{
              id: 'landing',
              priority: 'P0',
              score: 95,
              departmentId: 'product-engineering',
              title: 'Construir la landing principal',
              action: 'Construir una landing Vite y verificarla.',
              evidence: 'No hay landing publica.',
            }],
            sources: [],
          };
        },
      },
      businessAnalyzerNetworkEnabled: false,
      runService: { createRun: async () => ({ id: 'audit-plan' }) },
      chatComplete: async ({ messages }) => {
        proposalMessages = messages;
        return {
          content: JSON.stringify({
            title: 'Construir landing',
            goal: 'Crea la landing priorizada por la auditoria de presencia.',
          }),
        };
      },
    },
    env: { NODE_ENV: 'test', CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });

  assert.equal(result.action, 'proposed');
  assert.equal(analyzerCalls, 1);
  assert.equal(prisma.state.project.brief.businessAudit.gaps[0].id, 'landing');
  assert.match(proposalMessages[1].content, /AUDITORIA DE PRESENCIA/);
  assert.match(proposalMessages[1].content, /Construir la landing principal/);
});

test('USD kill switch blocks proposals using persisted run costs', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  prisma.codexRunMetric = {
    aggregate: async () => ({ _sum: { costAppliedUsd: 2.75 } }),
  };
  const res = await engine.runCycle({
    project: PROJECT,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create'); } },
      chatComplete: async () => ({ content: '{}' }),
    },
    env: { CODEX_PROACTIVE_DAILY_BUDGET_USD: '2' },
  });
  assert.equal(res.action, 'skipped_cost_budget');
  assert.equal(res.costTodayUsd, 2.75);
  assert.equal(engine.readProactiveState(prisma.state.project).budgetBlocked, true);
});

test('USD kill switch uses configuredDailyBudgetUsd before the environment default', async () => {
  const project = {
    ...PROJECT,
    brief: { proactive: { enabled: true, configuredDailyBudgetUsd: 1 } },
  };
  const prisma = fakePrisma({ project });
  prisma.codexRunMetric.aggregate = async () => ({
    _sum: { costOriginalUsd: 1, costAppliedUsd: 0.5 },
  });

  const res = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create'); } },
      chatComplete: async () => { throw new Error('must not propose'); },
    },
    env: { CODEX_PROACTIVE_DAILY_BUDGET_USD: '99' },
  });

  assert.equal(res.action, 'skipped_cost_budget');
  assert.equal(res.reason, 'daily_budget_exceeded');
  assert.equal(res.dailyBudgetUsd, 1);
  assert.equal(res.costTodayUsd, 1, 'kill switch uses provider spend before discounts');
});

test('telemetry from a prior cycle never overrides a later operator budget change', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  let spend = 0;
  prisma.codexRunMetric.aggregate = async () => ({
    _sum: { costOriginalUsd: spend, costAppliedUsd: spend },
  });
  const created = [];
  const first = await engine.runCycle({
    project: PROJECT,
    deps: {
      prisma,
      runService: {
        createRun: async (args) => {
          created.push(args);
          return { id: 'first-run' };
        },
      },
      chatComplete: async () => ({
        content: '{"title":"Primera tarea","goal":"Ejecuta una mejora incremental."}',
      }),
    },
    env: { CODEX_PROACTIVE_DAILY_BUDGET_USD: '25' },
  });
  assert.equal(first.action, 'proposed');
  assert.equal(engine.readProactiveState(prisma.state.project).dailyBudgetUsd, 25);

  spend = 5;
  const second = await engine.runCycle({
    project: prisma.state.project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create'); } },
      chatComplete: async () => { throw new Error('must not propose'); },
    },
    env: { CODEX_PROACTIVE_DAILY_BUDGET_USD: '5' },
  });
  assert.equal(second.action, 'skipped_cost_budget');
  assert.equal(second.dailyBudgetUsd, 5);
  assert.equal(created.length, 1);
});

test('USD kill switch fails closed when the daily cost store cannot be read', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  prisma.codexRunMetric.aggregate = async () => { throw new Error('database unavailable'); };

  const res = await engine.runCycle({
    project: PROJECT,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create'); } },
      chatComplete: async () => { throw new Error('must not propose'); },
    },
    env: { NODE_ENV: 'test', CODEX_PROACTIVE_DAILY_BUDGET_USD: '25' },
  });

  assert.equal(res.action, 'skipped_cost_budget');
  assert.equal(res.reason, 'budget_query_failed');
  assert.equal(res.costTodayUsd, null);
  assert.equal(engine.readProactiveState(prisma.state.project).budgetBlocked, true);
  assert.match(engine.readProactiveState(prisma.state.project).lastError, /no se pudo verificar/i);
});

test('every Kth proposal is a QA cycle and does not advance the department cursor', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const project = {
    ...PROJECT,
    brief: { proactive: { enabled: true, dayKey: today, runsToday: 4, deptIndex: 3 } },
  };
  const prisma = fakePrisma({ project });
  const created = [];
  const res = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async (args) => { created.push(args); return { id: 'qa-plan' }; } },
      chatComplete: async () => ({
        content: '{"title":"Audita regresiones","goal":"Revisa el diff acumulado.","acceptanceCriteria":["Vitest pasa","La preview renderiza"]}',
      }),
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '5' },
  });
  assert.equal(res.action, 'proposed');
  assert.equal(res.department, 'qa-reviewer');
  assert.equal(res.qaCycle, true);
  assert.match(created[0].prompt, /"qaCycle":true/);
  assert.equal(engine.readProactiveState(prisma.state.project).deptIndex, 3);
});

test('Marketing department delegates to social-company instead of creating a code run', async () => {
  const marketingIndex = engine.DEPARTMENTS.findIndex((department) => department.id === 'marketing');
  const project = {
    ...PROJECT,
    status: 'ready',
    workspacePath: 'projects/p1',
    brief: {
      proactive: { enabled: true, deptIndex: marketingIndex, missionIndex: 3 },
      companyProfile: {
        mission: 'Operar empresas con agentes.',
        vision: 'Ser el mejor agente de código empresarial.',
        offer: 'Software operativo con agentes.',
        targetCustomer: 'Empresas digitales.',
        salesProcess: 'Descubrimiento, calificación, propuesta y cierre.',
        websiteUrl: 'https://siragpt.com',
      },
    },
  };
  const prisma = fakePrisma({ project });
  prisma.socialConnection = {
    findMany: async () => [{ platform: 'linkedin', accountName: '@siragpt' }],
  };
  prisma.user = { findUnique: async () => ({ gmailTokens: null }) };
  let calls = 0;
  let allowedPlatforms = 'not-called';
  const result = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create a code run'); } },
      socialAutopilot: {
        generateDepartmentPost: async (args) => {
          calls += 1;
          allowedPlatforms = args.allowedPlatforms;
          return { action: 'drafted_review', postId: 'post-1' };
        },
      },
      chatComplete: async () => { throw new Error('must not propose code'); },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });
  assert.equal(calls, 1);
  assert.deepEqual(allowedPlatforms, [], 'no resource assignments must fail closed');
  assert.equal(result.action, 'marketing_drafted_review');
  assert.equal(
    engine.readProactiveState(prisma.state.project).deptIndex,
    (marketingIndex + 1) % engine.DEPARTMENTS.length,
  );
  assert.equal(prisma.state.project.brief.ledger[0].runId, 'social:post-1');
});

test('Marketing receives only social platforms explicitly assigned to its department', async () => {
  const marketingIndex = engine.DEPARTMENTS.findIndex((department) => department.id === 'marketing');
  const project = {
    ...PROJECT,
    brief: {
      proactive: { enabled: true, deptIndex: marketingIndex },
      companyResources: {
        assignments: {
          [socialKey('linkedin')]: 'marketing',
          [socialKey('x')]: 'sales',
          'connector:notion': 'marketing',
        },
        pinned: [],
      },
    },
  };
  const prisma = fakePrisma({ project });
  let allowedPlatforms = null;
  const result = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create a code run'); } },
      socialAutopilot: {
        generateDepartmentPost: async (args) => {
          allowedPlatforms = args.allowedPlatforms;
          return { action: 'drafted_review', postId: 'post-allowlisted' };
        },
      },
      chatComplete: async () => { throw new Error('must not propose code'); },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });
  assert.equal(result.action, 'marketing_drafted_review');
  assert.deepEqual(allowedPlatforms, ['linkedin']);
});

test('Sales department performs evidence-backed lead research instead of creating code', async () => {
  const salesIndex = engine.DEPARTMENTS.findIndex((department) => department.id === 'sales');
  const project = {
    ...PROJECT,
    brief: {
      proactive: { enabled: true, deptIndex: salesIndex },
      companyProfile: {
        offer: 'Agentes de software',
        targetCustomer: 'Empresas B2B',
      },
    },
  };
  const prisma = fakePrisma({ project });
  const result = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create code'); } },
      companyOperations: {
        researchLeads: async () => ({
          action: 'leads_saved',
          leads: [{ id: 'lead-1' }, { id: 'lead-2' }],
          sourceCount: 9,
        }),
      },
      chatComplete: async () => { throw new Error('operations stub owns the model'); },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });
  assert.equal(result.action, 'sales_leads_saved');
  assert.equal(result.leads, 2);
  assert.equal(prisma.state.project.brief.ledger[0].outcome, 'passed');
});

test('Customer Success creates review-first inbox work and records it in the ledger', async () => {
  const departmentIndex = engine.DEPARTMENTS.findIndex((department) => department.id === 'customer-success');
  const project = {
    ...PROJECT,
    brief: {
      proactive: { enabled: true, deptIndex: departmentIndex },
      companyResources: {
        assignments: {
          'connector:gmail': 'customer-success',
          'social:v2:x:connection-x:account-x': 'customer-success',
        },
        pinned: [],
      },
    },
  };
  const prisma = fakePrisma({ project });
  const result = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create code'); } },
      companyOperations: {
        triageInbox: async () => ({
          action: 'triaged_review',
          items: [{ id: 'inbox-1' }],
          actions: [{ id: 'action-1', status: 'pending_review' }],
          policy: { mode: 'review' },
        }),
        triageSocialConversations: async () => ({
          action: 'social_triaged_review',
          items: [{ id: 'social-1' }],
          actions: [{ id: 'action-2', status: 'pending_review' }],
          policy: { mode: 'review' },
        }),
      },
      chatComplete: async () => { throw new Error('operations stub owns the model'); },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });
  assert.equal(result.action, 'customer_success_triaged_review');
  assert.equal(result.inboxItems, 1);
  assert.equal(result.socialItems, 1);
  assert.equal(result.actions, 2);
  assert.match(prisma.state.project.brief.ledger[0].acceptance[0].evidence, /social=1/);
  assert.match(prisma.state.project.brief.ledger[0].acceptance[0].evidence, /social_policy=review/);
});

test('Customer Success does not touch provider operations without an assigned resource', async () => {
  const departmentIndex = engine.DEPARTMENTS.findIndex(
    (department) => department.id === 'customer-success',
  );
  const project = {
    ...PROJECT,
    brief: {
      proactive: { enabled: true, deptIndex: departmentIndex },
      companyResources: { assignments: {}, pinned: [] },
    },
  };
  const prisma = fakePrisma({ project });
  let operationCalls = 0;
  const result = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: { createRun: async () => { throw new Error('must not create code'); } },
      companyOperations: {
        triageInbox: async () => {
          operationCalls += 1;
          throw new Error('must not read Gmail');
        },
        triageSocialConversations: async () => {
          operationCalls += 1;
          throw new Error('must not read social providers');
        },
      },
      chatComplete: async () => { throw new Error('must not call the model'); },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });

  assert.equal(result.action, 'customer_success_company_resource_not_assigned');
  assert.equal(operationCalls, 0);
  assert.equal(prisma.state.project.brief.ledger[0].outcome, 'blocked');
});

test('custom departments participate in the persisted round-robin', async () => {
  const project = {
    ...PROJECT,
    brief: {
      proactive: {
        enabled: true,
        deptIndex: engine.DEPARTMENTS.length,
      },
      companyDepartments: [{
        id: 'custom-partnerships',
        name: 'Alianzas',
        mission: 'Identifica alianzas verificables para distribución.',
        desiredAgents: 40,
      }],
      companyResources: {
        assignments: {
          'connector:notion': 'custom-partnerships',
          [socialKey('x')]: 'marketing',
        },
        pinned: [],
      },
    },
  };
  const prisma = fakePrisma({ project });
  const created = [];
  let proposalMessages = [];
  const result = await engine.runCycle({
    project,
    deps: {
      prisma,
      runService: {
        createRun: async (args) => {
          created.push(args);
          return { id: 'partnership-plan' };
        },
      },
      chatComplete: async ({ messages }) => {
        proposalMessages = messages;
        return {
          content: '{"title":"Mapea alianzas","goal":"Documenta cinco aliados con evidencia publica."}',
        };
      },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });
  assert.equal(result.department, 'custom-partnerships');
  assert.match(created[0].prompt, /^\[PROACTIVO · Alianzas\]/);
  assert.match(proposalMessages[1].content, /Recursos asignados a este departamento/);
  assert.match(proposalMessages[1].content, /connector:notion/);
  assert.doesNotMatch(proposalMessages[1].content, /social:x/);
  assert.equal(engine.readProactiveState(prisma.state.project).deptIndex, 0);
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
  const capped = { ...PROJECT, brief: { proactive: { enabled: true, dayKey: new Date().toISOString().slice(0, 10), runsToday: 48 } } };
  const prisma = fakePrisma({ project: capped });
  const res = await engine.runCycle({ project: capped, deps: { prisma, runService: {}, chatComplete: async () => ({ content: '{}' }) } });
  assert.equal(res.action, 'skipped_budget');

  const res0 = await engine.runCycle({ project: PROJECT, deps: { prisma: fakePrisma({ project: PROJECT }), runService: {}, chatComplete: async () => ({ content: '{}' }) }, env: { CODEX_PROACTIVE_MAX_PER_DAY: '0' } });
  assert.equal(res0.action, 'skipped_budget');
});

test('department pool budget blocks only that turn and advances the round-robin', async () => {
  const prisma = fakePrisma({ project: PROJECT });
  const res = await engine.runCycle({
    project: PROJECT,
    deps: {
      prisma,
      departmentPools: {
        checkDepartmentPoolBudget: async () => ({
          allowed: false,
          reason: 'daily_budget_exceeded',
          costTodayUsd: 3,
          dailyBudgetUsd: 3,
          remainingUsd: 0,
        }),
      },
      runService: { createRun: async () => { throw new Error('must not create'); } },
      chatComplete: async () => { throw new Error('must not propose'); },
    },
    env: { CODEX_PROACTIVE_QA_EVERY_CYCLES: '0' },
  });
  assert.equal(res.action, 'skipped_department_budget');
  assert.equal(res.department, 'ceo-office');
  assert.equal(engine.readProactiveState(prisma.state.project).deptIndex, 1);
  assert.match(engine.readProactiveState(prisma.state.project).lastError, /presupuesto diario/i);
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
