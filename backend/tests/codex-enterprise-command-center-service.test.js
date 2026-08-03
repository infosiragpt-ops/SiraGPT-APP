'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCompanyAutopilotPlan,
} = require('../src/services/codex/company-autopilot-planner');
const {
  buildEnterpriseCommandCenter,
  plannerInputFromCompany,
  readinessProjection,
} = require('../src/services/codex/enterprise-command-center-service');
const {
  aggregateTaskProgress,
} = require('../src/services/codex/swarm-orchestrator');
const {
  planFleetTasks,
} = require('../src/services/codex/fleet-orchestrator');

function companyFixture() {
  return {
    profile: {
      companyName: 'SiraGPT',
      stage: 'growing',
      mission: 'Ayudar a empresas a ejecutar mejor.',
      vision: 'Operaciones autónomas con control humano.',
      offer: 'Agentes empresariales',
      targetCustomer: 'Equipos digitales',
      websiteUrl: 'https://siragpt.com',
      salesProcess: 'Descubrimiento, propuesta y cierre',
      autonomy: {
        socialPublishing: 'review',
        socialReplies: 'review',
        emailReplies: 'review',
        leadOutreach: 'review',
      },
      updatedAt: '2026-07-27T10:00:00.000Z',
    },
    readiness: {
      score: 86,
      areas: [
        { id: 'software', label: 'Software propio', status: 'ready', evidence: 'Workspace disponible.' },
        { id: 'social', label: 'Redes sociales', status: 'needs_attention', evidence: 'Sin conexión OAuth.' },
      ],
      evidence: {
        workspaceReady: true,
        publishedUrl: 'https://siragpt.com',
        socialConnections: [],
        gmailConnected: false,
      },
    },
  };
}

test('projects verified company evidence into the deterministic autopilot planner', () => {
  const input = plannerInputFromCompany(companyFixture());
  assert.equal(input.companyOperatingProfile.software.exists, true);
  assert.equal(input.companyOperatingProfile.website.exists, true);
  assert.equal(input.companyOperatingProfile.connections.social, false);
  assert.equal(input.companyOperatingProfile.automationPolicies.social.publish, false);
  const plan = buildCompanyAutopilotPlan(input);
  const social = plan.workstreams.find((item) => item.id === 'social_presence');
  const effect = social.tasks.find((item) => item.kind === 'external_effect');
  assert.equal(effect.execution.mode, 'proposal');
  assert.equal(effect.execution.canAutoExecute, false);
});

test('builds a safe executive projection from durable swarm and run events', () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const tasks = [
    {
      id: 'task-1',
      title: 'Auditar arquitectura',
      role: 'read-only',
      status: 'succeeded',
      input: { workstreamId: 'software_landing', workstreamTitle: 'Producto e Ingeniería' },
      result: { summary: 'No api_key=super-secret; arquitectura revisada.' },
      updatedAt: new Date('2026-07-27T11:00:00.000Z'),
    },
    {
      id: 'task-2',
      title: 'Integrar cambios',
      role: 'integrator',
      status: 'running',
      input: {},
      result: null,
      updatedAt: new Date('2026-07-27T11:01:00.000Z'),
    },
  ];
  const swarm = {
    id: 'swarm-1',
    name: 'CEO Office',
    status: 'running',
    maxConcurrency: 16,
    progressPercent: 50,
    totalTaskCount: 2,
    updatedAt: new Date('2026-07-27T11:01:00.000Z'),
  };
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: {
      swarm,
      tasks,
      progress: aggregateTaskProgress(tasks),
    },
    activity: [{
      id: 'event-1',
      title: 'Modificando código',
      detail: 'components/code/page.tsx',
      tone: 'active',
      department: 'Producto e Ingeniería',
      createdAt: '2026-07-27T11:02:00.000Z',
    }],
  });

  assert.equal(commandCenter.readiness.runState, 'running');
  assert.equal(commandCenter.swarmSummary.logicalAgents, 2);
  assert.equal(
    commandCenter.swarmSummary.planned,
    commandCenter.departments.reduce((total, department) => total + department.plannedTasks, 0),
  );
  assert.ok(commandCenter.swarmSummary.planned > 0);
  assert.equal(commandCenter.swarmSummary.active, 1);
  assert.equal(commandCenter.swarmSummary.blocked, 0);
  assert.equal(commandCenter.swarmSummary.cancelled, 0);
  assert.equal(commandCenter.departments.length, 6);
  assert.equal(commandCenter.liveEvents[0].kind, 'coding');
  assert.doesNotMatch(JSON.stringify(commandCenter), /super-secret/);
});

