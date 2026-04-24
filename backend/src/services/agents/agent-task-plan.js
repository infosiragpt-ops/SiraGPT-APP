/**
 * Deterministic task plan for long-running chat agents.
 *
 * This does not try to replace the LLM planner. It gives the runtime a stable
 * contract before the first model call: phases, checkpoints and success
 * criteria derived from execution gates and user intent alignment. The model
 * sees this plan; the durable task snapshot stores it for audit/replay.
 */

const PLAN_VERSION = 'agent-task-plan-2026-04';

function buildAgentTaskPlan({
  goal = '',
  executionProfile = null,
  intentAlignmentProfile = null,
  fileIds = [],
  maxRuntimeMs = null,
} = {}) {
  const capabilities = executionProfile?.capabilities || {};
  const requiredTools = Array.isArray(executionProfile?.requiredTools) ? executionProfile.requiredTools : [];
  const hardConstraints = Array.isArray(intentAlignmentProfile?.hardConstraints)
    ? intentAlignmentProfile.hardConstraints
    : [];
  const phases = [];

  phases.push({
    id: 'orchestrate',
    role: 'orchestrator',
    objective: 'Parse the user request, preserve hard constraints, and decide the minimum safe tool path.',
    requiredTools: [],
    checkpoint: 'Intent, format, evidence mode and deliverable criteria are explicit.',
  });

  if (capabilities.needsPrivateContext || requiredTools.includes('rag_retrieve') || fileIds.length) {
    phases.push({
      id: 'private_context',
      role: 'research',
      objective: 'Retrieve uploaded/project context before answering or generating artifacts from private material.',
      requiredTools: ['rag_retrieve'],
      checkpoint: 'Relevant private chunks are retrieved and separated from assumptions.',
    });
  }

  if (capabilities.needsResearch || requiredTools.includes('web_search')) {
    phases.push({
      id: 'source_research',
      role: 'research',
      objective: 'Collect external sources with DOI/URL/year/provider metadata and deduplicate them.',
      requiredTools: ['web_search'],
      checkpoint: 'Evidence ledger has enough verified sources or a clearly stated verified gap.',
    });
  }

  if (capabilities.needsComputation || requiredTools.includes('python_exec')) {
    phases.push({
      id: 'compute',
      role: 'code',
      objective: 'Use executable computation for numeric, tabular, statistical or data-heavy claims.',
      requiredTools: ['python_exec'],
      checkpoint: 'Computed outputs are reproducible and copied from tool output, not estimated.',
    });
  }

  if (capabilities.needsDocument || requiredTools.includes('create_document')) {
    phases.push({
      id: 'document_generation',
      role: 'document_design',
      objective: 'Generate the requested file with professional structure, styling and complete content.',
      requiredTools: ['create_document'],
      checkpoint: 'Artifact exists, has non-empty professional content and matches requested format.',
    });
    phases.push({
      id: 'file_validation',
      role: 'file_validation',
      objective: 'Open/inspect the generated artifact and verify counts, sheets, slides, headers, rows or pages.',
      requiredTools: ['verify_artifact'],
      checkpoint: 'Verification summary satisfies the user request before final delivery.',
    });
  }

  if (capabilities.needsCodeOrRepair || requiredTools.includes('run_tests')) {
    phases.push({
      id: 'qa_tests',
      role: 'qa',
      objective: 'Run invariant/unit tests for generated or repaired code before finalizing.',
      requiredTools: ['run_tests'],
      checkpoint: 'Tests pass or failures are repaired and re-run.',
    });
  }

  phases.push({
    id: 'supervision',
    role: 'supervision',
    objective: 'Block premature finalization until required tools, evidence and artifact checks are complete.',
    requiredTools: ['finalize'],
    checkpoint: 'Final answer is grounded, concise, same-language, and does not expose internal contracts.',
  });

  return {
    version: PLAN_VERSION,
    objective: summarizeObjective(goal, intentAlignmentProfile),
    runtimeBudgetMs: maxRuntimeMs || null,
    outputMode: intentAlignmentProfile?.outputMode || 'unknown',
    requestedFormat: intentAlignmentProfile?.requestedFormat || null,
    groundingMode: intentAlignmentProfile?.groundingMode || 'unknown',
    hardConstraints,
    phases,
    successCriteria: buildSuccessCriteria({ executionProfile, intentAlignmentProfile, phases }),
    risks: buildRisks({ executionProfile, intentAlignmentProfile }),
  };
}

