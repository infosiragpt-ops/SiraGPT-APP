'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAN_SCHEMA_VERSION,
  TASK_KINDS,
  EFFECT_LEVELS,
  EXTERNAL_ACTIONS,
  buildCompanyAutopilotPlan,
  buildCompanyAutopilotPlanWithLlm,
  buildOperatingContext,
  resolveExternalExecution,
  validateCompanyAutopilotPlan,
} = require('../src/services/codex/company-autopilot-planner');

function getWorkstream(plan, id) {
  return plan.workstreams.find((workstream) => workstream.id === id);
}

function getTask(plan, id) {
  return plan.workstreams
    .flatMap((workstream) => workstream.tasks)
    .find((task) => task.id === id);
}

function getExternalTasks(plan) {
  return plan.workstreams
    .flatMap((workstream) => workstream.tasks)
    .filter((task) => task.kind === TASK_KINDS.EXTERNAL_EFFECT);
}

function fullyConnectedProfile(overrides = {}) {
  return {
    companyMode: 'existing',
    companyName: 'Andes Cloud',
    mission: 'Ayudar a empresas andinas a operar mejor.',
    vision: 'Ser la plataforma empresarial más confiable de la región.',
    software: { exists: true },
    website: { exists: true, url: 'https://example.test' },
    social: { facebook: { connected: true }, strategyReady: true },
    inbox: { connected: true, processReady: true },
    sales: {
      connected: true,
      idealCustomerProfile: 'Empresas medianas con operaciones distribuidas.',
      pipelineReady: true,
    },
    quality: { systemReady: true },
    metrics: { configured: true },
    connections: {
      deployment: true,
      social: true,
      inbox: true,
      crm: true,
      billing: true,
      contracts: true,
      sales: true,
    },
    ...overrides,
  };
}

function allAutoPolicies() {
  return {
    software: { deploy: 'auto' },
    social: { publish: 'auto', respond: 'auto' },
    inbox: { respond: 'auto' },
    sales: { contactLeads: 'auto', closeSales: 'auto' },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

test('builds a professional six-workstream plan for a new company', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: {
      companyMode: 'new',
      companyName: 'Nova Norte',
    },
    readiness: {},
  });

  assert.equal(plan.schemaVersion, PLAN_SCHEMA_VERSION);
  assert.equal(plan.companyMode, 'new');
  assert.equal(plan.companyName, 'Nova Norte');
  assert.equal(plan.workstreams.length, 6);
  assert.equal(plan.executionRoutes.length, 6);
  assert.deepEqual(
    new Set(plan.workstreams.map((workstream) => workstream.id)),
    new Set([
      'mission_vision',
      'software_landing',
      'social_presence',
      'inbox_customer_service',
      'customer_acquisition_sales',
      'quality_assurance',
    ])
  );
  assert.equal(plan.priorities[0].workstreamId, 'mission_vision');
  assert.equal(plan.priorities[1].workstreamId, 'software_landing');
  assert.ok(plan.executiveSummary.length <= 320);
  assert.match(plan.executiveSummary, /Nova Norte/);
  assert.equal(validateCompanyAutopilotPlan(plan).ok, true);
});

test('consumes an existing company profile and readiness without replacing healthy capabilities', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: fullyConnectedProfile({
      quality: { systemReady: false },
      metrics: { configured: false },
    }),
    readiness: {
      quality: { ready: false },
      metrics: { ready: false },
    },
  });

  assert.equal(plan.companyMode, 'existing');
  assert.equal(plan.operatingContext.readiness.mission, true);
  assert.equal(plan.operatingContext.readiness.vision, true);
  assert.equal(plan.operatingContext.readiness.software, true);
  assert.equal(plan.operatingContext.readiness.landing, true);
  assert.equal(plan.operatingContext.connections.social, true);
  assert.equal(plan.operatingContext.connections.inbox, true);
  assert.equal(getWorkstream(plan, 'quality_assurance').status, 'gap_detected');
  assert.equal(getWorkstream(plan, 'mission_vision').status, 'maintain_and_improve');
});