test('preserves every durable swarm lifecycle state in readiness', () => {
  const company = companyFixture();
  const cases = [
    [undefined, 'idle'],
    ['queued', 'queued'],
    ['running', 'running'],
    ['paused', 'paused'],
    ['cancelling', 'cancelling'],
    ['completed', 'completed'],
    ['completed_with_errors', 'completed_with_errors'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ];

  for (const [status, expected] of cases) {
    const projection = readinessProjection(company, status ? {
      status,
      updatedAt: new Date('2026-07-27T11:00:00.000Z'),
    } : null);
    assert.equal(projection.runState, expected, `${status || 'missing'} should remain ${expected}`);
  }
});

test('keeps planned work separate from persisted logical agents', () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const commandCenter = buildEnterpriseCommandCenter({ company, plan });
  const plannedTaskCount = plan.workstreams.reduce((total, workstream) => total + workstream.tasks.length, 0);

  assert.equal(commandCenter.readiness.runState, 'idle');
  assert.equal(commandCenter.swarmSummary.logicalAgents, 0);
  assert.equal(commandCenter.swarmSummary.planned, plannedTaskCount);
  assert.equal(commandCenter.swarmSummary.maxParallel, 0);
  assert.ok(commandCenter.departments.every((department) => department.status === 'planned'));
  assert.ok(commandCenter.departments.every((department) => department.logicalAgents === 0));
  assert.ok(commandCenter.departments.every((department) => department.plannedTasks > 0));
  assert.ok(commandCenter.departments.every((department) => department.lastUpdatedAt === null));
});

test('reports blocked, queued and cancelled tasks without merging their counts', () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const tasks = [
    {
      id: 'queued-1',
      title: 'Esperar capacidad',
      role: 'read-only',
      status: 'queued',
      input: { workstreamId: 'software_landing', workstreamTitle: 'Producto e Ingeniería' },
      updatedAt: new Date('2026-07-27T11:00:00.000Z'),
    },
    {
      id: 'blocked-1',
      title: 'Esperar dependencia',
      role: 'reviewer',
      status: 'blocked',
      input: { workstreamId: 'software_landing', workstreamTitle: 'Producto e Ingeniería' },
      updatedAt: new Date('2026-07-27T11:01:00.000Z'),
    },
    {
      id: 'cancelled-1',
      title: 'Trabajo cancelado',
      role: 'integrator',
      status: 'cancelled',
      input: { workstreamId: 'software_landing', workstreamTitle: 'Producto e Ingeniería' },
      updatedAt: new Date('2026-07-27T11:02:00.000Z'),
    },
  ];
  const swarm = {
    id: 'swarm-truth',
    name: 'CEO Office',
    status: 'queued',
    maxConcurrency: 4,
    progressPercent: 33,
    totalTaskCount: tasks.length,
    updatedAt: new Date('2026-07-27T11:02:00.000Z'),
  };
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: { swarm, tasks, progress: aggregateTaskProgress(tasks) },
  });
  const engineering = commandCenter.departments.find((department) => department.workstreamId === 'software_landing');

  assert.equal(commandCenter.swarmSummary.queued, 1);
  assert.equal(commandCenter.swarmSummary.blocked, 1);
  assert.equal(commandCenter.swarmSummary.cancelled, 1);
  assert.equal(engineering.status, 'blocked');
  assert.equal(engineering.queuedTasks, 1);
  assert.equal(engineering.blockedTasks, 1);
  assert.equal(engineering.cancelledTasks, 1);
  assert.ok(commandCenter.liveEvents.some((event) => event.status === 'blocked'));
  assert.ok(commandCenter.liveEvents.some((event) => event.status === 'cancelled'));
});

test('projects real fleet department ids and keeps untouched workstreams planned', async () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const fleet = await planFleetTasks({
    objective: 'Preparar contenido revisable',
    explicitTasks: [{
      id: 'marketing-draft',
      title: 'Preparar borrador de lanzamiento',
      description: 'Crear un borrador sin publicarlo.',
      departmentId: 'marketing',
      role: 'read-only',
      acceptance: ['Borrador listo para revisión humana'],
    }],
    desiredTasks: 1,
    qaEvery: 50,
  });
  const tasks = fleet.tasks.map((task, index) => ({
    ...task,
    id: `fleet-${index + 1}`,
    status: 'running',
    updatedAt: new Date('2026-07-27T11:00:00.000Z'),
  }));
  const swarm = {
    id: 'swarm-fleet-contract',
    name: 'CEO Office',
    status: 'running',
    maxConcurrency: 4,
    progressPercent: 0,
    totalTaskCount: tasks.length,
    updatedAt: new Date('2026-07-27T11:00:00.000Z'),
  };
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: { swarm, tasks, progress: aggregateTaskProgress(tasks) },
  });
  const marketing = commandCenter.departments.find((department) => department.id === 'marketing');
  const engineering = commandCenter.departments.find((department) => department.id === 'product-engineering');

  assert.equal(commandCenter.swarmSummary.logicalAgents, tasks.length);
  assert.ok(commandCenter.swarmSummary.planned > 0);
  assert.equal(marketing.status, 'active');
  assert.equal(marketing.logicalAgents, tasks.length);
  assert.equal(marketing.plannedTasks, 0);
  assert.equal(engineering.status, 'planned');
  assert.equal(engineering.logicalAgents, 0);
  assert.ok(commandCenter.liveEvents.some((event) => (
    event.departmentId === 'marketing' && event.departmentName === 'Marketing'
  )));
});

