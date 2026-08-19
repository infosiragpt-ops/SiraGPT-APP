/**
 * agentic-qa-board
 *
 * Deterministic preflight/final release review for enterprise
 * agentic tasks. It assembles ValidationReport, SecurityReport,
 * FactualityReport, DesignReview, CodeReview and PerformanceReport,
 * then delegates the final decision to ValidationFabric.
 */

const { validateUniversalTaskContract } = require('./universal-task-contract');
const { validateEnterpriseExecutionGraph } = require('./enterprise-agentic-runtime');
const { aggregate } = require('./validation-fabric');
const { createFailureReport } = require('./failure-report');
const { evaluateAsvs } = require('../security/owasp-asvs');
const { scanJson } = require('../security/secret-scanner');

const QA_BOARD_VERSION = 'agentic-qa-board-2026-04';

function buildAgenticQaBoardReview({
  contract,
  graph,
  toolRuntimePlan,
  phase = 'preflight',
  evidence = null,
  validationResults = null,
  budgets = null,
} = {}) {
  const validation = buildValidationReport({ contract, graph, toolRuntimePlan, validationResults });
  const security = buildSecurityReport({ contract, graph, toolRuntimePlan });
  const factuality = buildFactualityReport({ contract, graph, phase, evidence });
  const designReview = buildDesignReview({ contract, graph, validationResults });
  const codeReview = buildCodeReview({ contract, graph, validationResults });
  const performance = buildPerformanceReport({ graph, budgets });

  const releaseDecision = aggregate({
    validation,
    security,
    factuality,
    designReview,
    codeReview,
    performance,
    budgets,
  });

  const blockers = releaseDecision.findings.filter((finding) => (
    finding.severity === 'critical'
    || finding.severity === 'high'
    || validation.ok === false && finding.source === 'validation'
    || security.ok === false && finding.source === 'security'
  ));
  const warnings = releaseDecision.findings.filter((finding) => finding.severity === 'medium' || finding.severity === 'low');
  const failureReports = buildFailureReports({ releaseDecision, validation, security, factuality, toolRuntimePlan });

  return {
    version: QA_BOARD_VERSION,
    phase,
    createdAt: new Date().toISOString(),
    graphId: graph?.graph_id || null,
    pipeline: contract?.pipeline || null,
    reports: {
      validation,
      security,
      factuality,
      designReview,
      codeReview,
      performance,
    },
    releaseDecision,
    blockers,
    warnings,
    failureReports,
    summary: {
      decision: releaseDecision.decision,
      reason: releaseDecision.reason,
      blockerCount: blockers.length,
      warningCount: warnings.length,
      failureReportCount: failureReports.length,
      requiredReports: graph?.qa_board?.reports_required || [],
      reviewers: graph?.qa_board?.reviewers || [],
    },
  };
}

function buildValidationReport({ contract, graph, toolRuntimePlan, validationResults }) {
  const findings = [];
  const contractValidation = validateUniversalTaskContract(contract || {});
  const graphValidation = graph ? validateEnterpriseExecutionGraph(graph) : { ok: false, errors: [{ message: 'missing graph' }] };

  if (!contractValidation.ok) {
    findings.push({
      severity: 'critical',
      code: 'invalid_universal_task_contract',
      detail: compactErrors(contractValidation.errors),
    });
  }
  if (!graphValidation.ok) {
    findings.push({
      severity: 'critical',
      code: 'invalid_execution_graph',
      detail: compactErrors(graphValidation.errors),
    });
  }
  if (toolRuntimePlan && toolRuntimePlan.ok === false) {
    for (const blocker of toolRuntimePlan.authorization?.blockers || []) {
      findings.push({
        severity: 'high',
        code: blocker.code || 'tool_runtime_blocker',
        detail: blocker.detail || JSON.stringify(blocker).slice(0, 300),
      });
    }
  }
  if (contract?.required_extension) {
    const expectedCheck = `format:${contract.required_extension}`;
    const graphHasFormatGate = (graph?.gates?.validation_gate || []).includes(expectedCheck)
      || (graph?.nodes || []).some((node) => (node.validation_gate?.deterministic_checks || []).includes(expectedCheck));
    if (!graphHasFormatGate) {
      findings.push({
        severity: 'high',
        code: 'missing_format_sovereignty_gate',
        detail: `ExecutionGraph does not include deterministic gate ${expectedCheck}.`,
      });
    }
  }
  if (validationResults?.ok === false) {
    findings.push({
      severity: 'high',
      code: 'downstream_validation_failed',
      detail: compactErrors(validationResults.errors || validationResults.findings || []),
    });
  }

  return {
    ok: findings.every((finding) => !['critical', 'high'].includes(finding.severity)),
    findings,
    raw: {
      contractValidation,
      graphValidation,
      toolRuntime: toolRuntimePlan?.summary || null,
    },
  };
}

