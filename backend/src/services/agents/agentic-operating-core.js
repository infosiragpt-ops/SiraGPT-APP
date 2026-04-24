/**
 * agentic-operating-core
 *
 * Enterprise operating envelope for every UniversalTaskContract.
 * This module does not execute tools. It compiles the already validated
 * contract, ExecutionGraph, Tool Runtime plan and QA Board review into
 * one deterministic control plane used by prompts, task metadata and
 * observability.
 *
 * The goal is to make the chat behave as an AI Product Studio:
 * understand -> contract -> DAG -> typed tools -> validation -> repair
 * -> release, with honest support boundaries and no untyped actions.
 */

const crypto = require('crypto');

const {
  ENTERPRISE_LAYERS,
  inferEnterpriseCapabilities,
} = require('./enterprise-agentic-runtime');
const { buildToolGatewayCatalog } = require('./enterprise-tool-gateway');
const {
  buildAiProductOperatingSystem,
  buildAiProductOperatingPrompt,
} = require('./ai-product-os');

const OPERATING_CORE_VERSION = 'agentic-operating-core-2026-04';

const ENTERPRISE_DOMAINS = Object.freeze({
  agenticOperatingCore: {
    id: 'agentic-operating-core',
    layer: 'AgenticOperatingCore',
    purpose: 'Compile intent into contract, execution graph, gates and release rules.',
    requiredReports: ['ValidationReport'],
    acceptanceGates: ['contract_validated', 'ambiguity_resolved_or_asked_once', 'format_sovereignty_enforced'],
    blockers: ['invalid_contract', 'ambiguous_high_risk_request'],
  },
  workflowOrchestrator: {
    id: 'workflow-orchestrator',
    layer: 'WorkflowOrchestrator',
    purpose: 'Run durable DAG planning with checkpoints, retries, rollback and resume policy.',
    requiredReports: ['ValidationReport', 'PerformanceReport'],
    acceptanceGates: ['dag_is_acyclic', 'all_dependencies_declared', 'checkpoint_policy_present'],
    blockers: ['cyclic_graph', 'missing_dependency', 'durable_store_unavailable'],
  },
  toolRuntime: {
    id: 'tool-runtime',
    layer: 'ToolRuntime',
    purpose: 'Authorize every tool through a strict ToolManifest before execution.',
    requiredReports: ['SecurityReport', 'ValidationReport'],
    acceptanceGates: ['tool_declared', 'permission_scope_checked', 'side_effect_policy_applied'],
    blockers: ['undeclared_tool', 'forbidden_tool', 'missing_confirmation'],
  },
  codeExecutionSandbox: {
    id: 'code-execution-sandbox',
    layer: 'CodeExecutionSandbox',
    purpose: 'Execute code only in an isolated sandbox with timeout and stripped environment.',
    requiredReports: ['SecurityReport', 'CodeReview', 'PerformanceReport'],
    acceptanceGates: ['sandbox_required', 'timeout_policy_present', 'tests_executed'],
    blockers: ['unsafe_exec', 'timeout_without_checkpoint', 'test_failure_unrepaired'],
  },
  softwareEngineering: {
    id: 'software-engineering-pipeline',
    layer: 'SoftwareEngineeringPipeline',
    purpose: 'Plan architecture, scaffold code, analyze AST, generate tests, build, review and prepare Git/deployment actions.',
    requiredReports: ['CodeReview', 'SecurityReport', 'PerformanceReport'],
    acceptanceGates: ['architecture_plan_present', 'tests_or_build_executed', 'secrets_absent', 'release_diff_scoped'],
    blockers: ['build_failed', 'secret_detected', 'destructive_git_operation'],
  },
  fullStackWebBuilder: {
    id: 'full-stack-web-builder',
    layer: 'FullStackWebBuilder',
    purpose: 'Build production web apps with routing, responsive UI, SEO, accessibility, auth, analytics and tests.',
    requiredReports: ['DesignReview', 'CodeReview', 'PerformanceReport', 'SecurityReport'],
    acceptanceGates: ['responsive_breakpoints_checked', 'seo_metadata_present', 'wcag_gate_present', 'build_executed'],
    blockers: ['accessibility_blocker', 'next_build_failed', 'unvalidated_form_or_auth_flow'],
  },
  databaseConnector: {
    id: 'database-connector-layer',
    layer: 'DatabaseConnectorLayer',
    purpose: 'Introspect schemas and run read-only parameterized SQL by default with query budgets.',
    requiredReports: ['SecurityReport', 'ValidationReport'],
    acceptanceGates: ['read_only_default', 'prepared_statements_only', 'query_budget_declared', 'writes_require_confirmation'],
    blockers: ['sql_injection_risk', 'mutation_without_confirmation', 'slow_query_without_budget'],
  },
  webAutomation: {
    id: 'web-automation-scraping-layer',
    layer: 'WebAutomationScrapingLayer',
    purpose: 'Collect public web data with robots.txt, rate limits, canonical URLs, snapshots and provenance.',
    requiredReports: ['SecurityReport', 'FactualityReport'],
    acceptanceGates: ['robots_txt_respected', 'transparent_user_agent', 'rate_limit_present', 'provenance_recorded'],
    blockers: ['auth_bypass_requested', 'captcha_or_paywall_bypass', 'robots_disallowed'],
  },
  documentIntelligence: {
    id: 'document-intelligence-engine',
    layer: 'DocumentIntelligenceEngine',
    purpose: 'Parse PDF/DOCX/XLSX/PPT with structure, tables, figures, OCR policy and page-level provenance.',
    requiredReports: ['ValidationReport', 'FactualityReport'],
    acceptanceGates: ['file_ownership_verified', 'layout_or_structural_chunks', 'evidence_ledger_present'],
    blockers: ['unsupported_file_unlabeled', 'missing_provenance', 'cross_user_file_access'],
  },
  researchMarket: {
    id: 'research-market-intelligence-engine',
    layer: 'ResearchMarketIntelligenceEngine',
    purpose: 'Run grounded scientific, academic or market research with source verification and evidence ledger.',
    requiredReports: ['FactualityReport', 'ValidationReport'],
    acceptanceGates: ['real_sources_verified', 'source_gaps_labeled', 'citation_rules_applied', 'no_fabricated_doi'],
    blockers: ['fabricated_source', 'missing_required_evidence', 'unverified_current_claim'],
  },
  businessIntelligence: {
    id: 'business-intelligence-studio',
    layer: 'BusinessIntelligenceStudio',
    purpose: 'Create semantic models, star schemas, KPI definitions, dashboards and export-ready BI artifacts.',
    requiredReports: ['ValidationReport', 'FactualityReport', 'DesignReview'],
    acceptanceGates: ['facts_dimensions_defined', 'kpis_have_formula', 'dataset_validated', 'exports_validated'],
    blockers: ['invented_market_number', 'undefined_metric', 'invalid_dataset'],
  },
  designIntelligence: {
    id: 'design-intelligence-layer',
    layer: 'DesignSystemGenerator',
    purpose: 'Generate design tokens, components, visual systems, UI kits and accessibility-reviewed layouts.',
    requiredReports: ['DesignReview', 'ValidationReport'],
    acceptanceGates: ['contrast_reviewed', 'visual_hierarchy_checked', 'responsive_breakpoints_checked'],
    blockers: ['contrast_failed', 'layout_overflow', 'brand_inconsistency_unresolved'],
  },
  securityGovernance: {
    id: 'security-governance-layer',
    layer: 'SecurityGovernanceLayer',
    purpose: 'Apply OWASP ASVS, secret scanning, permission policy, injection controls and audit rules.',
    requiredReports: ['SecurityReport'],
    acceptanceGates: ['owasp_asvs_hooks_present', 'secret_scan_executed', 'input_validation_declared'],
    blockers: ['critical_vulnerability', 'secret_detected', 'unsafe_path_or_injection'],
  },
  validationFabric: {
    id: 'validation-fabric',
    layer: 'ValidationFabric',
    purpose: 'Aggregate deterministic reports and block release until required gates pass.',
    requiredReports: ['ValidationReport', 'SecurityReport', 'FactualityReport', 'DesignReview', 'CodeReview', 'PerformanceReport'],
    acceptanceGates: ['release_decision_present', 'failed_gate_blocks_release', 'repair_plan_exists'],
    blockers: ['failed_validation_delivered', 'missing_release_decision'],
  },
  observabilityPlane: {
    id: 'observability-plane',
    layer: 'ObservabilityPlane',
    purpose: 'Emit request, contract, tool, validation, repair and release events with trace identifiers.',
    requiredReports: ['PerformanceReport'],
    acceptanceGates: ['trace_id_present', 'critical_events_declared', 'cost_latency_budget_recorded'],
    blockers: ['untraceable_execution', 'missing_audit_event_for_side_effect'],
  },
  hitlControlCenter: {
    id: 'human-in-the-loop-control-center',
    layer: 'HumanInTheLoopControlCenter',
    purpose: 'Pause and request confirmation for external, write, deployment or high-risk actions.',
    requiredReports: ['ValidationReport', 'SecurityReport'],
    acceptanceGates: ['confirmation_required_for_side_effects', 'approval_state_recorded', 'one_question_clarification'],
    blockers: ['side_effect_without_confirmation', 'ambiguous_external_action'],
  },
});

