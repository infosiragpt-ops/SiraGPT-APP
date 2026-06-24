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
  COGNITIVE_IMPROVEMENT_CATALOG,
  COGNITIVE_IMPROVEMENT_VERSION,
  buildCognitiveImprovementBundle,
  buildCognitiveImprovementPrompt,
  validateCognitiveImprovementCatalog,
} = require('../src/services/agents/cognitive-improvements');

const BRAIN_REQUEST = 'Implementa 100 mejoras en el backend, mejora la parte del cerebro del software volviéndolo más inteligente y aplica pruebas e2e';

function coreFor(request = BRAIN_REQUEST) {
  const contract = buildUniversalTaskContract({ rawUserRequest: request });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'brain-e2e-task' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const qaBoardReview = buildAgenticQaBoardReview({
    contract,
    graph,
    toolRuntimePlan,
    phase: 'brain-preflight',
  });
  const core = buildAgenticOperatingCore({ contract, graph, toolRuntimePlan, qaBoardReview });
  return { contract, graph, toolRuntimePlan, qaBoardReview, core };
}

test('cognitive improvement catalog defines exactly 100 concrete backend brain controls', () => {
  const validation = validateCognitiveImprovementCatalog(COGNITIVE_IMPROVEMENT_CATALOG);
  const ids = new Set(COGNITIVE_IMPROVEMENT_CATALOG.map((item) => item.id));
  const categories = new Set(COGNITIVE_IMPROVEMENT_CATALOG.map((item) => item.category));

  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(COGNITIVE_IMPROVEMENT_CATALOG.length, 100);
  assert.equal(ids.size, 100);
  assert.equal(categories.size, 10);

  for (const item of COGNITIVE_IMPROVEMENT_CATALOG) {
    assert.match(item.id, /^cog-[a-z0-9-]+-\d{2}$/);
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.signal, 'string');
    assert.equal(typeof item.action, 'string');
    assert.equal(typeof item.prompt_rule, 'string');
    assert.equal(typeof item.deterministic_check, 'string');
    assert.equal(typeof item.metric, 'string');
    assert.equal(typeof item.evidence, 'string');
  }
});

test('backend brain request activates the 100-control cognitive upgrade bundle', () => {
  const { contract, graph } = coreFor(BRAIN_REQUEST);
  const bundle = buildCognitiveImprovementBundle({ contract, graph });
  const prompt = buildCognitiveImprovementPrompt(bundle);

  assert.equal(bundle.version, COGNITIVE_IMPROVEMENT_VERSION);
  assert.equal(bundle.summary.totalControlCount, 100);
  assert.equal(bundle.summary.categoryCount, 10);
  assert.equal(bundle.summary.activeControlCount, 100);
  assert.equal(bundle.summary.backendBrainRequest, true);
  assert.ok(bundle.active_categories.includes('intent-understanding'));
  assert.ok(bundle.active_categories.includes('tool-use-planning'));
  assert.ok(bundle.active_categories.includes('e2e-validation'));
  assert.ok(bundle.validation_checks.includes('cognitive.intent-ambiguity-map'));
  assert.ok(bundle.validation_checks.includes('cognitive.e2e-user-journey-probe'));
  assert.match(prompt, /COGNITIVE IMPROVEMENT CATALOG/);
  assert.match(prompt, /100-control cognitive upgrade/);
  assert.match(prompt, /e2e-validation/);
});

test('execution profile exposes cognitive controls for backend brain hardening', () => {
  const profile = buildExecutionProfile({ goal: BRAIN_REQUEST });
  const prompt = buildExecutionProfilePrompt(profile);

  assert.equal(profile.capabilities.needsAgentRuntimeHardening, true);
  assert.equal(profile.capabilities.needsCodeOrRepair, true);
  assert.ok(profile.requiredTools.includes('run_tests'));
  assert.equal(profile.cognitiveImprovements.summary.totalControlCount, 100);
  assert.equal(profile.cognitiveImprovements.summary.activeControlCount, 100);
  assert.ok(profile.qualityGates.some((gate) => /100-control cognitive upgrade/i.test(gate)));
  assert.match(prompt, /Cognitive brain upgrade/);
  assert.match(prompt, /100 controls/);
});

test('agentic operating core carries cognitive controls into validation, observability and prompt', () => {
  const { core } = coreFor(BRAIN_REQUEST);
  const prompt = buildAgenticOperatingPrompt(core);

  assert.equal(validateAgenticOperatingCore(core).ok, true);
  assert.equal(core.cognitive_improvements.summary.totalControlCount, 100);
  assert.equal(core.cognitive_improvements.active_controls.length, 100);
  assert.equal(core.summary.cognitiveImprovementCount, 100);
  assert.equal(core.summary.cognitiveCategoryCount, 10);
  assert.ok(core.validation.deterministic_checks.includes('cognitive.intent-ambiguity-map'));
  assert.ok(core.regression.generated_acceptance_tests.includes('cognitive_e2e_user_journey_probe'));
  assert.ok(core.observability.events.includes('cognitive_control_selected'));
  assert.ok(core.observability.metrics.includes('cognitive_control_pass_rate'));
  assert.match(prompt, /COGNITIVE IMPROVEMENT CATALOG/);
  assert.match(prompt, /100-control cognitive upgrade/);
});
