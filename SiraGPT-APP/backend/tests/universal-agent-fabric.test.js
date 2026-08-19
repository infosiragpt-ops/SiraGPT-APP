const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUniversalTaskContract,
} = require('../src/services/agents/universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
} = require('../src/services/agents/enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('../src/services/agents/enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('../src/services/agents/agentic-qa-board');
const {
  buildExecutionProfile,
  buildExecutionProfilePrompt,
} = require('../src/services/agents/agentic-execution-profile');
const {
  buildAgenticOperatingCore,
  buildAgenticOperatingPrompt,
  validateAgenticOperatingCore,
} = require('../src/services/agents/agentic-operating-core');
const {
  CYCLE_PHASES,
  FAMILY_DEFINITIONS,
  SPECIALIZATIONS,
  UNIVERSAL_AGENT_CATALOG,
  buildUniversalAgentFabric,
  buildUniversalAgentFabricPrompt,
  detectUniversalAgentRequest,
  validateUniversalAgentCatalog,
} = require('../src/services/agents/universal-agent-fabric');

const UNIVERSAL_REQUEST = 'Ciclo agentico para todo, 1000 agentes para entender el contexto del usuario, programar, validar y no finalizar hasta lograrlo';

function coreFor(request = UNIVERSAL_REQUEST) {
  const contract = buildUniversalTaskContract({ rawUserRequest: request });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'universal-agent-fabric-test' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const qaBoardReview = buildAgenticQaBoardReview({
    contract,
    graph,
    toolRuntimePlan,
    phase: 'universal-agent-preflight',
  });
  const core = buildAgenticOperatingCore({ contract, graph, toolRuntimePlan, qaBoardReview });
  return { contract, graph, toolRuntimePlan, qaBoardReview, core };
}

test('universal agent fabric defines exactly 1000 concrete agent profiles', () => {
  const validation = validateUniversalAgentCatalog(UNIVERSAL_AGENT_CATALOG);
  const ids = new Set(UNIVERSAL_AGENT_CATALOG.map((agent) => agent.id));
  const families = new Set(UNIVERSAL_AGENT_CATALOG.map((agent) => agent.family));

  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(UNIVERSAL_AGENT_CATALOG.length, 1000);
  assert.equal(ids.size, 1000);
  assert.equal(families.size, 20);
  assert.equal(FAMILY_DEFINITIONS.length, 20);
  assert.equal(SPECIALIZATIONS.length, 50);

  for (const phase of CYCLE_PHASES) {
    assert.ok(validation.coveredPhases.includes(phase), `missing phase ${phase}`);
  }
});

test('broad universal request selects a bounded team that covers all families and cycle phases', () => {
  const fabric = buildUniversalAgentFabric({ goal: UNIVERSAL_REQUEST });
  const activeFamilies = new Set(fabric.active_team.map((agent) => agent.family));
  const coveredPhases = new Set(fabric.active_team.flatMap((agent) => agent.cycle_phases));

  assert.equal(detectUniversalAgentRequest(UNIVERSAL_REQUEST), true);
  assert.equal(fabric.summary.totalAgentCount, 1000);
  assert.equal(fabric.summary.familyCount, 20);
  assert.equal(fabric.summary.activeFamilyCount, 20);
  assert.equal(activeFamilies.size, 20);
  assert.equal(fabric.summary.allCyclePhasesCovered, true);
  assert.equal(coveredPhases.size, CYCLE_PHASES.length);
  assert.ok(fabric.validation_checks.includes('universal_agents.catalog_1000'));
  assert.ok(fabric.validation_checks.includes('universal_agents.release_not_before_validation'));
});

test('programming request selects software, backend, QA and release agents', () => {
  const fabric = buildUniversalAgentFabric({
    goal: 'programa una mejora backend, ejecuta tests, revisa logs y sube a github cuando este verde',
  });

  assert.equal(fabric.summary.totalAgentCount, 1000);
  assert.ok(fabric.active_families.includes('software-engineering'));
  assert.ok(fabric.active_families.includes('backend-platform'));
  assert.ok(fabric.active_families.includes('qa-validation'));
  assert.ok(fabric.active_families.includes('devops-release'));
  assert.equal(fabric.summary.allCyclePhasesCovered, true);
});

test('execution profile exposes universal 1000-agent fabric and quality gate', () => {
  const profile = buildExecutionProfile({ goal: UNIVERSAL_REQUEST });
  const prompt = buildExecutionProfilePrompt(profile);

  assert.equal(profile.capabilities.needsAgentRuntimeHardening, true);
  assert.equal(profile.capabilities.needsUniversalAgentFabric, true);
  assert.equal(profile.universalAgents.summary.totalAgentCount, 1000);
  assert.equal(profile.universalAgents.summary.activeFamilyCount, 20);
  assert.ok(profile.qualityGates.some((gate) => /universal 1000-agent fabric/i.test(gate)));
  assert.match(prompt, /Universal agent fabric: \d+\/1000 active agents/);
  assert.match(prompt, /UNIVERSAL AGENT FABRIC/);
});

test('agentic operating core carries universal agents into validation, observability, regression and prompt', () => {
  const { core } = coreFor(UNIVERSAL_REQUEST);
  const prompt = buildAgenticOperatingPrompt(core);

  assert.equal(validateAgenticOperatingCore(core).ok, true);
  assert.equal(core.universal_agents.summary.totalAgentCount, 1000);
  assert.equal(core.universal_agents.summary.activeFamilyCount, 20);
  assert.equal(core.universal_agents.summary.allCyclePhasesCovered, true);
  assert.equal(core.summary.universalAgentCatalogCount, 1000);
  assert.ok(core.validation.deterministic_checks.includes('universal_agents.catalog_1000'));
  assert.ok(core.regression.generated_acceptance_tests.includes('universal_agent_catalog_1000'));
  assert.ok(core.observability.events.includes('universal_agent_team_selected'));
  assert.ok(core.observability.metrics.includes('universal_agent_catalog_count'));
  assert.match(prompt, /UNIVERSAL AGENT FABRIC/);
  assert.match(prompt, /"totalAgentCount": 1000/);
});