const DOMAIN_BY_LAYER = Object.freeze(Object.fromEntries(
  Object.values(ENTERPRISE_DOMAINS).map((domain) => [domain.layer, domain])
));

function buildAgenticOperatingCore({
  contract,
  graph,
  toolRuntimePlan,
  qaBoardReview,
  componentRegistry = null,
  now = new Date(),
} = {}) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('agentic-operating-core: contract is required');
  }
  if (!graph || typeof graph !== 'object') {
    throw new Error('agentic-operating-core: graph is required');
  }

  const traceId = makeTraceId(contract, graph);
  const domains = inferOperatingDomains({ contract, graph });
  const toolGovernance = buildToolGovernance({ toolRuntimePlan });
  const workflow = buildWorkflowPlan({ contract, graph, domains });
  const validation = buildValidationPlan({ contract, graph, qaBoardReview, domains });
  const selfRepair = buildSelfRepairPolicy({ contract, qaBoardReview });
  const release = buildReleasePolicy({ contract, graph, toolRuntimePlan, qaBoardReview, domains });
  const observability = buildObservabilityPlan({ graph, traceId, domains });
  const regression = buildRegressionPlan({ contract, domains });
  const riskRegister = buildRiskRegister({ contract, graph, toolRuntimePlan, qaBoardReview, domains });
  const productStudio = buildProductStudioBlueprint({
    contract,
    graph,
    domains,
    toolGovernance,
    validation,
    selfRepair,
    release,
    observability,
    regression,
  });
  const aiProductOS = buildAiProductOperatingSystem({
    contract,
    graph,
    toolRuntimePlan,
    qaBoardReview,
    now,
  });

  const core = {
    version: OPERATING_CORE_VERSION,
    trace_id: traceId,
    core_id: `aoc_${fingerprint({ contract, graphId: graph.graph_id, domains: domains.map((d) => d.id) })}`,
    created_at: now.toISOString(),
    pipeline: contract.pipeline || null,
    primary_intent: contract.primary_intent || null,
    required_extension: contract.required_extension || null,
    mime_type: contract.mime_type || null,
    risk_level: contract.risk_level || 'medium',
    quality_bar: contract.quality_bar || 'professional',
    durable_execution: {
      enabled: graph.durable_execution?.enabled !== false,
      graph_id: graph.graph_id,
      idempotency_key: graph.idempotency_key,
      state_store: graph.durable_execution?.state_store || 'file-backed-json',
      checkpoint_policy: graph.durable_execution?.checkpoint_policy || 'checkpoint each node boundary and final release',
      resume_strategy: graph.durable_execution?.resume_strategy || 'resume from last succeeded checkpoint',
      replay_policy: graph.durable_execution?.replay_policy || 'replay failed or repairable nodes only',
    },
    domains,
    workflow,
    tool_governance: toolGovernance,
    validation,
    self_repair: selfRepair,
    release,
    observability,
    regression,
    product_studio: productStudio,
    ai_product_os: aiProductOS,
    risk_register: riskRegister,
    component_inventory: summarizeComponentRegistry(componentRegistry, domains),
    summary: {
      domainCount: domains.length,
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
      authorizedToolCount: toolRuntimePlan?.summary?.authorizedToolCount || 0,
      blockerCount: countBlockers(toolRuntimePlan, qaBoardReview, riskRegister),
      warningCount: (toolRuntimePlan?.summary?.warningCount || 0) + (qaBoardReview?.summary?.warningCount || 0),
      requiresHumanConfirmation: Boolean(
        graph.human_in_the_loop?.required
        || toolRuntimePlan?.summary?.requiresHumanConfirmation
        || release.requires_human_confirmation
      ),
      releaseDecision: qaBoardReview?.summary?.decision || 'pending',
      supportedByManifestGateway: toolRuntimePlan ? toolRuntimePlan.ok !== false : false,
    },
  };

  const validationResult = validateAgenticOperatingCore(core);
  if (!validationResult.ok) {
    throw new Error(`agentic-operating-core: invalid core: ${validationResult.errors.join('; ')}`);
  }

  return core;
}