test('projects every durable fleet task exactly once and normalizes QA into Trust', async () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const fleet = await planFleetTasks({
    objective: 'Implementar y verificar una mejora',
    explicitTasks: [{
      id: 'implementation',
      title: 'Implementar mejora',
      description: 'Cambiar el workspace.',
      departmentId: 'product-engineering',
      role: 'writer',
      acceptance: ['Cambio verificado'],
    }],
    desiredTasks: 1,
    qaEvery: 1,
  });
  const tasks = fleet.tasks.map((task, index) => ({
    ...task,
    id: `fleet-qa-${index + 1}`,
    status: 'queued',
    updatedAt: new Date(`2026-07-27T11:0${index}:00.000Z`),
  }));
  const swarm = {
    id: 'swarm-fleet-qa',
    name: 'CEO Office',
    status: 'queued',
    maxConcurrency: 4,
    progressPercent: 0,
    totalTaskCount: tasks.length,
    updatedAt: new Date('2026-07-27T11:05:00.000Z'),
  };
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: { swarm, tasks, progress: aggregateTaskProgress(tasks) },
  });
  const trust = commandCenter.departments.find((department) => department.id === 'trust');

  assert.ok(tasks.some((task) => task.input.departmentId === 'trust-quality'));
  assert.equal(
    commandCenter.departments.reduce((total, department) => total + department.logicalAgents, 0),
    commandCenter.swarmSummary.logicalAgents,
  );
  assert.equal(trust.logicalAgents, 1);
  assert.equal(trust.queuedTasks, 1);
});

test('projects every fallback planner task exactly once into canonical departments', async () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const fleet = await planFleetTasks({
    objective: 'Construir y verificar la empresa sin planner remoto',
    companyPlan: plan,
    desiredTasks: 24,
    qaEvery: 5,
  });
  const tasks = fleet.tasks.map((task, index) => ({
    ...task,
    id: `fallback-${index + 1}`,
    status: 'queued',
    updatedAt: new Date(`2026-07-27T13:${String(index).padStart(2, '0')}:00.000Z`),
  }));
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: {
      swarm: {
        id: 'swarm-fallback',
        name: 'CEO Office',
        status: 'queued',
        maxConcurrency: 8,
        totalTaskCount: tasks.length,
        updatedAt: tasks[tasks.length - 1].updatedAt,
      },
      tasks,
      progress: aggregateTaskProgress(tasks),
    },
  });
  const persistedDepartments = new Set(tasks.map((task) => task.input.departmentId));

  assert.equal(fleet.source, 'fallback');
  assert.ok(tasks.length >= 24);
  assert.ok(tasks.every((task) => Boolean(task.input.departmentId)));
  assert.equal(persistedDepartments.has('software_landing'), false);
  assert.equal(persistedDepartments.has('social_presence'), false);
  assert.equal(
    commandCenter.departments.reduce((total, department) => total + department.logicalAgents, 0),
    commandCenter.swarmSummary.logicalAgents,
  );
});

test('remaps unknown planner departments before persistence so no task disappears', async () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const fleet = await planFleetTasks({
    objective: 'Preparar finanzas y marketing con evidencia',
    companyPlan: plan,
    desiredTasks: 2,
    qaEvery: 5,
    planner: async () => ({
      content: JSON.stringify({
        tasks: [
          {
            id: 'finance-review',
            title: 'Revisar finanzas',
            role: 'read-only',
            departmentId: 'finance',
          },
          {
            id: 'marketing-review',
            title: 'Revisar marketing',
            role: 'read-only',
            departmentId: 'marketing',
          },
        ],
      }),
    }),
  });
  const tasks = fleet.tasks.map((task, index) => ({
    ...task,
    id: `planner-${index + 1}`,
    status: 'queued',
    updatedAt: new Date(`2026-07-27T15:0${index}:00.000Z`),
  }));
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: {
      swarm: {
        id: 'swarm-planner-unknown-department',
        name: 'CEO Office',
        status: 'queued',
        maxConcurrency: 2,
        totalTaskCount: tasks.length,
        updatedAt: tasks[tasks.length - 1].updatedAt,
      },
      tasks,
      progress: aggregateTaskProgress(tasks),
    },
  });

  assert.equal(fleet.source, 'planner');
  assert.equal(tasks.find((task) => task.key === 'finance-review').input.departmentId, 'product-engineering');
  assert.equal(tasks.find((task) => task.key === 'marketing-review').input.departmentId, 'marketing');
  assert.equal(
    commandCenter.departments.reduce((total, department) => total + department.logicalAgents, 0),
    commandCenter.swarmSummary.logicalAgents,
  );
});