test('accepts common readiness aliases and infers an operating company', () => {
  const context = buildOperatingContext(
    {
      name: 'Empresa Activa',
      domain: 'empresa.example',
      strategy: {
        mission: 'Resolver operaciones comerciales complejas.',
        vision: 'Liderar el mercado regional con confianza.',
      },
      landingPage: { url: 'https://empresa.example' },
      socialAccounts: {
        linkedin: { status: 'connected' },
      },
      integrations: {
        email: { verified: true },
        crm: { status: 'active' },
      },
    },
    {
      product: { ready: true },
      social: { contentPlan: 'complete' },
      support: { ready: true },
      sales: {
        idealCustomerProfile: { ready: true },
        pipeline: { ready: true },
      },
      qa: { ready: true },
      analytics: { configured: true },
    }
  );

  assert.equal(context.companyMode, 'existing');
  assert.equal(context.readiness.mission, true);
  assert.equal(context.readiness.vision, true);
  assert.equal(context.readiness.software, true);
  assert.equal(context.readiness.landing, true);
  assert.equal(context.readiness.socialPresence, true);
  assert.equal(context.readiness.socialStrategy, true);
  assert.equal(context.readiness.inboxProcess, true);
  assert.equal(context.readiness.idealCustomerProfile, true);
  assert.equal(context.readiness.salesPipeline, true);
  assert.equal(context.connections.inbox, true);
  assert.equal(context.connections.crm, true);
});

test('distinguishes read-only research, internal drafts and external effects', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: { companyMode: 'new' },
    readiness: {},
  });
  const tasks = plan.workstreams.flatMap((workstream) => workstream.tasks);
  const research = tasks.filter((task) => task.kind === TASK_KINDS.RESEARCH);
  const drafts = tasks.filter((task) => task.kind === TASK_KINDS.DRAFT);
  const effects = tasks.filter((task) => task.kind === TASK_KINDS.EXTERNAL_EFFECT);

  assert.ok(research.length > 0);
  assert.ok(drafts.length > 0);
  assert.ok(effects.length > 0);
  assert.ok(research.every((task) => task.effect === EFFECT_LEVELS.READ_ONLY));
  assert.ok(drafts.every((task) => task.effect === EFFECT_LEVELS.INTERNAL_WRITE));
  assert.ok(effects.every((task) => task.effect === EFFECT_LEVELS.EXTERNAL_WRITE));
  assert.deepEqual(plan.summary.taskKinds, {
    research: research.length,
    draft: drafts.length,
    externalEffect: effects.length,
  });
});

test('defaults every disconnected external action to proposals and blocked approvals', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: {
      companyMode: 'existing',
      companyName: 'Sin Conectores',
    },
    readiness: {},
  });
  const effects = getExternalTasks(plan);

  assert.equal(effects.length, 6);
  assert.ok(effects.every((task) => task.status === 'proposal_required'));
  assert.ok(effects.every((task) => task.execution.mode === 'proposal'));
  assert.ok(effects.every((task) => task.execution.requiresApproval));
  assert.ok(effects.every((task) => task.execution.connectionVerified === false));
  assert.equal(plan.proposals.length, effects.length);
  assert.equal(plan.approvalQueue.length, effects.length);
  assert.ok(plan.approvalQueue.every((item) => item.status === 'blocked_pending_connection'));
});

test('connected external actions still require approval when auto policy is absent', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: fullyConnectedProfile(),
    readiness: {},
  });
  const effects = getExternalTasks(plan);

  assert.ok(effects.every((task) => task.status === 'approval_required'));
  assert.ok(effects.every((task) => task.execution.connectionVerified));
  assert.ok(effects.every((task) => task.execution.autoPolicyEnabled === false));
  assert.ok(effects.every((task) => task.execution.canAutoExecute === false));
  assert.equal(plan.proposals.length, 0);
  assert.equal(plan.approvalQueue.length, effects.length);
  assert.ok(plan.approvalQueue.every((item) => item.status === 'pending'));
});

