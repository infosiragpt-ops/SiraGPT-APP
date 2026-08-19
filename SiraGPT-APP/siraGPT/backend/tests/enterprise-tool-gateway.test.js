const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildUniversalTaskContract } = require('../src/services/agents/universal-task-contract');
const { buildEnterpriseExecutionGraph } = require('../src/services/agents/enterprise-agentic-runtime');
const {
  buildToolGatewayCatalog,
  buildToolRuntimePlan,
  authorizeExecutionGraph,
  authorizeToolUse,
} = require('../src/services/agents/enterprise-tool-gateway');

test('enterprise tool gateway exposes legacy and enterprise manifests in one strict catalog', () => {
  const catalog = buildToolGatewayCatalog();

  assert.equal(catalog.ok, true);
  assert.ok(catalog.tools.create_document, 'legacy create_document must be present');
  assert.ok(catalog.tools.code_scaffold, 'enterprise code_scaffold must be present');
  assert.equal(catalog.tools.create_document.source, 'legacy');
  assert.equal(catalog.tools.code_scaffold.source, 'enterprise');
  assert.ok(catalog.tools.create_document.permissions.includes('artifact:write'));
});

test('tool runtime plan authorizes a full-stack web request graph', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Crea una web SaaS profesional en Next.js con dashboard, autenticación, roles, tests y CI',
  });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-gateway-web' });
  const plan = buildToolRuntimePlan({ contract, graph });

  assert.equal(plan.ok, true);
  assert.ok(plan.summary.authorizedToolCount > 0);
  assert.ok(plan.authorization.authorizedTools.some((tool) => tool.name === 'code_scaffold'));
  assert.ok(plan.authorization.authorizedTools.some((tool) => tool.name === 'build_run'));
  assert.equal(plan.summary.sideEffectSummary.write > 0, true);
});

test('gateway blocks tools forbidden by the UniversalTaskContract', () => {
  const contract = {
    ...buildUniversalTaskContract({ rawUserRequest: 'Busca artículos científicos reales y dame las fuentes' }),
    forbidden_tools: ['web_search'],
  };
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-forbidden-tool' });
  const plan = buildToolRuntimePlan({ contract, graph });

  assert.equal(plan.ok, false);
  assert.ok(plan.authorization.blockers.some((blocker) => blocker.code === 'forbidden_tool'));
});

test('gateway blocks undeclared tools and preserves node context', () => {
  const contract = buildUniversalTaskContract({ rawUserRequest: 'Hola' });
  const graph = {
    graph_id: 'eg_manual',
    nodes: [
      { id: 'bad_node', tools: ['ghost_tool'], release_gate: { requires_human_confirmation: false } },
    ],
  };
  const auth = authorizeExecutionGraph({ graph, contract });

  assert.equal(auth.ok, false);
  assert.equal(auth.blockers[0].code, 'undeclared_tool');
  assert.equal(auth.blockers[0].nodeId, 'bad_node');
});

test('gateway flags HITL for external side-effect tools without treating the manifest as invalid', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Usa el navegador para revisar una página pública y toma evidencia visual',
  });
  const decision = authorizeToolUse({ toolName: 'browser_automation', contract });

  assert.equal(decision.ok, true);
  assert.equal(decision.requiresHumanConfirmation, true);
  assert.ok(decision.warnings.some((warning) => warning.code === 'human_confirmation_required'));
});
