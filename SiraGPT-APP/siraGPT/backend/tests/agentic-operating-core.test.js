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

test('AI Product Studio blueprint binds software engineering evidence and release gates', () => {
  const { core } = coreFor('Crea una app full-stack Next.js con API, roles, Docker, GitHub Actions, tests E2E, escaneo de secretos y despliegue controlado');
  const studio = core.product_studio;
  const software = studio.active_playbooks.find((playbook) => playbook.id === 'software-engineering-pipeline');
  const web = studio.active_playbooks.find((playbook) => playbook.id === 'full-stack-web-builder');

  assert.equal(studio.execution_model.contract_first, true);
  assert.equal(studio.execution_model.dag_runtime, true);
  assert.equal(studio.execution_model.durable_execution, true);
  assert.ok(software.agents.includes('ProjectScaffolder'));
  assert.ok(software.agents.includes('DeploymentAgent'));
  assert.ok(software.evidence_required.includes('build_log'));
  assert.ok(software.validation_checks.includes('secret_scan_executed'));
  assert.ok(web.validation_checks.includes('wcag_gate_present'));
  assert.equal(studio.production_controls.clean_architecture_required, true);
  assert.equal(studio.production_controls.no_destructive_git_without_confirmation, true);
});

test('AI Product Studio blueprint hardens database and web automation playbooks', () => {
  const { core } = coreFor('Analiza una base Postgres con SQL read-only y scrapea competidores con Playwright respetando robots.txt y rate limit');
  const studio = core.product_studio;
  const db = studio.active_playbooks.find((playbook) => playbook.id === 'database-connector-layer');
  const web = studio.active_playbooks.find((playbook) => playbook.id === 'web-automation-scraping-layer');

  assert.ok(db.validation_checks.includes('prepared_statements_only'));
  assert.ok(db.validation_checks.includes('writes_require_confirmation'));
  assert.ok(db.evidence_required.includes('prepared_statement_plan'));
  assert.ok(web.validation_checks.includes('no_captcha_paywall_bypass'));
  assert.ok(web.evidence_required.includes('robots_txt_result'));
  assert.equal(studio.production_controls.read_only_database_default, true);
  assert.equal(studio.production_controls.compliant_web_collection_only, true);
});

test('AI Product Studio blueprint requires evidence ledgers for market BI and research', () => {
  const { core } = coreFor('Investiga mercado con fuentes reales, calcula TAM SAM SOM, Porter, cohortes y crea un dashboard Power BI exportable');
  const studio = core.product_studio;
  const research = studio.active_playbooks.find((playbook) => playbook.id === 'research-market-intelligence-engine');
  const bi = studio.active_playbooks.find((playbook) => playbook.id === 'business-intelligence-studio');

  assert.ok(research.evidence_required.includes('source_url_or_doi'));
  assert.ok(research.validation_checks.includes('no_fabricated_doi'));
  assert.ok(bi.deliverables.includes('star_schema'));
  assert.ok(bi.validation_checks.includes('kpis_have_formula'));
  assert.equal(studio.evidence_contract.provenance_required, true);
  assert.equal(studio.release_contract.block_on_unverified_sources, true);
});

test('AI Product Studio prompt exposes playbooks without allowing invented tools', () => {
  const { core } = coreFor('Construye un SaaS con base de datos, scraping permitido, dashboard BI, diseño UI y seguridad ASVS');
  const prompt = buildAgenticOperatingPrompt(core);

  assert.match(prompt, /AI Product Studio work/);
  assert.match(prompt, /declared_tools_only/);
  assert.match(prompt, /ProjectScaffolder/);
  assert.match(prompt, /SqlSafetyGuard/);
  assert.match(prompt, /RobotsPolicyGuard/);
  assert.match(prompt, /release_contract/);
  assert.equal(core.product_studio.tool_runtime_contract.declared_tools_only, true);
  assert.equal(core.product_studio.quality_system.self_repair.required, true);
});