function inferOperatingDomains({ contract, graph }) {
  const layers = new Set([
    'AgenticOperatingCore',
    'WorkflowOrchestrator',
    'ToolRuntime',
    ...(Array.isArray(graph?.architecture_layers) ? graph.architecture_layers : []),
    ...inferEnterpriseCapabilities(contract || {}),
    'SecurityGovernanceLayer',
    'ValidationFabric',
    'ObservabilityPlane',
    'HumanInTheLoopControlCenter',
  ]);

  const domains = [];
  for (const layer of ENTERPRISE_LAYERS) {
    if (!layers.has(layer)) continue;
    const domain = DOMAIN_BY_LAYER[layer];
    if (!domain) continue;
    domains.push({
      ...domain,
      active: true,
      implemented_by_graph: (graph?.architecture_layers || []).includes(layer),
      node_ids: (graph?.nodes || [])
        .filter((node) => node.layer === layer)
        .map((node) => node.id),
    });
  }

  if ((contract?.pipeline === 'CodePipeline' || contract?.primary_intent === 'code_generation')
    && !domains.some((domain) => domain.id === 'code-execution-sandbox')) {
    domains.splice(Math.min(3, domains.length), 0, {
      ...ENTERPRISE_DOMAINS.codeExecutionSandbox,
      active: true,
      implemented_by_graph: false,
      node_ids: [],
    });
  }

  return domains;
}

function buildToolGovernance({ toolRuntimePlan }) {
  const catalog = buildToolGatewayCatalog();
  return {
    catalog_version: catalog.version,
    registered_tool_count: Object.keys(catalog.tools).length,
    catalog_ok: catalog.ok,
    authorized_tools: toolRuntimePlan?.authorization?.authorizedTools || [],
    blockers: toolRuntimePlan?.authorization?.blockers || [],
    warnings: toolRuntimePlan?.authorization?.warnings || [],
    side_effect_summary: toolRuntimePlan?.summary?.sideEffectSummary || {},
    policy: [
      'No unregistered tools.',
      'No forbidden tools.',
      'No external or write side effects without release gate and confirmation when required.',
      'Format-producing tools must satisfy Format Sovereignty.',
      'Sandbox-required tools run only through isolated runtimes.',
    ],
  };
}

function buildWorkflowPlan({ contract, graph, domains }) {
  const nodeIds = (graph.nodes || []).map((node) => node.id);
  return {
    graph_id: graph.graph_id,
    dag_required: true,
    node_order: nodeIds,
    phases: [
      'request_received',
      'contract_created',
      'contract_validated',
      'execution_graph_created',
      'tool_selected',
      'artifact_or_action_generated',
      'validation_gate_checked',
      'self_repair_if_needed',
      'release_gate_checked',
      'final_delivery_approved',
    ],
    budgets: {
      cost_budget: graph.cost_budget || null,
      latency_budget: graph.latency_budget || null,
      domain_count: domains.length,
    },
    multi_intent: {
      enabled: Boolean(contract.multi_intent_dag?.enabled),
      child_count: contract.multi_intent_dag?.nodes?.length || 0,
      rule: 'child contracts must complete and validate before downstream release',
    },
  };
}

function buildValidationPlan({ contract, graph, qaBoardReview, domains }) {
  const reportSet = new Set(graph.qa_board?.reports_required || []);
  for (const domain of domains) for (const report of domain.requiredReports || []) reportSet.add(report);
  const deterministicChecks = new Set(graph.gates?.validation_gate || []);
  for (const node of graph.nodes || []) {
    for (const check of node.validation_gate?.deterministic_checks || []) deterministicChecks.add(check);
  }
  if (contract.required_extension) deterministicChecks.add(`format:${contract.required_extension}`);
  if (contract.grounding_required || contract.source_requirements?.required) deterministicChecks.add('evidence_ledger_present');

  return {
    reports_required: Array.from(reportSet),
    deterministic_checks: Array.from(deterministicChecks),
    qa_board_decision: qaBoardReview?.summary?.decision || 'pending',
    qa_board_blockers: qaBoardReview?.summary?.blockerCount || 0,
    rule: 'If any required report has a high or critical blocker, block release and enter self-repair.',
  };
}

