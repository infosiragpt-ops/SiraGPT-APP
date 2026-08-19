const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUniversalTaskContract,
} = require('../src/services/agents/universal-task-contract');
const {
  ENTERPRISE_TOOL_MANIFESTS,
  buildEnterpriseExecutionGraph,
  buildEnterpriseExecutionPrompt,
  buildEnterpriseRuntimeProfile,
  inferEnterpriseCapabilities,
  listEnterpriseToolManifests,
  validateEnterpriseExecutionGraph,
  validateEnterpriseToolManifest,
} = require('../src/services/agents/enterprise-agentic-runtime');

test('enterprise runtime compiles every contract into a durable ExecutionGraph', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Crea una web SaaS profesional en Next.js con dashboard, autenticación, roles, tests y CI',
  });
  const graph = buildEnterpriseExecutionGraph({
    contract,
    taskId: 'task-web-1',
    userId: 'user-a',
    chatId: 'chat-a',
  });

  assert.equal(validateEnterpriseExecutionGraph(graph).ok, true);
  assert.equal(graph.durable_execution.enabled, true);
  assert.match(graph.idempotency_key, /^idem_/);
  assert.ok(graph.nodes.some((node) => node.layer === 'SoftwareEngineeringPipeline'));
  assert.ok(graph.nodes.some((node) => node.layer === 'FullStackWebBuilder'));
  assert.ok(graph.nodes.some((node) => node.id === 'validation_fabric'));
  assert.ok(graph.nodes.some((node) => node.id === 'release_controller'));
  assert.ok(graph.gates.release_gate.includes('ReleaseController approved'));
});

test('enterprise graph maps database and scraping requests to governed layers', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Conecta a una base de datos Postgres, revisa tablas con SQL parametrizado y scrapea precios publicos de competidores respetando robots.txt',
  });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-data-1' });

  const layers = new Set(graph.architecture_layers);
  assert.equal(layers.has('DatabaseConnectorLayer'), true);
  assert.equal(layers.has('WebAutomationScrapingLayer'), true);
  assert.ok(graph.nodes.some((node) => node.validation_gate.deterministic_checks.includes('prepared_statements_only')));
  assert.ok(graph.nodes.some((node) => node.validation_gate.deterministic_checks.includes('no_captcha_paywall_bypass')));
});

test('enterprise tool manifests expose permissions, side effects, confirmation and audit policy', () => {
  for (const manifest of Object.values(ENTERPRISE_TOOL_MANIFESTS)) {
    const result = validateEnterpriseToolManifest(manifest);
    assert.equal(result.ok, true, `${manifest.name}: ${JSON.stringify(result.errors)}`);
    assert.ok(Array.isArray(manifest.permissions));
    assert.ok(['none', 'read', 'compute', 'write', 'external'].includes(manifest.side_effect_level));
    assert.equal(typeof manifest.requires_confirmation, 'boolean');
    assert.equal(typeof manifest.sandbox_required, 'boolean');
    assert.ok(manifest.audit_policy.redact_fields.includes('secret'));
  }

  assert.equal(ENTERPRISE_TOOL_MANIFESTS.database_write.requires_confirmation, true);
  assert.equal(ENTERPRISE_TOOL_MANIFESTS.browser_automation.requires_confirmation, true);
  assert.equal(ENTERPRISE_TOOL_MANIFESTS.deploy_release.requires_confirmation, true);
});

test('multi-intent contracts create child execution nodes before release', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Busca 40 artículos reales con DOI, entrégalos en Excel y luego redacta el método en Word',
  });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-multi-1' });

  assert.equal(contract.multi_intent_dag.enabled, true);
  assert.ok(graph.nodes.some((node) => node.id === 'contract_child_1'));
  assert.ok(graph.nodes.some((node) => node.id === 'contract_child_2'));
  assert.ok(graph.edges.some((edge) => edge.to === 'release_controller'));
});

test('runtime prompt forces graph execution and policy restrictions', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Programa una API Node con tests y revisa seguridad',
  });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-code-1' });
  const prompt = buildEnterpriseExecutionPrompt(graph);
  const profile = buildEnterpriseRuntimeProfile(contract, graph);

  assert.match(prompt, /ENTERPRISE EXECUTION GRAPH/);
  assert.match(prompt, /Do not skip validation_fabric/);
  assert.match(prompt, /For code, run tests\/build\/security review/);
  assert.ok(profile.capabilities.includes('SoftwareEngineeringPipeline'));
  assert.ok(listEnterpriseToolManifests().some((tool) => tool.name === 'security_scan'));
});

test('enterprise capability inference includes BI, design and document intelligence', () => {
  const contract = buildUniversalTaskContract({
    rawUserRequest: 'Haz un dashboard estilo Power BI con KPIs, DAX, análisis de mercado y una presentación visual',
  });
  const caps = inferEnterpriseCapabilities(contract);

  assert.ok(caps.includes('BusinessIntelligenceStudio'));
  assert.ok(caps.includes('ResearchMarketIntelligenceEngine'));
  assert.ok(caps.includes('DesignSystemGenerator'));
  assert.ok(caps.includes('DocumentIntelligenceEngine'));
});
