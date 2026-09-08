'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCompanyAutopilotPlan,
} = require('../src/services/codex/company-autopilot-planner');
const {
  buildEnterpriseCommandCenter,
  plannerInputFromCompany,
} = require('../src/services/codex/enterprise-command-center-service');
const {
  aggregateTaskProgress,
} = require('../src/services/codex/swarm-orchestrator');

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
  assert.equal(commandCenter.swarmSummary.active, 1);
  assert.equal(commandCenter.departments.length, 6);
  assert.equal(commandCenter.liveEvents[0].kind, 'coding');
  assert.doesNotMatch(JSON.stringify(commandCenter), /super-secret/);
});