function buildSelfRepairPolicy({ contract, qaBoardReview }) {
  const maxAttempts = contract?.risk_level === 'critical' ? 1 : 3;
  return {
    required: true,
    max_attempts: maxAttempts,
    triggers: [
      'format_validation_failed',
      'semantic_validation_failed',
      'security_blocker_found',
      'build_or_test_failed',
      'missing_grounding_or_source_gap',
      'tool_runtime_blocked',
    ],
    failure_report_schema: {
      required_fields: [
        'failed_stage',
        'expected_output',
        'actual_output',
        'root_cause',
        'repair_strategy',
        'retry_count',
        'tests_reexecuted',
        'release_decision',
      ],
    },
    current_failure_reports: qaBoardReview?.summary?.failureReportCount || 0,
    release_rule: 'Never deliver a failed artifact as successful; repair or disclose exact blocker.',
  };
}

function buildReleasePolicy({ contract, graph, toolRuntimePlan, qaBoardReview, domains }) {
  const sideEffects = toolRuntimePlan?.summary?.sideEffectSummary || {};
  const requiresHumanConfirmation = Boolean(
    graph.human_in_the_loop?.required
    || sideEffects.write > 0
    || sideEffects.external > 0
    || contract.pipeline === 'ActionExecutionPipeline'
    || contract.risk_level === 'critical'
  );
  return {
    release_controller_required: true,
    requires_human_confirmation: requiresHumanConfirmation,
    block_on_failed_validation: true,
    block_on_unverified_sources: Boolean(contract.grounding_required || contract.source_requirements?.required),
    block_on_format_mismatch: Boolean(contract.required_extension),
    final_delivery_rules: contract.final_delivery_rules || [],
    release_decision: qaBoardReview?.summary?.decision || 'pending',
    domain_vetoes: domains.map((domain) => ({
      domain: domain.id,
      veto_if_any: domain.blockers,
    })),
  };
}

function buildObservabilityPlan({ graph, traceId, domains }) {
  const baseEvents = [
    'request_received',
    'contract_created',
    'contract_validated',
    'execution_graph_created',
    'tool_selected',
    'artifact_generated',
    'format_validation_passed',
    'semantic_validation_failed',
    'self_repair_started',
    'final_delivery_approved',
  ];
  return {
    trace_id: traceId,
    graph_id: graph.graph_id,
    events: Array.from(new Set([...(graph.observability?.events || []), ...baseEvents])),
    metrics: Array.from(new Set([
      ...(graph.observability?.metrics || []),
      'tool_error_rate',
      'self_repair_rate',
      'format_confusion_rate',
      'source_grounding_gap_rate',
      'cost_per_task',
      'latency_by_stage',
    ])),
    spans: domains.map((domain) => `agentic.${domain.id}`),
    trace_policy: graph.observability?.trace_policy || 'redact secrets and retain task-level spans for audit',
  };
}

function buildRegressionPlan({ contract, domains }) {
  const tests = new Set(['contract_schema', 'format_sovereignty', 'release_decision']);
  if (contract.required_extension) tests.add(`artifact_${contract.required_extension.replace('.', '')}_validation`);
  if (domains.some((domain) => domain.id === 'software-engineering-pipeline')) {
    tests.add('lint_typecheck_tests_build');
    tests.add('secret_scan');
  }
  if (domains.some((domain) => domain.id === 'web-automation-scraping-layer')) {
    tests.add('robots_rate_limit_no_bypass');
  }
  if (domains.some((domain) => domain.id === 'database-connector-layer')) {
    tests.add('read_only_sql_prepared_statements');
  }
  if (domains.some((domain) => domain.id === 'research-market-intelligence-engine')) {
    tests.add('evidence_ledger_real_sources');
  }
  return {
    required: true,
    generated_acceptance_tests: Array.from(tests),
    deployment_rule: 'No deploy or final claim if regression coverage for the active domains fails.',
  };
}

function buildRiskRegister({ contract, graph, toolRuntimePlan, qaBoardReview, domains }) {
  const risks = [];
  if (contract.risk_level === 'critical' || contract.risk_level === 'high') {
    risks.push({ severity: contract.risk_level, code: 'high_risk_contract', mitigation: 'release gate + reduced retry count + HITL when side effects exist' });
  }
  if (toolRuntimePlan?.summary?.blockerCount > 0) {
    risks.push({ severity: 'high', code: 'tool_runtime_blockers', mitigation: 'repair manifest/tool selection before execution' });
  }
  if (qaBoardReview?.summary?.blockerCount > 0) {
    risks.push({ severity: 'high', code: 'qa_board_blockers', mitigation: 'self-repair before release' });
  }
  if (domains.some((domain) => domain.id === 'web-automation-scraping-layer')) {
    risks.push({ severity: 'medium', code: 'web_compliance', mitigation: 'robots.txt, rate limits, no auth/CAPTCHA/paywall bypass' });
  }
  if (domains.some((domain) => domain.id === 'database-connector-layer')) {
    risks.push({ severity: 'medium', code: 'database_mutation', mitigation: 'read-only default and confirmation for writes' });
  }
  if ((graph.nodes || []).some((node) => node.release_gate?.requires_human_confirmation)) {
    risks.push({ severity: 'medium', code: 'human_confirmation_required', mitigation: 'pause at release gate until approved' });
  }
  return risks;
}