test('verified connections plus explicit auto policies only make actions ready for execution', () => {
  const profile = fullyConnectedProfile({
    automationPolicies: allAutoPolicies(),
  });
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: profile,
    readiness: {},
  });
  const effects = getExternalTasks(plan);

  assert.ok(effects.every((task) => task.status === 'ready_for_execution'));
  assert.ok(effects.every((task) => task.execution.mode === 'auto'));
  assert.ok(effects.every((task) => task.execution.connectionVerified));
  assert.ok(effects.every((task) => task.execution.autoPolicyEnabled));
  assert.ok(effects.every((task) => task.execution.canAutoExecute));
  assert.ok(effects.every((task) => task.resultClaim === 'not_executed'));
  assert.ok(effects.every((task) => task.execution.completionClaimAllowed === false));
  assert.equal(plan.approvalQueue.length, 0);
  assert.equal(plan.summary.externalActions.claimedCompleted, 0);
  assert.match(plan.executiveSummary, /evidencia real/i);
});

test('auto policy alone cannot bypass missing real connections', () => {
  const decision = resolveExternalExecution({
    action: EXTERNAL_ACTIONS.PUBLISH_SOCIAL,
    connectionRequirements: [
      { anyOf: ['social'], label: 'cuenta social conectada' },
    ],
    connections: { social: false },
    policy: 'auto',
  });

  assert.equal(decision.status, 'proposal_required');
  assert.equal(decision.mode, 'proposal');
  assert.equal(decision.connectionVerified, false);
  assert.equal(decision.autoPolicyEnabled, true);
  assert.equal(decision.canAutoExecute, false);
  assert.equal(decision.completionClaimAllowed, false);
  assert.match(decision.blockers[0], /missing_connection/);
});

test('real connection without auto policy stays behind human approval', () => {
  const decision = resolveExternalExecution({
    action: EXTERNAL_ACTIONS.RESPOND_INBOX,
    connectionRequirements: [
      { anyOf: ['inbox'], label: 'bandeja conectada' },
    ],
    connections: { inbox: true },
    policy: 'approval',
  });

  assert.equal(decision.status, 'approval_required');
  assert.equal(decision.mode, 'approval');
  assert.equal(decision.connectionVerified, true);
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.canAutoExecute, false);
  assert.deepEqual(decision.blockers, ['explicit_auto_policy_missing']);
});

test('department routes always return through QA and CEO Office', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: { companyMode: 'new' },
    readiness: {},
  });

  for (const route of plan.executionRoutes) {
    assert.equal(route.path[0], 'CEO Office');
    assert.equal(route.path.at(-1), 'CEO Office');
    assert.ok(route.path.includes('Calidad, Riesgo y Cumplimiento'));
    assert.deepEqual(
      route.sequence.map((stage) => stage.stage),
      ['research', 'draft', 'quality_gate', 'external_effect', 'executive_report']
    );
    assert.equal(route.sequence[3].gate, 'verified_connection_plus_policy');
  }
});

test('plan generation is deterministic, pure and does not mutate frozen input', () => {
  const input = deepFreeze({
    companyOperatingProfile: {
      companyMode: 'existing',
      name: 'Determinista',
      website: { url: 'https://determinista.example' },
      connections: {
        social: true,
      },
    },
    readiness: {
      mission: true,
      vision: false,
    },
  });
  const before = JSON.stringify(input);
  const first = buildCompanyAutopilotPlan(input);
  const second = buildCompanyAutopilotPlan(input);

  assert.deepEqual(first, second);
  assert.equal(first.planId, second.planId);
  assert.equal(JSON.stringify(input), before);
});

test('safe optional LLM injection can refine narrative but cannot change controls', async () => {
  let requestSeen;
  const input = {
    companyOperatingProfile: fullyConnectedProfile(),
    readiness: {},
  };
  const base = buildCompanyAutopilotPlan(input);
  const enhanced = await buildCompanyAutopilotPlanWithLlm(input, {
    llm: async (request) => {
      requestSeen = request;
      return {
        executiveSummary: 'Andes Cloud: reforzar calidad operativa y conversión con evidencia antes de ejecutar acciones externas.',
        workstreamRationales: {
          quality_assurance: 'Consolidar controles medibles para sostener decisiones y entregas confiables.',
        },
        priorities: [{ workstreamId: 'social_presence', rank: 1 }],
        workstreams: [{ id: 'social_presence', status: 'done' }],
        governance: { defaultExternalActionMode: 'auto' },
      };
    },
  });

  assert.match(requestSeen.constraints.join(' '), /Do not change task status/);
  assert.equal(enhanced.llmEnhancement.applied, true);
  assert.match(enhanced.executiveSummary, /reforzar calidad operativa/);
  assert.match(getWorkstream(enhanced, 'quality_assurance').rationale, /controles medibles/);
  assert.deepEqual(enhanced.priorities, base.priorities);
  assert.deepEqual(enhanced.governance, base.governance);
  assert.deepEqual(getExternalTasks(enhanced), getExternalTasks(base));
  assert.equal(validateCompanyAutopilotPlan(enhanced).ok, true);
});

