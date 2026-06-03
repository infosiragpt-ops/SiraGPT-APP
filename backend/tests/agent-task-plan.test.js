const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentTaskPlan,
  buildAgentTaskPlanPrompt,
} = require('../src/services/agents/agent-task-plan');
const {
  buildExecutionProfile,
} = require('../src/services/agents/agentic-execution-profile');
const openclawCapabilityKernel = require('../src/services/openclaw-capability-kernel');
const {
  buildUserIntentAlignmentProfile,
} = require('../src/services/agents/user-intent-alignment');

test('agent task plan: maps strict academic Excel request to research + document + validation phases', () => {
  const goal = 'Busca 40 articulos cientificos reales y ponlos en Excel con DOI';
  const executionProfile = buildExecutionProfile({ goal });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal });
  const plan = buildAgentTaskPlan({ goal, executionProfile, intentAlignmentProfile, maxRuntimeMs: 7200000 });

  assert.equal(plan.runtimeBudgetMs, 7200000);
  assert.ok(plan.phases.some((phase) => phase.id === 'source_research'));
  assert.ok(plan.phases.some((phase) => phase.id === 'document_generation'));
  assert.ok(plan.phases.some((phase) => phase.id === 'file_validation'));
  assert.ok(plan.successCriteria.some((criterion) => criterion.includes('web_search')));
  assert.ok(plan.risks.some((risk) => /never pad/i.test(risk)));
});

test('agent task plan: includes private context phase when files are attached', () => {
  const goal = 'Dame un resumen';
  const executionProfile = buildExecutionProfile({ goal, fileIds: ['file_1'] });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal, fileIds: ['file_1'] });
  const plan = buildAgentTaskPlan({ goal, executionProfile, intentAlignmentProfile, fileIds: ['file_1'] });

  const privatePhase = plan.phases.find((phase) => phase.id === 'private_context');
  assert.ok(privatePhase);
  assert.deepEqual(privatePhase.requiredTools, ['docintel_analyze', 'rag_retrieve']);
  assert.equal(plan.groundingMode, 'private_context_required');
});

test('agent task plan prompt: is compact and exposes checkpoints', () => {
  const plan = buildAgentTaskPlan({
    goal: 'Genera una PPT profesional',
    executionProfile: buildExecutionProfile({ goal: 'Genera una PPT profesional' }),
    intentAlignmentProfile: buildUserIntentAlignmentProfile({ request: 'Genera una PPT profesional' }),
  });
  const prompt = buildAgentTaskPlanPrompt(plan);

  assert.match(prompt, /Task plan:/);
  assert.match(prompt, /Success criteria:/);
  assert.match(prompt, /Checkpoint:/);
  assert.match(prompt, /document_generation/);
});

test('agent task plan: OpenClaw autonomous fusion adds reference, runtime and autonomy phases', () => {
  const goal = 'Fusiona OpenClaw con SiraGPT y haz que funcione como un agente autonomo de software';
  const executionProfile = buildExecutionProfile({ goal });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal });
  const openclawProfile = openclawCapabilityKernel.buildCapabilityProfile({
    prompt: goal,
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });
  const plan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    openclawProfile,
  });

  assert.ok(plan.openclawFusion.active);
  assert.ok(plan.phases.some((phase) => phase.id === 'openclaw_reference_audit'));
  assert.ok(plan.phases.some((phase) => phase.id === 'native_runtime_fusion'));
  assert.ok(plan.phases.some((phase) => phase.id === 'autonomous_agent_contract'));
  assert.ok(plan.phases.some((phase) => phase.id === 'agent_runtime_diagnostics'));
  assert.equal(plan.agentRuntimeHardening.active, true);
  assert.ok(plan.agentRuntimeHardening.lanes.some((lane) => lane.id === 'tool_gate_integrity'));
  assert.ok(plan.successCriteria.some((criterion) => /OpenClaw capabilities/.test(criterion)));
  assert.ok(plan.successCriteria.some((criterion) => /Agent improvements/.test(criterion)));
  assert.ok(plan.risks.some((risk) => /overclaimed/.test(risk)));

  const prompt = buildAgentTaskPlanPrompt(plan);
  assert.match(prompt, /OpenClaw fusion:/);
  assert.match(prompt, /Agent runtime hardening matrix:/);
  assert.match(prompt, /wantsAutonomousAgent/);
});

test('agent task plan: software-agent hardening request adds runtime diagnostics without OpenClaw', () => {
  const goal = 'Sigamos mejorando los agentes del sofware';
  const executionProfile = buildExecutionProfile({ goal });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal });
  const plan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    toolManifests: [{ name: 'run_tests' }, { name: 'rag_retrieve' }],
  });

  assert.equal(plan.openclawFusion, null);
  assert.equal(plan.agentRuntimeHardening.active, true);
  assert.ok(plan.agentRuntimeHardening.verificationGates.some((gate) => /Tool manifest coverage/.test(gate)));
  assert.ok(plan.phases.some((phase) => phase.id === 'agent_runtime_diagnostics'));
  assert.ok(plan.phases.some((phase) => phase.id === 'qa_tests'));
  assert.ok(plan.successCriteria.some((criterion) => /tool-gate verification/.test(criterion)));
});

test('agent task plan: bulk OpenClaw source fusion adds inventory and activation budget controls', () => {
  const goal = 'Continuar mejorando: son millones de lineas de codigo que tenemos que copiar y fusionar desde OpenClaw';
  const executionProfile = buildExecutionProfile({ goal });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal });
  const openclawProfile = openclawCapabilityKernel.buildCapabilityProfile({
    prompt: goal,
    toolNames: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
  });
  const plan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    openclawProfile,
  });

  assert.equal(plan.openclawFusion.signals.massiveSourceFusion, true);
  assert.ok(plan.phases.some((phase) => phase.id === 'bulk_source_inventory'));
  assert.ok(plan.successCriteria.some((criterion) => /Bulk source fusion/.test(criterion)));
  assert.ok(plan.risks.some((risk) => /Million-line copy requests/.test(risk)));

  const prompt = buildAgentTaskPlanPrompt(plan);
  assert.match(prompt, /bulk_source_inventory/);
  assert.match(prompt, /massiveSourceFusion/);
});