function buildProductStudioBlueprint({
  contract,
  graph,
  domains,
  toolGovernance,
  validation,
  selfRepair,
  release,
  observability,
  regression,
}) {
  const activePlaybooks = domains.map((domain) => buildDomainPlaybook({ domain, contract, graph }));
  const reportSet = new Set(validation.reports_required || []);
  for (const playbook of activePlaybooks) {
    for (const report of playbook.required_reports || []) reportSet.add(report);
  }

  return {
    version: 'ai-product-studio-blueprint-2026-04',
    mission: 'Plan, execute, validate, audit, repair and release digital products strictly from the UniversalTaskContract.',
    execution_model: {
      contract_first: true,
      dag_runtime: true,
      durable_execution: true,
      idempotency_key: graph.idempotency_key || null,
      checkpoint_policy: graph.durable_execution?.checkpoint_policy || null,
      resume_strategy: graph.durable_execution?.resume_strategy || null,
      replay_policy: graph.durable_execution?.replay_policy || null,
      release_gate: graph.gates?.release_gate || [],
    },
    operating_layers: [
      'Agentic Operating Core',
      'Workflow Orchestrator',
      'Tool Runtime',
      'Validation Fabric',
      'Security Governance Layer',
      'Observability Plane',
      'Human-in-the-Loop Control Center',
    ],
    active_playbooks: activePlaybooks,
    tool_runtime_contract: {
      gateway_version: toolGovernance.catalog_version,
      declared_tools_only: true,
      registered_tool_count: toolGovernance.registered_tool_count,
      authorized_tools: toolGovernance.authorized_tools,
      blocked_tools: toolGovernance.blockers,
      side_effect_summary: toolGovernance.side_effect_summary,
      manifest_requirements: [
        'JSON Schema inputs and outputs',
        'permissions and OAuth/OIDC scopes',
        'preconditions and postconditions',
        'expected errors and recovery policy',
        'side_effect_level and requires_confirmation',
        'sandbox_required and audit_policy',
      ],
    },
    evidence_contract: buildEvidenceContract({ contract, activePlaybooks, reportSet }),
    quality_system: {
      reports_required: Array.from(reportSet),
      deterministic_checks: validation.deterministic_checks,
      minimum_release_rule: 'ReleaseController can approve only when all required reports exist and no blocker remains.',
      self_repair: {
        required: selfRepair.required,
        max_attempts: selfRepair.max_attempts,
        failure_report_schema: selfRepair.failure_report_schema,
        tests_reexecuted_required: true,
      },
      regression: regression.generated_acceptance_tests,
    },
    production_controls: {
      clean_architecture_required: activePlaybooks.some((p) => p.id === 'software-engineering-pipeline' || p.id === 'full-stack-web-builder'),
      read_only_database_default: activePlaybooks.some((p) => p.id === 'database-connector-layer'),
      compliant_web_collection_only: activePlaybooks.some((p) => p.id === 'web-automation-scraping-layer'),
      source_grounding_required: release.block_on_unverified_sources,
      human_confirmation_required: release.requires_human_confirmation,
      no_destructive_git_without_confirmation: true,
      no_secret_or_sensitive_data_logging: true,
      no_false_success_claims: true,
    },
    observability_contract: {
      trace_id: observability.trace_id,
      events: observability.events,
      metrics: observability.metrics,
      replayable: true,
      pii_redaction_required: true,
    },
    release_contract: {
      release_controller_required: release.release_controller_required,
      block_on_failed_validation: release.block_on_failed_validation,
      block_on_format_mismatch: release.block_on_format_mismatch,
      block_on_unverified_sources: release.block_on_unverified_sources,
      requires_human_confirmation: release.requires_human_confirmation,
      final_delivery_rules: release.final_delivery_rules,
    },
  };
}

function buildDomainPlaybook({ domain, contract, graph }) {
  const base = {
    id: domain.id,
    layer: domain.layer,
    purpose: domain.purpose,
    node_ids: domain.node_ids || [],
    required_reports: domain.requiredReports || ['ValidationReport'],
    acceptance_gates: domain.acceptanceGates || [],
    veto_blockers: domain.blockers || [],
    graph_tools: toolsForDomain(domain, graph),
  };

  const playbook = DOMAIN_PLAYBOOKS[domain.id];
  if (!playbook) {
    return {
      ...base,
      agents: ['PlannerAgent', 'ArtifactBuilder', 'SemanticReviewer', 'ReleaseController'],
      deliverables: ['validated_capability_output'],
      evidence_required: ['execution_trace', 'validation_report', 'release_decision'],
      validation_checks: ['contract_alignment', 'no_false_success_claim'],
      rollback_strategy: 'discard output, replay from checkpoint and rerun validation',
    };
  }

  const contextualChecks = [];
  if (contract.required_extension) contextualChecks.push(`format:${contract.required_extension}`);
  if (contract.grounding_required || contract.source_requirements?.required) contextualChecks.push('evidence_ledger_present');

  return {
    ...base,
    ...playbook,
    validation_checks: Array.from(new Set([...(playbook.validation_checks || []), ...contextualChecks])),
  };
}

