'use strict';

const {
  successfulToolCalls,
} = require('./agentic-execution-profile');

const PROGRESS_LEDGER_VERSION = 'agent-autonomy-progress-ledger-2026-06';

const NON_EXECUTABLE_PHASES = new Set([
  'orchestrate',
  'request_intelligence_contract',
  'supervision',
]);

const CRITICAL_PHASE_IDS = new Set([
  'bulk_source_inventory',
  'source_activation_ledger',
  'openclaw_reference_audit',
  'native_runtime_fusion',
  'autonomous_agent_contract',
  'agent_runtime_diagnostics',
  'qa_tests',
]);

const PHASE_EVIDENCE_TOOLS = Object.freeze({
  bulk_source_inventory: ['run_tests'],
  source_activation_ledger: ['run_tests'],
  openclaw_reference_audit: ['web_search', 'read_url', 'run_tests', 'host_file', 'bash_exec'],
  native_runtime_fusion: ['run_tests'],
  autonomous_agent_contract: ['run_tests'],
  agent_runtime_diagnostics: ['run_tests'],
  private_context: ['docintel_analyze', 'rag_retrieve'],
  source_research: ['web_search'],
  compute: ['python_exec'],
  document_generation: ['create_document'],
  file_validation: ['verify_artifact'],
  qa_tests: ['run_tests'],
});

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function toCountsObject(counts) {
  return Object.fromEntries(Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function hasSuccessfulTool(counts, tool) {
  return (counts.get(tool) || 0) > 0;
}

function isOpenClawSummaryActive(summary) {
  if (!summary || typeof summary !== 'object') return false;
  const signals = summary.signals || {};
  const capabilities = summary.capabilities || {};
  return Boolean(
    signals.externalRepoAdaptation
    || signals.wantsAutonomousAgent
    || signals.massiveSourceFusion
    || signals.nativeRewriteRequired
    || capabilities.nativeRepoAdaptation
    || capabilities.bulkSourceFusion
  );
}

function isTaskPlanActive(taskPlan, openclawRuntimeSummary = null) {
  if (isOpenClawSummaryActive(openclawRuntimeSummary)) return true;
  if (!taskPlan || typeof taskPlan !== 'object') return false;
  return Boolean(
    taskPlan.openclawFusion?.active
    || taskPlan.agentRuntimeHardening?.active
    || taskPlan.sourceActivationLedger?.active
  );
}

function resolvePhaseTools(phase) {
  const requiredTools = unique(phase?.requiredTools || []).filter((tool) => tool !== 'finalize');
  if (requiredTools.length) {
    return {
      mode: 'all',
      requiredTools,
      candidateTools: requiredTools,
    };
  }

  const candidateTools = unique(PHASE_EVIDENCE_TOOLS[phase?.id] || []).filter((tool) => tool !== 'finalize');
  if (candidateTools.length) {
    return {
      mode: 'any',
      requiredTools: [],
      candidateTools,
    };
  }

  return {
    mode: 'none',
    requiredTools: [],
    candidateTools: [],
  };
}

function phaseProgressFromTools(phase, counts, unavailable) {
  const phaseId = String(phase?.id || '');
  const toolSpec = resolvePhaseTools(phase);
  const evidenceTools = toolSpec.candidateTools.filter((tool) => hasSuccessfulTool(counts, tool));

  if (!phaseId || NON_EXECUTABLE_PHASES.has(phaseId) || toolSpec.mode === 'none') {
    return {
      id: phaseId,
      role: phase?.role || null,
      status: 'satisfied',
      critical: false,
      evidenceTools: [],
      requiredTools: [],
      candidateTools: [],
      missingTools: [],
      checkpoint: phase?.checkpoint || null,
    };
  }

  if (toolSpec.mode === 'all') {
    const missingTools = toolSpec.requiredTools.filter((tool) => !hasSuccessfulTool(counts, tool));
    if (missingTools.length === 0) {
      return {
        id: phaseId,
        role: phase?.role || null,
        status: 'satisfied',
        critical: CRITICAL_PHASE_IDS.has(phaseId),
        evidenceTools,
        requiredTools: toolSpec.requiredTools,
        candidateTools: toolSpec.candidateTools,
        missingTools: [],
        checkpoint: phase?.checkpoint || null,
      };
    }
    if (missingTools.every((tool) => unavailable.has(tool))) {
      return {
        id: phaseId,
        role: phase?.role || null,
        status: 'waived',
        critical: CRITICAL_PHASE_IDS.has(phaseId),
        evidenceTools,
        requiredTools: toolSpec.requiredTools,
        candidateTools: toolSpec.candidateTools,
        missingTools,
        waivedTools: missingTools,
        checkpoint: phase?.checkpoint || null,
      };
    }
    return {
      id: phaseId,
      role: phase?.role || null,
      status: 'missing',
      critical: CRITICAL_PHASE_IDS.has(phaseId),
      evidenceTools,
      requiredTools: toolSpec.requiredTools,
      candidateTools: toolSpec.candidateTools,
      missingTools,
      checkpoint: phase?.checkpoint || null,
    };
  }

  if (evidenceTools.length > 0) {
    return {
      id: phaseId,
      role: phase?.role || null,
      status: 'satisfied',
      critical: CRITICAL_PHASE_IDS.has(phaseId),
      evidenceTools,
      requiredTools: [],
      candidateTools: toolSpec.candidateTools,
      missingTools: [],
      checkpoint: phase?.checkpoint || null,
    };
  }

  if (toolSpec.candidateTools.length > 0 && toolSpec.candidateTools.every((tool) => unavailable.has(tool))) {
    return {
      id: phaseId,
      role: phase?.role || null,
      status: 'waived',
      critical: CRITICAL_PHASE_IDS.has(phaseId),
      evidenceTools: [],
      requiredTools: [],
      candidateTools: toolSpec.candidateTools,
      missingTools: toolSpec.candidateTools,
      waivedTools: toolSpec.candidateTools,
      checkpoint: phase?.checkpoint || null,
    };
  }

  return {
    id: phaseId,
    role: phase?.role || null,
    status: 'missing',
    critical: CRITICAL_PHASE_IDS.has(phaseId),
    evidenceTools: [],
    requiredTools: [],
    candidateTools: toolSpec.candidateTools,
    missingTools: toolSpec.candidateTools,
    checkpoint: phase?.checkpoint || null,
  };
}

function phaseToolsForRepair(phase) {
  return unique(phase?.requiredTools?.length ? phase.requiredTools : phase?.candidateTools)
    .filter((tool) => tool !== 'finalize');
}

function buildNextActions({ active, phaseProgress, nonFinalizeTools, unavailable, openclawActive }) {
  if (!active) return [];

  const missingCritical = phaseProgress.filter((phase) => phase.status === 'missing' && phase.critical);
  const fallbackTools = openclawActive
    ? ['run_tests', 'host_file']
    : ['run_tests', 'verify_artifact', 'host_file'];

  if (nonFinalizeTools.length === 0 && unavailable.size === 0) {
    const phase = missingCritical[0] || null;
    return [{
      type: 'record_runtime_evidence',
      priority: 'critical',
      phaseId: phase?.id || null,
      tools: phase ? phaseToolsForRepair(phase) : fallbackTools,
      reason: 'runtime_evidence_required',
      checkpoint: phase?.checkpoint || null,
    }];
  }

  return missingCritical.map((phase) => ({
    type: 'complete_phase_evidence',
    priority: 'critical',
    phaseId: phase.id,
    tools: phaseToolsForRepair(phase),
    reason: 'critical_phase_missing',
    checkpoint: phase.checkpoint || null,
  }));
}

function buildReadinessSummary({ active, status, degraded, phaseProgress, nonFinalizeTools, unavailable }) {
  if (!active) {
    return {
      label: 'inactive',
      score: 100,
      evidenceRecorded: false,
      criticalPhases: { total: 0, satisfied: 0, waived: 0, missing: 0 },
      blockers: [],
    };
  }

  const critical = phaseProgress.filter((phase) => phase.critical);
  const satisfied = critical.filter((phase) => phase.status === 'satisfied').length;
  const waived = critical.filter((phase) => phase.status === 'waived').length;
  const missing = critical.filter((phase) => phase.status === 'missing');
  const total = critical.length;
  const evidenceRecorded = nonFinalizeTools.length > 0 || unavailable.size > 0;
  const coverageScore = total > 0
    ? Math.round(((satisfied + waived * 0.5) / total) * 100)
    : (evidenceRecorded ? 100 : 0);
  const score = evidenceRecorded ? coverageScore : Math.min(coverageScore, 20);

  return {
    label: status === 'blocked' ? 'blocked' : (degraded ? 'degraded_ready' : 'ready'),
    score,
    evidenceRecorded,
    criticalPhases: {
      total,
      satisfied,
      waived,
      missing: missing.length,
    },
    blockers: missing.map((phase) => ({
      phaseId: phase.id,
      tools: phaseToolsForRepair(phase),
      checkpoint: phase.checkpoint || null,
    })),
  };
}

function buildAutonomyProgressLedger({
  taskPlan = null,
  steps = [],
  unavailableTools = [],
  openclawRuntimeSummary = null,
} = {}) {
  const active = isTaskPlanActive(taskPlan, openclawRuntimeSummary);
  const openclawActive = isOpenClawSummaryActive(openclawRuntimeSummary);
  const counts = successfulToolCalls(steps);
  const unavailable = new Set(unique(unavailableTools));
  const phaseProgress = (Array.isArray(taskPlan?.phases) ? taskPlan.phases : [])
    .map((phase) => phaseProgressFromTools(phase, counts, unavailable))
    .filter((phase) => phase.id);
  const missingPhases = phaseProgress.filter((phase) => phase.status === 'missing' && phase.critical);
  const waivedPhases = phaseProgress.filter((phase) => phase.status === 'waived');
  const successfulTools = toCountsObject(counts);
  const nonFinalizeTools = Object.keys(successfulTools).filter((tool) => tool !== 'finalize' && successfulTools[tool] > 0);
  const status = !active
    ? 'inactive'
    : (missingPhases.length || (nonFinalizeTools.length === 0 && unavailable.size === 0) ? 'blocked' : 'ready');
  const degraded = waivedPhases.length > 0 || unavailable.size > 0;
  const nextActions = buildNextActions({
    active,
    phaseProgress,
    nonFinalizeTools,
    unavailable,
    openclawActive,
  });
  const readiness = buildReadinessSummary({
    active,
    status,
    degraded,
    phaseProgress,
    nonFinalizeTools,
    unavailable,
  });

  return {
    version: PROGRESS_LEDGER_VERSION,
    active,
    status,
    degraded,
    readiness,
    successfulTools,
    nonFinalizeTools,
    unavailableTools: Array.from(unavailable).sort(),
    phases: phaseProgress,
    missingPhases: missingPhases.map((phase) => phase.id),
    waivedPhases: waivedPhases.map((phase) => phase.id),
    nextRequiredPhase: missingPhases[0]?.id || null,
    nextActions,
    openclawActive,
  };
}

function validateAutonomyProgress({
  taskPlan = null,
  steps = [],
  unavailableTools = [],
  openclawRuntimeSummary = null,
} = {}) {
  const ledger = buildAutonomyProgressLedger({
    taskPlan,
    steps,
    unavailableTools,
    openclawRuntimeSummary,
  });

  if (!ledger.active) {
    return { ok: true, active: false, ledger };
  }

  if (ledger.nonFinalizeTools.length === 0 && ledger.unavailableTools.length === 0) {
    return {
      ok: false,
      active: true,
      missingTools: ['runtime_evidence'],
      requiredTools: unique(
        ledger.phases
          .filter((phase) => phase.critical)
          .flatMap((phase) => phase.requiredTools.length ? phase.requiredTools : phase.candidateTools)
      ),
      message: 'Finalization blocked by autonomy progress ledger. No successful runtime evidence was recorded before finalize.',
      repairInstructions: [
        'Execute the next required plan phase with a real tool call.',
        'Record deterministic evidence such as tests, file inspection, source audit, or artifact verification before finalizing again.',
      ].join(' '),
      repairActions: ledger.nextActions,
      ledger,
    };
  }

  const missing = ledger.phases.filter((phase) => phase.status === 'missing' && phase.critical);
  if (missing.length > 0) {
    const first = missing[0];
    const missingTools = unique(first.missingTools.length ? first.missingTools : first.candidateTools);
    return {
      ok: false,
      active: true,
      missingTools,
      requiredTools: unique(missing.flatMap((phase) => phase.requiredTools.length ? phase.requiredTools : phase.candidateTools)),
      message: `Finalization blocked by autonomy progress ledger. Missing evidence for phase ${first.id}.`,
      repairInstructions: [
        `Complete or explicitly waive phase ${first.id} before finalizing.`,
        'Run the required verification tool, inspect the result, repair failures, then call finalize again.',
      ].join(' '),
      repairActions: ledger.nextActions,
      ledger,
    };
  }

  return {
    ok: true,
    active: true,
    degraded: ledger.degraded,
    ledger,
  };
}

module.exports = {
  PROGRESS_LEDGER_VERSION,
  buildAutonomyProgressLedger,
  buildNextActions,
  phaseProgressFromTools,
  validateAutonomyProgress,
};
