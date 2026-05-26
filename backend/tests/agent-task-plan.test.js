const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentTaskPlan,
  buildAgentTaskPlanPrompt,
} = require('../src/services/agents/agent-task-plan');
const {
  buildExecutionProfile,
} = require('../src/services/agents/agentic-execution-profile');
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

  assert.ok(plan.phases.some((phase) => phase.id === 'private_context'));
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