test('treats a persisted department as authoritative over contradictory workstream metadata', () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const tasks = [{
    id: 'contradictory-task',
    title: 'Preparar narrativa',
    role: 'read-only',
    status: 'running',
    input: { departmentId: 'marketing', workstreamId: 'software_landing' },
    updatedAt: new Date('2026-07-27T11:00:00.000Z'),
  }];
  const commandCenter = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: {
      swarm: {
        id: 'swarm-authority',
        name: 'CEO Office',
        status: 'running',
        maxConcurrency: 1,
        totalTaskCount: 1,
        updatedAt: tasks[0].updatedAt,
      },
      tasks,
      progress: aggregateTaskProgress(tasks),
    },
  });
  const marketing = commandCenter.departments.find((department) => department.id === 'marketing');
  const engineering = commandCenter.departments.find((department) => department.id === 'product-engineering');

  assert.equal(marketing.logicalAgents, 1);
  assert.equal(engineering.logicalAgents, 0);
  assert.equal(
    commandCenter.departments.reduce((total, department) => total + department.logicalAgents, 0),
    1,
  );
});

test('keeps latest persisted evidence for completed and cancelled departments', () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const build = (tasks, status) => buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: {
      swarm: {
        id: `swarm-${status}`,
        name: 'CEO Office',
        status,
        maxConcurrency: 2,
        totalTaskCount: tasks.length,
        updatedAt: tasks[tasks.length - 1].updatedAt,
      },
      tasks,
      progress: aggregateTaskProgress(tasks),
    },
  }).departments.find((department) => department.id === 'product-engineering');
  const completed = build([
    {
      id: 'done-1',
      title: 'Implementación inicial',
      role: 'writer',
      status: 'succeeded',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T11:00:00.000Z'),
    },
    {
      id: 'done-2',
      title: 'Verificación final',
      role: 'reviewer',
      status: 'succeeded',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T11:05:00.000Z'),
    },
  ], 'completed');
  const cancelled = build([
    {
      id: 'mixed-1',
      title: 'Trabajo conservado',
      role: 'writer',
      status: 'succeeded',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T12:00:00.000Z'),
    },
    {
      id: 'mixed-2',
      title: 'Verificación cancelada',
      role: 'reviewer',
      status: 'cancelled',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T12:05:00.000Z'),
    },
  ], 'cancelled');

  assert.equal(completed.status, 'completed');
  assert.equal(completed.currentWork, 'Verificación final');
  assert.equal(completed.lastUpdatedAt, '2026-07-27T11:05:00.000Z');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.currentWork, 'Verificación cancelada');
  assert.equal(cancelled.lastUpdatedAt, '2026-07-27T12:05:00.000Z');
});

test('uses the newest failure and the latest terminal timestamp for failed departments', () => {
  const company = companyFixture();
  const plan = buildCompanyAutopilotPlan(plannerInputFromCompany(company));
  const tasks = [
    {
      id: 'failed-old',
      title: 'Fallo inicial',
      role: 'writer',
      status: 'failed',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T14:00:00.000Z'),
    },
    {
      id: 'failed-new',
      title: 'Fallo verificado más reciente',
      role: 'reviewer',
      status: 'failed',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T14:05:00.000Z'),
    },
    {
      id: 'terminal-evidence',
      title: 'Evidencia terminal conservada',
      role: 'read-only',
      status: 'succeeded',
      input: { departmentId: 'product-engineering' },
      updatedAt: new Date('2026-07-27T14:10:00.000Z'),
    },
  ];
  const department = buildEnterpriseCommandCenter({
    company,
    plan,
    swarmProgress: {
      swarm: {
        id: 'swarm-completed-with-errors',
        name: 'CEO Office',
        status: 'completed_with_errors',
        maxConcurrency: 3,
        totalTaskCount: tasks.length,
        updatedAt: tasks[tasks.length - 1].updatedAt,
      },
      tasks,
      progress: aggregateTaskProgress(tasks),
    },
  }).departments.find((item) => item.id === 'product-engineering');

  assert.equal(department.status, 'failed');
  assert.equal(department.currentWork, 'Fallo verificado más reciente');
  assert.equal(department.lastUpdatedAt, '2026-07-27T14:10:00.000Z');
});