function summarizeObjective(goal, intentAlignmentProfile) {
  const taxonomy = intentAlignmentProfile?.taxonomy || 'task';
  const mode = intentAlignmentProfile?.outputMode || 'response';
  const format = intentAlignmentProfile?.requestedFormat ? `/${intentAlignmentProfile.requestedFormat}` : '';
  const clean = String(goal || '').replace(/\s+/g, ' ').trim();
  return `${taxonomy}:${mode}${format}${clean ? ` · ${clean.slice(0, 180)}` : ''}`;
}

function buildSuccessCriteria({ executionProfile, intentAlignmentProfile, phases }) {
  const criteria = [
    'The final answer directly satisfies the latest user instruction.',
    'No fabricated citations, DOI, files, tool results or verification claims.',
    'The response stays in the user language unless explicitly requested otherwise.',
  ];
  const requiredTools = executionProfile?.requiredTools || [];
  if (requiredTools.length) {
    criteria.push(`Required tools used before finalization: ${requiredTools.join(', ')}.`);
  }
  if (intentAlignmentProfile?.outputMode === 'downloadable_artifact') {
    criteria.push('A real downloadable artifact is generated, validated and linked.');
  }
  if (intentAlignmentProfile?.outputMode === 'inline') {
    criteria.push('No file is generated unless the user explicitly requested one.');
  }
  if (phases.some((phase) => phase.id === 'source_research')) {
    criteria.push('Sources keep DOI/URL/year/provider metadata and verified gaps are stated clearly.');
  }
  return criteria;
}

function buildRisks({ executionProfile, intentAlignmentProfile }) {
  const risks = [];
  if (executionProfile?.capabilities?.strictEvidence) {
    risks.push('Strict evidence requests can fail if providers return fewer verified records than requested; never pad with weak rows.');
  }
  if (intentAlignmentProfile?.groundingMode === 'private_context_required') {
    risks.push('Private document requests must not be answered from general memory when RAG retrieval fails.');
  }
  if (intentAlignmentProfile?.requestedFormat) {
    risks.push('Generated file must be technically inspectable before download is offered.');
  }
  if (!risks.length) {
    risks.push('Main risk is premature finalization without enough tool evidence.');
  }
  return risks;
}

function buildAgentTaskPlanPrompt(plan) {
  if (!plan) return '';
  const phases = (plan.phases || [])
    .map((phase, index) => `${index + 1}. ${phase.role}/${phase.id}: ${phase.objective} Checkpoint: ${phase.checkpoint}`)
    .join('\n');
  const criteria = (plan.successCriteria || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const risks = (plan.risks || []).map((item, index) => `${index + 1}. ${item}`).join('\n');

  return [
    `Task plan: ${plan.version}`,
    `Objective: ${plan.objective}`,
    `Output mode: ${plan.outputMode}${plan.requestedFormat ? ` (${plan.requestedFormat})` : ''}`,
    `Grounding mode: ${plan.groundingMode}`,
    'Phases:',
    phases || 'No phases generated.',
    'Success criteria:',
    criteria || 'No criteria generated.',
    'Risks to control:',
    risks || 'No risks generated.',
  ].join('\n');
}

module.exports = {
  PLAN_VERSION,
  buildAgentTaskPlan,
  buildAgentTaskPlanPrompt,
};