const DOMAIN_PLAYBOOKS = Object.freeze({
  'agentic-operating-core': {
    agents: ['IntentAnalyst', 'ConstraintExtractor', 'AmbiguityJudge', 'PlannerAgent', 'ReleaseController'],
    deliverables: ['UniversalTaskContract', 'ExecutionGraph', 'release_policy'],
    evidence_required: ['contract_schema_validation', 'ambiguity_score', 'format_sovereignty_decision'],
    validation_checks: ['contract_validated', 'ambiguity_resolved_or_asked_once', 'format_sovereignty_enforced'],
    rollback_strategy: 'rebuild contract from raw request and block downstream nodes until schema validates',
  },
  'workflow-orchestrator': {
    agents: ['WorkflowOrchestrator', 'PlannerAgent', 'RetryCoordinator', 'CheckpointManager'],
    deliverables: ['durable_execution_graph', 'checkpoint_ledger', 'resume_plan'],
    evidence_required: ['dag_acyclic_check', 'node_dependency_map', 'checkpoint_policy', 'idempotency_key'],
    validation_checks: ['dag_is_acyclic', 'all_dependencies_declared', 'checkpoint_policy_present'],
    rollback_strategy: 'resume from last succeeded checkpoint; write/external nodes require approval before replay',
  },
  'tool-runtime': {
    agents: ['ToolRouter', 'MCPGateway', 'PermissionGuard', 'AuditLogger'],
    deliverables: ['authorized_tool_manifest_set', 'tool_audit_policy'],
    evidence_required: ['manifest_validation', 'permission_scope_check', 'side_effect_summary'],
    validation_checks: ['tool_declared', 'permission_scope_checked', 'side_effect_policy_applied'],
    rollback_strategy: 'block undeclared tool and re-plan with an authorized manifest',
  },
  'code-execution-sandbox': {
    agents: ['SandboxRunner', 'TimeoutGuard', 'TestRunner', 'SecurityScanner'],
    deliverables: ['sandbox_execution_result', 'test_output', 'security_scan_summary'],
    evidence_required: ['isolated_runtime', 'timeout_policy', 'stripped_environment', 'test_log'],
    validation_checks: ['sandbox_required', 'timeout_policy_present', 'tests_executed', 'secrets_absent'],
    rollback_strategy: 'kill sandbox process, discard temp directory and replay from clean workspace',
  },
  'software-engineering-pipeline': {
    agents: [
      'ProjectScaffolder',
      'ArchitecturePlanner',
      'CodeGenerator',
      'ASTAnalyzer',
      'DependencyResolver',
      'TestGenerator',
      'BuildRunner',
      'SecurityScanner',
      'RefactorAgent',
      'CodeReviewer',
      'GitAgent',
      'DeploymentAgent',
    ],
    deliverables: ['project_file_tree', 'architecture_notes', 'tests', 'build_log', 'security_report', 'code_review'],
    evidence_required: ['diff_scope', 'lint_or_typecheck_log', 'unit_or_integration_test_log', 'build_log', 'secret_scan_result'],
    validation_checks: ['architecture_plan_present', 'tests_or_build_executed', 'secret_scan_executed', 'release_diff_scoped'],
    rollback_strategy: 'do not revert user work; repair only owned files and preserve unrelated dirty changes',
  },
  'full-stack-web-builder': {
    agents: ['ProductArchitect', 'FrontendBuilder', 'BackendBuilder', 'A11yReviewer', 'SeoReviewer', 'PerformanceReviewer'],
    deliverables: ['web_app_artifact', 'api_contracts', 'responsive_layout_report', 'seo_metadata', 'e2e_test_log'],
    evidence_required: ['route_manifest', 'form_validation_policy', 'wcag_review', 'core_web_vitals_budget', 'cross_browser_plan'],
    validation_checks: ['responsive_breakpoints_checked', 'seo_metadata_present', 'wcag_gate_present', 'build_executed'],
    rollback_strategy: 'rollback generated web artifact to last passing build and rerun app route checks',
  },
  'database-connector-layer': {
    agents: ['DatabaseIntrospector', 'SqlSafetyGuard', 'QueryPlanner', 'DataGovernanceReviewer'],
    deliverables: ['schema_introspection', 'parameterized_query_plan', 'query_audit', 'data_masking_policy'],
    evidence_required: ['read_only_default', 'prepared_statement_plan', 'query_budget', 'explain_plan_when_available'],
    validation_checks: ['prepared_statements_only', 'read_only_default', 'writes_require_confirmation', 'sql_injection_scan'],
    rollback_strategy: 'reject mutations by default; require explicit confirmation and transaction rollback reference for writes',
  },
  'web-automation-scraping-layer': {
    agents: ['CrawlerPlanner', 'RobotsPolicyGuard', 'PlaywrightExtractor', 'DataNormalizer', 'ComplianceReviewer'],
    deliverables: ['crawl_plan', 'dom_snapshot_policy', 'structured_extracts', 'provenance_ledger'],
    evidence_required: ['robots_txt_result', 'rate_limit_policy', 'transparent_user_agent', 'canonical_url_map', 'html_snapshot_reference'],
    validation_checks: ['robots_txt_respected', 'rate_limit_present', 'no_captcha_paywall_bypass', 'provenance_recorded'],
    rollback_strategy: 'stop crawler on policy denial, persist FailureReport and do not bypass site controls',
  },
  'document-intelligence-engine': {
    agents: ['DocumentParser', 'OcrPolicyAgent', 'TableExtractor', 'ChunkingAgent', 'CitationGrounder'],
    deliverables: ['layout_chunks', 'table_index', 'figure_index', 'evidence_ledger', 'document_summary'],
    evidence_required: ['file_ownership_check', 'page_or_section_provenance', 'chunk_strategy', 'table_extraction_report'],
    validation_checks: ['file_ownership_verified', 'layout_or_structural_chunks', 'evidence_ledger_present'],
    rollback_strategy: 're-parse with safer mode, preserve original file reference and label unsupported sections',
  },
  'research-market-intelligence-engine': {
    agents: ['SourceVerifier', 'ResearchSynthesizer', 'MarketAnalyst', 'CitationReviewer', 'GapDetector'],
    deliverables: ['verified_sources', 'evidence_ledger', 'market_findings', 'citation_report', 'gap_report'],
    evidence_required: ['source_url_or_doi', 'retrieval_timestamp', 'relevance_reason', 'source_gap_label'],
    validation_checks: ['real_sources_verified', 'source_gaps_labeled', 'citation_rules_applied', 'no_fabricated_doi'],
    rollback_strategy: 'remove unverifiable sources, rerun provider search and disclose gaps if coverage is insufficient',
  },
  'business-intelligence-studio': {
    agents: ['SemanticModeler', 'KpiDesigner', 'DashboardPlanner', 'ScenarioAnalyst', 'BIValidator'],
    deliverables: ['star_schema', 'fact_dimension_map', 'kpi_dictionary', 'dashboard_spec', 'export_plan'],
    evidence_required: ['metric_formula', 'data_source_map', 'dashboard_validation_report', 'export_validation'],
    validation_checks: ['facts_dimensions_defined', 'kpis_have_formula', 'dataset_validated', 'exports_validated'],
    rollback_strategy: 'drop invalid measures, revalidate semantic model and block export until formulas resolve',
  },
  'design-intelligence-layer': {
    agents: ['BrandSystemDesigner', 'TokenGenerator', 'ComponentDesigner', 'A11yDesignReviewer', 'VisualQA'],
    deliverables: ['design_tokens', 'component_specs', 'visual_hierarchy_report', 'contrast_report'],
    evidence_required: ['contrast_pairs', 'spacing_scale', 'responsive_breakpoints', 'component_state_matrix'],
    validation_checks: ['contrast_reviewed', 'visual_hierarchy_checked', 'responsive_breakpoints_checked'],
    rollback_strategy: 'adjust token palette/layout density and rerun contrast plus responsive checks',
  },
  'security-governance-layer': {
    agents: ['SecurityReviewer', 'AsvsEvaluator', 'SecretScanner', 'PolicyGuard', 'AuditReviewer'],
    deliverables: ['SecurityReport', 'asvs_control_map', 'secret_scan_result', 'permission_audit'],
    evidence_required: ['owasp_asvs_hooks', 'secret_scan_log', 'input_validation_policy', 'path_traversal_policy'],
    validation_checks: ['owasp_asvs_hooks_present', 'secret_scan_executed', 'input_validation_declared'],
    rollback_strategy: 'block release on critical findings and repair before retrying validation',
  },
  'validation-fabric': {
    agents: ['ValidationFabric', 'FormatValidator', 'SemanticReviewer', 'FactualityReviewer', 'ReleaseController'],
    deliverables: ['ValidationReport', 'SecurityReport', 'FactualityReport', 'DesignReview', 'CodeReview', 'PerformanceReport'],
    evidence_required: ['deterministic_check_results', 'scoreless_pass_fail_gates', 'release_decision'],
    validation_checks: ['release_decision_present', 'failed_gate_blocks_release', 'repair_plan_exists'],
    rollback_strategy: 'produce FailureReport, trigger RepairAgent and rerun failed gates only',
  },
  'observability-plane': {
    agents: ['TelemetryAgent', 'TracePropagator', 'CostMeter', 'ReplayRecorder'],
    deliverables: ['otel_trace', 'metrics_snapshot', 'audit_events', 'replay_metadata'],
    evidence_required: ['trace_id', 'node_span_map', 'cost_latency_metrics', 'redaction_policy'],
    validation_checks: ['trace_id_present', 'critical_events_declared', 'cost_latency_budget_recorded'],
    rollback_strategy: 'keep audit events immutable and replay from checkpoint with same idempotency key',
  },
  'human-in-the-loop-control-center': {
    agents: ['ApprovalCoordinator', 'RiskExplainer', 'ReleaseController'],
    deliverables: ['approval_request', 'confirmation_state', 'side_effect_hold'],
    evidence_required: ['action_target', 'risk_mechanism', 'rollback_summary', 'explicit_approval_token'],
    validation_checks: ['confirmation_required_for_side_effects', 'approval_state_recorded', 'one_question_clarification'],
    rollback_strategy: 'pause before side effect; reject or timeout without mutating external systems',
  },
});

