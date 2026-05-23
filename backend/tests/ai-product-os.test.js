const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUniversalTaskContract,
} = require('../src/services/agents/universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
} = require('../src/services/agents/enterprise-agentic-runtime');
const {
  buildToolRuntimePlan,
} = require('../src/services/agents/enterprise-tool-gateway');
const {
  buildAgenticQaBoardReview,
} = require('../src/services/agents/agentic-qa-board');
const {
  AGENTIC_KERNEL_AGENTS,
  SYSTEM_LAW,
  buildAiProductOperatingSystem,
  buildAiProductOperatingPrompt,
  validateAiProductOperatingSystem,
} = require('../src/services/agents/ai-product-os');
const {
  buildAgenticOperatingCore,
  buildAgenticOperatingPrompt,
} = require('../src/services/agents/agentic-operating-core');

function buildOs(prompt) {
  const contract = buildUniversalTaskContract({ rawUserRequest: prompt });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'test-ai-product-os', userId: 'user-test', chatId: 'chat-test' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const qaBoardReview = buildAgenticQaBoardReview({ contract, graph, toolRuntimePlan, phase: 'preflight' });
  const os = buildAiProductOperatingSystem({ contract, graph, toolRuntimePlan, qaBoardReview });
  return { contract, graph, toolRuntimePlan, qaBoardReview, os };
}

test('AI Product OS compiles contract and graph into schema artifacts and YAML DAG', () => {
  const { os } = buildOs('Crea una web SaaS en Next.js con dashboard, autenticación, roles, tests, CI y despliegue controlado');

  assert.equal(validateAiProductOperatingSystem(os).ok, true);
  assert.ok(os.schema_artifacts.some((artifact) => artifact.filename === 'UniversalTaskContract.schema.json'));
  assert.ok(os.schema_artifacts.some((artifact) => artifact.filename === 'ExecutionGraph.yaml'));
  assert.match(os.execution_graph_yaml, /kind: ExecutionGraph/);
  assert.match(os.execution_graph_yaml, /nodes:/);
  assert.match(os.execution_graph_yaml, /release_gate:/);
  assert.ok(os.execution_graph.nodes.some((node) => node.layer === 'SoftwareEngineeringPipeline'));
  assert.ok(os.execution_graph.nodes.some((node) => node.layer === 'FullStackWebBuilder'));
});

test('AI Product OS enforces non-negotiable system law', () => {
  const { os } = buildOs('Haz un Excel con artículos reales, DOI verificables y citas APA 7');

  for (const [key, value] of Object.entries(SYSTEM_LAW)) {
    assert.equal(os.system_law[key], value, key);
  }
  assert.equal(os.release_policy.block_release_if_validation_fails, true);
  assert.equal(os.release_policy.block_release_if_unverified_sources, true);
  assert.equal(os.evidence_ledger.source_evidence_required, true);
});

test('AI Product OS declares Temporal, LangGraph, MCP and OpenAI Agents SDK compatible bindings', () => {
  const { os } = buildOs('Analiza este PDF, extrae tablas, contradicciones, referencias y genera una matriz de evidencia');

  assert.equal(os.runtime_bindings.temporal.required, true);
  assert.equal(os.runtime_bindings.temporal.workflow_type, 'AgenticProductWorkflow');
  assert.equal(os.runtime_bindings.langgraph.required, true);
  assert.equal(os.runtime_bindings.langgraph.persistent_state, true);
  assert.equal(os.runtime_bindings.mcp_gateway.required, true);
  assert.equal(os.runtime_bindings.mcp_gateway.declared_tools_only, true);
  assert.equal(os.runtime_bindings.openai_agents_sdk.compatible, true);
  assert.ok(os.runtime_bindings.openai_agents_sdk.primitives.includes('handoffs'));
  assert.ok(os.runtime_bindings.openai_agents_sdk.primitives.includes('guardrails'));
});

test('AI Product OS exposes the complete enterprise agentic kernel with veto roles', () => {
  const { os } = buildOs('Crea un dashboard Power BI de mercado con scraping permitido, KPIs, SWOT, TAM SAM SOM y exportación');
  const agents = new Set(os.agentic_kernel.agents.map((agent) => agent.name));

  for (const agent of AGENTIC_KERNEL_AGENTS) {
    assert.equal(agents.has(agent), true, `${agent} missing`);
  }

  assert.equal(os.agentic_kernel.agents.find((agent) => agent.name === 'SecurityReviewerAgent').veto_right, true);
  assert.equal(os.agentic_kernel.agents.find((agent) => agent.name === 'QARegressionAgent').veto_right, true);
  assert.equal(os.agentic_kernel.agents.find((agent) => agent.name === 'ReleaseManagerAgent').veto_right, true);
});

test('AI Product OS keeps database and scraping execution governed by read-only and no-bypass policy', () => {
  const { os } = buildOs('Conecta una base de datos Postgres y scrapea precios públicos de competidores respetando robots.txt');

  assert.equal(os.security_governance.read_only_database_default, true);
  assert.ok(os.security_governance.no_bypass_policy.includes('no_captcha_bypass'));
  assert.ok(os.security_governance.no_bypass_policy.includes('no_paywall_bypass'));
  assert.ok(os.execution_graph.nodes.some((node) => node.validation_gate.deterministic_checks.includes('prepared_statements_only')));
  assert.ok(os.execution_graph.nodes.some((node) => node.validation_gate.deterministic_checks.includes('no_captcha_paywall_bypass')));
});

test('AgenticOperatingCore embeds AI Product OS without UI requirements', () => {
  const { contract, graph, toolRuntimePlan, qaBoardReview } = buildOs('Programa una API con tests, seguridad, Docker y GitHub Actions');
  const core = buildAgenticOperatingCore({ contract, graph, toolRuntimePlan, qaBoardReview });
  const prompt = buildAgenticOperatingPrompt(core);

  assert.equal(core.ai_product_os.summary.contractFirst, true);
  assert.equal(core.ai_product_os.summary.interfaceChanges, false);
  assert.match(prompt, /AI PRODUCT OPERATING SYSTEM/);
  assert.match(prompt, /do_not_answer_freely/);
  assert.match(prompt, /TemporalWorkflowAdapter/);
});

test('AI Product OS prompt is compact enough for internal policy injection', () => {
  const { os } = buildOs('Crea un SVG de una casa minimalista y valida que sea image/svg+xml');
  const prompt = buildAiProductOperatingPrompt(os);

  assert.match(prompt, /AI Product OS laws/);
  assert.match(prompt, /UniversalTaskContract\.schema\.json/);
  assert.match(prompt, /ExecutionGraph\.yaml/);
  assert.ok(prompt.length < 30000);
});
