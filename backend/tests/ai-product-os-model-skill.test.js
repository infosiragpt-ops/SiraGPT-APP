const { test } = require('node:test');
const assert = require('node:assert/strict');

const modelRouter = require('../src/services/ai-product-os/model-router');
const skillSystem = require('../src/services/ai-product-os/skill-system');
const toolRegistry = require('../src/services/ai-product-os/tool-registry');
const semanticRouter = require('../src/services/ai-product-os/semantic-intent-router');
const planner = require('../src/services/ai-product-os/planner-agent');

test('model router selects a tool-capable reasoning model for academic document generation', () => {
  const decision = {
    intent_primary: 'complex_academic_document_generation',
    required_tools: ['research.agenticBatch', 'docintel.ground', 'create_document'],
    final_output: 'word_document',
  };
  const request = modelRouter.reqFromDecision(decision, {
    max_cost: 'high',
    latency: 'normal',
    user_plan: 'ENTERPRISE',
    language: 'es',
  });
  const result = modelRouter.select(request);

  assert.ok(result.model);
  assert.ok(result.model.supports_structured_outputs);
  assert.ok(result.score > 30);
  assert.ok(result.alternatives.length >= 1);
});

test('skill system composes primary and supporting skills for APA research document work', () => {
  const decision = {
    intent_primary: 'complex_academic_document_generation',
    intent_secondary: ['scientific_research', 'doi_validation', 'apa7_citation', 'docx_export'],
    required_agents: ['intent-compiler', 'planner'],
    required_tools: ['research.agenticBatch', 'docintel.ground', 'create_document', 'verify_artifact'],
    final_output: 'word_document',
  };
  const plan = skillSystem.buildSkillExecutionPlan(decision, { userPlan: 'ENTERPRISE' });

  const ids = plan.selected_skills.map(skill => skill.id);
  assert.ok(ids.includes('academic_report'));
  assert.ok(ids.includes('citation_checker'));
  assert.ok(ids.includes('web_research'));
  assert.ok(plan.required_tools.includes('verify_artifact'));
  assert.ok(plan.quality_rules.includes('no_fake_sources'));
  assert.equal(plan.release_policy.requires_evidence, true);
});

test('skill system prefers repo delivery CI workflow for GitHub main requests', () => {
  const decision = {
    intent_primary: 'code_generation',
    intent_secondary: ['repo_delivery', 'github_actions', 'ci_watch', 'main_branch_delivery', 'source_rewrite_not_copy'],
    required_agents: ['intent-compiler', 'planner'],
    required_tools: ['git.clone', 'repo.inspect', 'code-review.analyze', 'test.run', 'github.actions.monitor'],
    final_output: 'code_artifact',
  };
  const plan = skillSystem.buildSkillExecutionPlan(decision, { userPlan: 'ENTERPRISE' });
  const ids = plan.selected_skills.map(skill => skill.id);

  assert.ok(ids.includes('repo_delivery_ci'));
  assert.equal(ids.includes('app_builder'), false);
  assert.ok(plan.required_tools.includes('github.actions.monitor'));
  assert.ok(plan.quality_rules.includes('watch_newest_main_ci'));
  assert.ok(plan.quality_rules.includes('source_rewrite_not_copy'));
});

test('skill and tool registries are internally consistent', () => {
  assert.equal(toolRegistry.integrity().ok, true);
  assert.equal(skillSystem.integrity().ok, true);
});

test('semantic decision can be enriched with skills and converted to a valid execution graph', async () => {
  const decision = await semanticRouter.classifyIntent({
    prompt: 'Busca 40 artículos científicos reales con DOI y entrégalos en Excel',
  });
  const skillPlan = skillSystem.buildSkillExecutionPlan(decision, { userPlan: 'ENTERPRISE' });
  const enriched = skillSystem.mergeDecisionWithSkillPlan(decision, skillPlan);
  const { plan, validation } = planner.buildAndValidate(enriched);

  assert.equal(validation.ok, true);
  assert.ok(enriched.required_tools.includes('research.agenticBatch'));
  assert.ok(enriched.required_tools.includes('verify_artifact'));
  assert.ok(plan.nodes.some(node => node.id === 'research.collect'));
  assert.ok(plan.nodes.some(node => node.id === 'qa.regression'));
});