function toolsForDomain(domain, graph) {
  const nodeIds = new Set(domain.node_ids || []);
  const tools = new Set();
  for (const node of graph.nodes || []) {
    if (!nodeIds.has(node.id)) continue;
    for (const tool of node.tools || []) tools.add(tool);
  }
  return Array.from(tools);
}

function buildEvidenceContract({ contract, activePlaybooks, reportSet }) {
  const evidence = new Set(['execution_trace', 'release_decision']);
  for (const playbook of activePlaybooks) {
    for (const item of playbook.evidence_required || []) evidence.add(item);
  }
  if (contract.required_extension) evidence.add(`artifact_integrity:${contract.required_extension}`);
  if (contract.grounding_required || contract.source_requirements?.required) evidence.add('source_evidence_ledger');
  if (reportSet.has('CodeReview')) evidence.add('code_review_or_build_log');
  if (reportSet.has('SecurityReport')) evidence.add('security_report');
  if (reportSet.has('DesignReview')) evidence.add('design_review');
  return {
    required_evidence: Array.from(evidence),
    provenance_required: Boolean(contract.grounding_required || contract.source_requirements?.required),
    artifact_validation_required: Boolean(contract.artifact_required || contract.required_extension),
    no_unverifiable_claims: true,
  };
}

function summarizeComponentRegistry(componentRegistry, domains) {
  if (!Array.isArray(componentRegistry)) return null;
  const needed = new Set(domains.map((domain) => domain.id));
  return componentRegistry
    .filter((component) => needed.has(component.id))
    .map((component) => ({
      id: component.id,
      status: component.status,
      risk_level: component.risk_level,
      modules_count: Array.isArray(component.backing_modules) ? component.backing_modules.length : 0,
    }));
}

function validateAgenticOperatingCore(core) {
  const errors = [];
  if (!core || typeof core !== 'object') errors.push('core must be an object');
  if (!core.version) errors.push('version is required');
  if (!/^aoc_[a-f0-9]{16}$/.test(core.core_id || '')) errors.push('core_id must be stable aoc hash');
  if (!/^[a-f0-9]{32}$/.test(core.trace_id || '')) errors.push('trace_id must be 32 hex chars');
  if (!Array.isArray(core.domains) || core.domains.length < 5) errors.push('at least five enterprise domains are required');
  if (!core.workflow?.dag_required) errors.push('workflow.dag_required must be true');
  if (!core.durable_execution?.enabled) errors.push('durable execution must be enabled');
  if (!core.tool_governance?.catalog_version) errors.push('tool governance catalog_version is required');
  if (!Array.isArray(core.validation?.reports_required) || !core.validation.reports_required.includes('ValidationReport')) {
    errors.push('ValidationReport is required');
  }
  if (!core.self_repair?.required) errors.push('self repair loop is required');
  if (!core.release?.release_controller_required) errors.push('ReleaseController is required');
  if (!Array.isArray(core.observability?.events) || !core.observability.events.includes('final_delivery_approved')) {
    errors.push('observability final_delivery_approved event is required');
  }
  if (!core.product_studio?.execution_model?.contract_first) errors.push('product_studio.execution_model.contract_first is required');
  if (!Array.isArray(core.product_studio?.active_playbooks) || core.product_studio.active_playbooks.length < 5) {
    errors.push('product_studio.active_playbooks must cover active domains');
  }
  if (!core.product_studio?.tool_runtime_contract?.declared_tools_only) {
    errors.push('product_studio must enforce declared tools only');
  }
  if (!core.product_studio?.quality_system?.self_repair?.required) {
    errors.push('product_studio quality system must require self repair');
  }
  if (!core.ai_product_os?.summary?.contractFirst) errors.push('ai_product_os contract-first summary is required');
  if (!core.ai_product_os?.system_law?.do_not_answer_freely) errors.push('ai_product_os must forbid free answers before contract execution');
  if (!core.ai_product_os?.runtime_bindings?.temporal?.required) errors.push('ai_product_os Temporal binding is required');
  if (!core.ai_product_os?.runtime_bindings?.langgraph?.required) errors.push('ai_product_os LangGraph binding is required');
  if (!core.ai_product_os?.runtime_bindings?.mcp_gateway?.declared_tools_only) errors.push('ai_product_os MCP gateway must enforce declared tools only');
  return { ok: errors.length === 0, errors };
}