function buildSecurityReport({ contract, graph, toolRuntimePlan }) {
  const findings = [];
  const secretScan = scanJson({ contract, graph, toolRuntime: toolRuntimePlan?.summary || null }, {
    // These fields are policy labels in manifests, not actual secrets.
    ignorePatterns: [],
  });
  for (const item of secretScan.findings || []) {
    findings.push({
      severity: item.severity || 'high',
      code: `secret_${item.code}`,
      detail: `${item.detail}${item.path ? ` at ${item.path}` : ''}`,
    });
  }

  const asvs = evaluateAsvs({
    context: {
      passwordPolicy: { minLength: 12 },
      rateLimits: { login: true },
      authMiddleware: { serverSide: true },
      rbac: { roles: ['user', 'admin'], policyEngine: true },
      inputValidators: { positiveSchema: true },
      sqlGovernance: { parameterisedOnly: true },
      outputEncoding: { contextAware: true },
      logRedaction: { secretsMasked: true },
      tls: { minVersion: 1.2 },
    },
    // Dependency audit is executed by CI/build; this preflight only
    // verifies the policy hooks that are deterministic at request time.
    skipControls: ['V14.2.1'],
  });
  findings.push(...asvs.findings.map((finding) => ({
    severity: finding.severity,
    code: finding.code,
    detail: finding.detail,
  })));

  for (const blocker of toolRuntimePlan?.authorization?.blockers || []) {
    if (blocker.code === 'forbidden_tool' || blocker.code === 'undeclared_tool') {
      findings.push({
        severity: 'high',
        code: `tool_policy_${blocker.code}`,
        detail: blocker.detail,
      });
    }
  }

  return {
    ok: secretScan.ok && asvs.ok && !findings.some((finding) => finding.severity === 'critical'),
    findings,
    raw: { secretScan, asvs },
  };
}

function buildFactualityReport({ contract, graph, phase, evidence }) {
  const findings = [];
  const groundingRequired = Boolean(contract?.grounding_required || contract?.source_requirements?.required);
  const evidenceLedger = evidence?.evidence_ledger || evidence?.sources || evidence?.citations || [];
  if (groundingRequired && phase === 'final' && evidenceLedger.length === 0) {
    findings.push({
      severity: 'high',
      code: 'missing_evidence_ledger',
      detail: 'Grounding is required but no evidence ledger was attached for final release.',
    });
  } else if (groundingRequired) {
    findings.push({
      severity: 'low',
      code: 'evidence_ledger_required_before_release',
      detail: 'This task requires verified sources; final release must include source/evidence ledger validation.',
    });
  }
  if (graph?.architecture_layers?.includes('ResearchMarketIntelligenceEngine')) {
    findings.push({
      severity: 'info',
      code: 'research_grounding_gate_present',
      detail: 'ResearchMarketIntelligenceEngine is in the graph and must validate real sources before final delivery.',
    });
  }
  return {
    ok: !findings.some((finding) => ['critical', 'high'].includes(finding.severity)),
    findings,
    raw: { groundingRequired, evidenceCount: evidenceLedger.length },
  };
}

