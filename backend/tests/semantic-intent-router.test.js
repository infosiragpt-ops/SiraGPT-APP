const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSemanticIntentAnalysis,
} = require('../src/services/agents/semantic-intent-router');

test('semantic router compiles research plus Excel into agentic execution', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'busca 40 artículos científicos reales y entrégalos en Excel con DOI clicables',
  });

  assert.equal(analysis.intent, 'agent_task');
  assert.equal(analysis.contract.pipeline, 'SpreadsheetPipeline');
  assert.equal(analysis.contract.required_extension, '.xlsx');
  assert.equal(analysis.contract.source_requirements.verification_policy, 'strict');
  assert.ok(analysis.routing.required_tools.includes('web_search'));
  assert.ok(analysis.routing.required_tools.includes('create_document'));
  assert.equal(analysis.structured_intent.intent_primary, 'spreadsheet_generation');
  assert.ok(analysis.skill_plan.selected_skills.some((skill) => skill.id === 'excel_dashboard'));
  assert.ok(analysis.skill_plan.selected_skills.some((skill) => skill.id === 'web_research'));
  assert.ok(analysis.model_routing.selection.model.id);
  assert.equal(analysis.product_os_plan_validation.ok, true);
  assert.ok(analysis.execution_graph.nodes.some((node) => node.id === 'tool_runtime_gateway'));
});

test('semantic router preserves format sovereignty for SVG', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'créame un SVG de una casa con dos ventanas',
  });

  assert.equal(analysis.intent, 'doc');
  assert.equal(analysis.contract.pipeline, 'VisualArtifactPipeline');
  assert.equal(analysis.contract.required_extension, '.svg');
  assert.equal(analysis.contract.mime_type, 'image/svg+xml');
  assert.equal(analysis.structured_intent.final_output, 'svg_artifact');
  assert.ok(analysis.skill_plan.quality_rules.includes('format_sovereignty'));
  assert.ok(analysis.contract.validation_plan.some((item) => item.check === 'parses_as_svg'));
});

test('semantic router routes web building to webdev without UI heuristics', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'crea una web de una empresa de carros',
  });

  assert.equal(analysis.intent, 'webdev');
  assert.equal(analysis.contract.pipeline, 'CodePipeline');
  assert.equal(analysis.routing.source, 'UniversalTaskContract+ExecutionGraph');
  assert.equal(analysis.structured_intent.intent_primary, 'web_app_build');
  assert.ok(analysis.skill_plan.selected_skills.some((skill) => skill.id === 'app_builder'));
  assert.ok(analysis.product_os_plan.nodes.some((node) => node.id === 'frontend.build'));
  assert.ok(analysis.confidence >= 0.55);
});

test('semantic router keeps scholarly source requests in grounded chat when no file is requested', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'dame 5 artículos científicos sobre estrategias multisensoriales sin ningún formato',
  });

  assert.equal(analysis.intent, 'web_search');
  assert.equal(analysis.contract.pipeline, 'ResearchGroundingPipeline');
  assert.equal(analysis.contract.required_extension, null);
  assert.equal(analysis.contract.artifact_required, false);
});

test('semantic router detects quantitative tasks before generic chat', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: "Calcula el Cronbach's alpha de estas respuestas Likert: [[4,5,3],[5,5,4]]",
  });

  assert.equal(analysis.intent, 'math');
  assert.equal(analysis.contract.pipeline, 'DirectAnswerPipeline');
  assert.ok(analysis.routing.domain_signals.math);
});