test('unsafe LLM completion claims are rejected without weakening the base plan', async () => {
  const input = {
    companyOperatingProfile: fullyConnectedProfile(),
    readiness: {},
  };
  const base = buildCompanyAutopilotPlan(input);
  const result = await buildCompanyAutopilotPlanWithLlm(input, {
    llm: async () => ({
      executiveSummary: 'Publicamos todo, contactamos a los leads y cerramos la venta.',
    }),
  });

  assert.equal(result.executiveSummary, base.executiveSummary);
  assert.equal(result.llmEnhancement.applied, false);
  assert.equal(result.llmEnhancement.reason, 'no_safe_changes');
  assert.ok(getExternalTasks(result).every((task) => task.resultClaim === 'not_executed'));
});

test('LLM failure degrades to the deterministic plan without throwing or leaking errors', async () => {
  const input = {
    companyOperatingProfile: { companyMode: 'new', name: 'Fallback' },
    readiness: {},
  };
  const base = buildCompanyAutopilotPlan(input);
  const result = await buildCompanyAutopilotPlanWithLlm(input, {
    llm: async () => {
      throw new Error('secret provider detail');
    },
  });

  assert.equal(result.planId, base.planId);
  assert.equal(result.executiveSummary, base.executiveSummary);
  assert.deepEqual(result.workstreams, base.workstreams);
  assert.deepEqual(result.llmEnhancement, {
    applied: false,
    reason: 'llm_failed',
  });
  assert.doesNotMatch(JSON.stringify(result), /secret provider detail/);
});

test('validator rejects false completion and unsafe automatic execution', () => {
  const plan = buildCompanyAutopilotPlan({
    companyOperatingProfile: { companyMode: 'new' },
    readiness: {},
  });
  const tampered = structuredClone(plan);
  const target = getTask(tampered, 'social_presence.publish');
  const unsafeReady = getTask(tampered, 'inbox_customer_service.respond');
  tampered.executiveSummary = 'Publicamos el contenido y cerramos la venta.';
  target.status = 'completed';
  target.resultClaim = 'completed';
  target.execution.canAutoExecute = true;
  target.execution.connectionVerified = false;
  target.execution.autoPolicyEnabled = false;
  target.execution.completionClaimAllowed = true;
  target.execution.completionEvidenceRequired = false;
  unsafeReady.status = 'ready_for_execution';
  unsafeReady.execution.mode = 'auto';
  unsafeReady.execution.connectionVerified = false;
  unsafeReady.execution.autoPolicyEnabled = false;
  unsafeReady.execution.canAutoExecute = false;

  const result = validateCompanyAutopilotPlan(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('unsafe_executive_summary'));
  assert.ok(result.errors.some((error) => error.includes('external_task_status_invalid')));
  assert.ok(result.errors.some((error) => error.includes('external_task_false_completion')));
  assert.ok(result.errors.some((error) => error.includes('external_completion_claim_allowed')));
  assert.ok(result.errors.some((error) => error.includes('external_completion_evidence_missing')));
  assert.ok(result.errors.some((error) => error.includes('unsafe_auto_execution')));
  assert.ok(result.errors.some((error) => error.includes('unsafe_ready_for_execution')));
});

test('rejects invalid profile and readiness input shapes with clear errors', () => {
  assert.throws(
    () => buildCompanyAutopilotPlan(null),
    /input must be an object/
  );
  assert.throws(
    () => buildCompanyAutopilotPlan({ companyOperatingProfile: [] }),
    /companyOperatingProfile must be an object/
  );
  assert.throws(
    () => buildCompanyAutopilotPlan({ readiness: 'ready' }),
    /readiness must be an object/
  );
});
