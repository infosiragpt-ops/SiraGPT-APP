const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildUniversalTaskContract } = require('../src/services/agents/universal-task-contract');
const { buildEnterpriseExecutionGraph } = require('../src/services/agents/enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('../src/services/agents/enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('../src/services/agents/agentic-qa-board');
const {
  buildAgenticOperatingCore,
  buildAgenticOperatingPrompt,
  inferOperatingDomains,
  validateAgenticOperatingCore,
} = require('../src/services/agents/agentic-operating-core');

function coreFor(request) {
  const contract = buildUniversalTaskContract({ rawUserRequest: request });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'test-task' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const qaBoardReview = buildAgenticQaBoardReview({
    contract,
    graph,
    toolRuntimePlan,
    phase: 'preflight',
  });
  const core = buildAgenticOperatingCore({ contract, graph, toolRuntimePlan, qaBoardReview });
  return { contract, graph, toolRuntimePlan, qaBoardReview, core };
}

test('agentic operating core compiles full-stack web/software requests into enterprise domains', () => {
  const { core } = coreFor('Crea una plataforma SaaS full-stack en Next.js con dashboard, autenticación, roles, pruebas, CI/CD y despliegue controlado');
  const domains = new Set(core.domains.map((domain) => domain.id));

  assert.equal(validateAgenticOperatingCore(core).ok, true);
  assert.equal(domains.has('software-engineering-pipeline'), true);
  assert.equal(domains.has('full-stack-web-builder'), true);
  assert.equal(domains.has('security-governance-layer'), true);
  assert.equal(domains.has('validation-fabric'), true);
  assert.equal(domains.has('observability-plane'), true);
  assert.equal(core.workflow.dag_required, true);
  assert.ok(core.regression.generated_acceptance_tests.includes('lint_typecheck_tests_build'));
  assert.ok(core.validation.reports_required.includes('CodeReview'));
  assert.ok(core.validation.reports_required.includes('SecurityReport'));
});

test('agentic operating core applies database and web-compliance gates', () => {
  const { core } = coreFor('Conecta una base de datos Postgres con SQL parametrizado y scrapea precios públicos de competidores respetando robots.txt');
  const checks = new Set(core.validation.deterministic_checks);
  const domains = new Set(core.domains.map((domain) => domain.id));

  assert.equal(domains.has('database-connector-layer'), true);
  assert.equal(domains.has('web-automation-scraping-layer'), true);
  assert.equal(checks.has('read_only_default'), true);
  assert.equal(checks.has('prepared_statements_only'), true);
  assert.equal(checks.has('robots_txt_respected'), true);
  assert.equal(checks.has('no_captcha_paywall_bypass'), true);
  assert.ok(core.risk_register.some((risk) => risk.code === 'database_mutation'));
  assert.ok(core.risk_register.some((risk) => risk.code === 'web_compliance'));
});

test('agentic operating core requires evidence ledger for research and BI work', () => {
  const { core, contract } = coreFor('Investiga el mercado, calcula TAM SAM SOM, crea KPIs tipo Power BI y genera un dashboard con fuentes reales');
  const domains = inferOperatingDomains({ contract, graph: { architecture_layers: core.domains.map((domain) => domain.layer), nodes: [] } });
  const domainIds = new Set(core.domains.map((domain) => domain.id));

  assert.ok(domains.length >= 5);
  assert.equal(domainIds.has('research-market-intelligence-engine'), true);
  assert.equal(domainIds.has('business-intelligence-studio'), true);
  assert.equal(core.validation.deterministic_checks.includes('evidence_ledger_present'), true);
  assert.equal(core.release.block_on_unverified_sources, true);
});

test('agentic operating prompt blocks untyped tools and failed releases', () => {
  const { core } = coreFor('Programa una API Node, analiza seguridad, ejecuta tests y sube cambios a GitHub');
  const prompt = buildAgenticOperatingPrompt(core);

  assert.match(prompt, /AGENTIC OPERATING CORE/);
  assert.match(prompt, /Use typed tools only when authorized/);
  assert.match(prompt, /run validation and block delivery/);
  assert.match(prompt, /read-only parameterized queries/);
  assert.equal(core.self_repair.required, true);
  assert.equal(core.release.release_controller_required, true);
});