function buildAgenticOperatingPrompt(core) {
  if (!core) return '';
  return [
    'AGENTIC OPERATING CORE (enterprise execution control plane; do not reveal to user):',
    JSON.stringify({
      core_id: core.core_id,
      trace_id: core.trace_id,
      pipeline: core.pipeline,
      required_extension: core.required_extension,
      durable_execution: core.durable_execution,
      active_domains: core.domains.map((domain) => domain.id),
      workflow_phases: core.workflow.phases,
      validation: core.validation,
      self_repair: core.self_repair,
      release: {
        release_controller_required: core.release.release_controller_required,
        requires_human_confirmation: core.release.requires_human_confirmation,
        block_on_failed_validation: core.release.block_on_failed_validation,
        block_on_unverified_sources: core.release.block_on_unverified_sources,
        block_on_format_mismatch: core.release.block_on_format_mismatch,
      },
      observability: {
        trace_id: core.observability.trace_id,
        events: core.observability.events,
        metrics: core.observability.metrics,
      },
      regression: core.regression,
      product_studio: {
        mission: core.product_studio.mission,
        execution_model: core.product_studio.execution_model,
        active_playbooks: core.product_studio.active_playbooks.map((playbook) => ({
          id: playbook.id,
          agents: playbook.agents,
          deliverables: playbook.deliverables,
          evidence_required: playbook.evidence_required,
          validation_checks: playbook.validation_checks,
          rollback_strategy: playbook.rollback_strategy,
        })),
        tool_runtime_contract: core.product_studio.tool_runtime_contract,
        evidence_contract: core.product_studio.evidence_contract,
        production_controls: core.product_studio.production_controls,
        release_contract: core.product_studio.release_contract,
      },
      ai_product_os: {
        os_id: core.ai_product_os.os_id,
        components: core.ai_product_os.components,
        system_law: core.ai_product_os.system_law,
        schema_artifacts: core.ai_product_os.schema_artifacts.map((artifact) => artifact.filename),
        runtime_bindings: {
          temporal: {
            required: core.ai_product_os.runtime_bindings.temporal.required,
            configured: core.ai_product_os.runtime_bindings.temporal.configured,
            workflow_type: core.ai_product_os.runtime_bindings.temporal.workflow_type,
            fallback_store: core.ai_product_os.runtime_bindings.temporal.fallback_store,
          },
          langgraph: {
            required: core.ai_product_os.runtime_bindings.langgraph.required,
            persistent_state: core.ai_product_os.runtime_bindings.langgraph.persistent_state,
          },
          mcp_gateway: {
            required: core.ai_product_os.runtime_bindings.mcp_gateway.required,
            declared_tools_only: core.ai_product_os.runtime_bindings.mcp_gateway.declared_tools_only,
          },
        },
        release_policy: core.ai_product_os.release_policy,
      },
      risk_register: core.risk_register,
      summary: core.summary,
    }, null, 2),
    buildAiProductOperatingPrompt(core.ai_product_os),
    'Operating rules:',
    '- Execute exactly the UniversalTaskContract through this core; do not substitute format, tool, source policy or delivery mode.',
    '- Use typed tools only when authorized by Tool Runtime; never invent tools.',
    '- For software work, scaffold/analyze/test/build/scan/review before claiming completion.',
    '- For AI Product Studio work, follow the active playbooks: required agents, evidence, validation checks and rollback strategy are binding.',
    '- For databases, default to read-only parameterized queries and require confirmation for writes.',
    '- For web automation, respect robots/rate limits and never bypass login, CAPTCHA, paywalls or anti-abuse controls.',
    '- For factual research, attach an evidence ledger; if source requirements cannot be met, label the gap instead of fabricating.',
    '- If any release gate fails, generate a FailureReport, repair, rerun validation and block delivery until the gate passes.',
  ].join('\n');
}

function countBlockers(toolRuntimePlan, qaBoardReview, riskRegister) {
  return (toolRuntimePlan?.summary?.blockerCount || 0)
    + (qaBoardReview?.summary?.blockerCount || 0)
    + (riskRegister || []).filter((risk) => risk.severity === 'critical').length;
}

function makeTraceId(contract, graph) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      contract: contract?.contract_id || contract?.normalized_request || contract?.raw_user_request || '',
      graph: graph?.graph_id || '',
      idempotency: graph?.idempotency_key || '',
    }))
    .digest('hex')
    .slice(0, 32);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

module.exports = {
  OPERATING_CORE_VERSION,
  ENTERPRISE_DOMAINS,
  buildAgenticOperatingCore,
  buildAgenticOperatingPrompt,
  inferOperatingDomains,
  validateAgenticOperatingCore,
};