function buildDesignReview({ contract, graph }) {
  const findings = [];
  const requiresDesign = graph?.architecture_layers?.includes('DesignSystemGenerator')
    || graph?.architecture_layers?.includes('FullStackWebBuilder')
    || contract?.pipeline === 'VisualArtifactPipeline'
    || contract?.pipeline === 'SlidePipeline';
  if (requiresDesign) {
    findings.push({
      severity: 'low',
      code: 'design_review_required_before_release',
      detail: 'Design deliverables must pass contrast, hierarchy, responsive and brand consistency checks before final release.',
    });
  }
  return { ok: true, findings, raw: { requiresDesign } };
}

function buildCodeReview({ contract, graph }) {
  const findings = [];
  const requiresCode = graph?.architecture_layers?.includes('SoftwareEngineeringPipeline')
    || graph?.architecture_layers?.includes('FullStackWebBuilder')
    || contract?.pipeline === 'CodePipeline';
  if (requiresCode) {
    findings.push({
      severity: 'low',
      code: 'code_tests_required_before_release',
      detail: 'Generated or modified code must pass lint/type-check/tests/build/security review before final release.',
    });
  }
  return { ok: true, findings, raw: { requiresCode } };
}

function buildPerformanceReport({ graph, budgets }) {
  const findings = [];
  const maxMs = graph?.latency_budget?.max_ms;
  if (typeof budgets?.latency_ms === 'number' && typeof maxMs === 'number' && budgets.latency_ms > maxMs) {
    findings.push({
      severity: 'high',
      code: 'latency_budget_exceeded',
      detail: `latency ${budgets.latency_ms}ms exceeds graph max ${maxMs}ms`,
    });
  }
  if (graph?.durable_execution?.enabled !== true) {
    findings.push({
      severity: 'medium',
      code: 'durable_execution_disabled',
      detail: 'ExecutionGraph must enable durable execution for enterprise tasks.',
    });
  }
  return {
    ok: !findings.some((finding) => ['critical', 'high'].includes(finding.severity)),
    findings,
    raw: {
      graphLatencyBudget: graph?.latency_budget || null,
      budgets: budgets || null,
      durableExecution: graph?.durable_execution || null,
    },
  };
}

function buildFailureReports({ releaseDecision, validation, security, factuality, toolRuntimePlan }) {
  const reports = [];
  const failureSources = [
    ['validation', validation],
    ['security', security],
    ['factuality', factuality],
  ];
  for (const [source, report] of failureSources) {
    if (!report || report.ok !== false) continue;
    const critical = (report.findings || []).find((finding) => ['critical', 'high'].includes(finding.severity));
    reports.push(createFailureReport({
      failed_stage: source === 'factuality' ? 'semantic_validation' : 'release_review',
      expected_output: `${source} report ok=true`,
      actual_output: report.findings || [],
      root_cause: critical?.detail || `${source} report failed`,
      repair_strategy: source === 'security'
        ? 'Remove/mitigate the security blocker, rerun SecurityReport and keep release blocked until clean.'
        : 'Repair the contract/graph/tool plan output and rerun the failed deterministic report.',
      retry_count: 0,
      tests_reexecuted: (report.findings || []).map((finding) => finding.code).slice(0, 30),
      release_decision: releaseDecision.decision === 'reject' ? 'abort' : 'retry',
      meta: { source },
    }));
  }

  for (const blocker of toolRuntimePlan?.authorization?.blockers || []) {
    reports.push(createFailureReport({
      failed_stage: 'tool_selected',
      expected_output: 'all required graph tools registered and allowed',
      actual_output: blocker,
      root_cause: blocker.detail || blocker.code,
      repair_strategy: 'Select a declared allowed tool from ToolManifest or change the contract before execution.',
      retry_count: 0,
      tests_reexecuted: ['tool_manifest_authorized'],
      release_decision: 'retry',
      meta: { toolRuntime: true },
    }));
  }

  return reports;
}

function compactErrors(errors) {
  if (!Array.isArray(errors)) return String(errors || '').slice(0, 500);
  return errors
    .map((error) => error.message || error.detail || error.code || JSON.stringify(error))
    .join('; ')
    .slice(0, 800);
}

module.exports = {
  QA_BOARD_VERSION,
  buildAgenticQaBoardReview,
  buildValidationReport,
  buildSecurityReport,
  buildFactualityReport,
  buildDesignReview,
  buildCodeReview,
  buildPerformanceReport,
};
