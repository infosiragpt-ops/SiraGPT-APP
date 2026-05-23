const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildUniversalTaskContract } = require('../src/services/agents/universal-task-contract');
const { buildEnterpriseExecutionGraph } = require('../src/services/agents/enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('../src/services/agents/enterprise-tool-gateway');
const {
  buildAgenticQaBoardReview,
  buildSecurityReport,
} = require('../src/services/agents/agentic-qa-board');

function buildReview(prompt) {
  const contract = buildUniversalTaskContract({ rawUserRequest: prompt });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-qa' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  return {
    contract,
    graph,
    toolRuntimePlan,
    review: buildAgenticQaBoardReview({ contract, graph, toolRuntimePlan }),
  };
}

test('agentic QA board approves deterministic preflight for a valid enterprise graph', () => {
  const { review } = buildReview('Crea una presentación profesional sobre inteligencia artificial con diseño ejecutivo');

  assert.equal(review.version, 'agentic-qa-board-2026-04');
  assert.equal(review.reports.validation.ok, true);
  assert.equal(review.reports.security.ok, true);
  assert.ok(['approve', 'manual-review'].includes(review.releaseDecision.decision));
  assert.ok(review.summary.requiredReports.includes('ValidationReport'));
});

test('agentic QA board records factuality gate for research-grounded tasks', () => {
  const { review } = buildReview('Busca 40 artículos científicos reales con DOI y entrégalos en Excel');

  assert.equal(review.reports.factuality.ok, true);
  assert.ok(review.reports.factuality.findings.some((finding) => finding.code === 'evidence_ledger_required_before_release'));
});

test('agentic QA board rejects secret-shaped data before release', () => {
  const fakeSecret = `sk-${'a'.repeat(52)}`;
  const contract = buildUniversalTaskContract({
    rawUserRequest: `Conecta esta clave ${fakeSecret} y genera una API`,
  });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-secret' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const review = buildAgenticQaBoardReview({ contract, graph, toolRuntimePlan });

  assert.equal(review.reports.security.ok, false);
  assert.equal(review.releaseDecision.decision, 'reject');
  assert.ok(review.failureReports.length >= 1);
});

test('security report includes ASVS evaluator output without requiring deployment audit evidence at preflight', () => {
  const contract = buildUniversalTaskContract({ rawUserRequest: 'Crea una API segura con autenticación y roles' });
  const graph = buildEnterpriseExecutionGraph({ contract, taskId: 'task-asvs' });
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const report = buildSecurityReport({ contract, graph, toolRuntimePlan });

  assert.equal(report.ok, true);
  assert.equal(report.raw.asvs.failed, 0);
  assert.ok(report.raw.asvs.evaluated >= 6);
});

test('agentic QA board produces FailureReport when tool runtime has blockers', () => {
  const contract = buildUniversalTaskContract({ rawUserRequest: 'Hola' });
  const graph = {
    ...buildEnterpriseExecutionGraph({ contract, taskId: 'task-bad-tool' }),
    nodes: [
      {
        id: 'request_intelligence',
        tools: ['ghost_tool'],
        release_gate: { requires_human_confirmation: false },
        validation_gate: { deterministic_checks: [] },
      },
    ],
    edges: [],
    gates: { validation_gate: [], release_gate: [] },
  };
  const toolRuntimePlan = buildToolRuntimePlan({ contract, graph });
  const review = buildAgenticQaBoardReview({ contract, graph, toolRuntimePlan });

  assert.equal(toolRuntimePlan.ok, false);
  assert.equal(review.releaseDecision.decision, 'reject');
  assert.ok(review.failureReports.some((report) => report.failed_stage === 'tool_selected'));
});
