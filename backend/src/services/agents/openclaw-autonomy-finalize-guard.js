'use strict';

const {
  successfulToolCalls,
  validateFinalize,
} = require('./agentic-execution-profile');
const {
  validateAutonomyProgress,
} = require('./agent-autonomy-progress-ledger');
const openclawCapabilityKernel = require('../openclaw-capability-kernel');

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function isOpenClawAutonomyActive(summary) {
  if (!summary || typeof summary !== 'object') return false;
  const signals = summary.signals || {};
  const capabilities = summary.capabilities || {};
  return Boolean(
    signals.externalRepoAdaptation
    || signals.wantsAutonomousAgent
    || signals.nativeRewriteRequired
    || capabilities.nativeRepoAdaptation
  );
}

function validateOpenClawAutonomyFinalize(openclawRuntimeProfile, {
  steps = [],
  unavailableTools = [],
} = {}) {
  const summary = openclawCapabilityKernel.buildOpenClawRuntimeSummary(openclawRuntimeProfile);
  if (!isOpenClawAutonomyActive(summary)) {
    return { ok: true, active: false };
  }

  const unavailable = new Set((Array.isArray(unavailableTools) ? unavailableTools : []).map(String));
  const counts = successfulToolCalls(steps);
  const successfulTools = Array.from(counts.entries())
    .filter(([, count]) => Number(count) > 0)
    .map(([tool]) => tool);
  const nonFinalizeTools = successfulTools.filter((tool) => tool !== 'finalize');
  const signals = summary.signals || {};
  const requiresTests = Boolean(
    signals.externalRepoAdaptation
    || signals.wantsAutonomousAgent
    || signals.massiveSourceFusion
    || signals.nativeRewriteRequired
  );

  if (nonFinalizeTools.length === 0 && unavailable.size === 0) {
    return {
      ok: false,
      active: true,
      missingTools: ['runtime_evidence'],
      requiredTools: requiresTests ? ['run_tests'] : [],
      message: 'Finalization blocked by OpenClaw autonomy gates. No successful tool evidence was recorded before finalize.',
      repairInstructions: [
        'Do not claim autonomous execution from a plain answer.',
        'Inspect the repo or runtime state, execute the required verification tool, then call finalize again.',
      ].join(' '),
      repairActions: [{
        type: 'record_runtime_evidence',
        priority: 'critical',
        phaseId: null,
        tools: requiresTests ? ['run_tests'] : ['host_file'],
        reason: 'openclaw_runtime_evidence_required',
        checkpoint: null,
      }],
      summary,
    };
  }

  if (requiresTests && (counts.get('run_tests') || 0) < 1 && !unavailable.has('run_tests')) {
    return {
      ok: false,
      active: true,
      missingTools: ['run_tests'],
      requiredTools: ['run_tests'],
      successfulTools,
      message: 'Finalization blocked by OpenClaw autonomy gates. Autonomous software fusion requires a successful run_tests call or an explicit tool-unavailable waiver.',
      repairInstructions: [
        'Run deterministic tests or invariants for the native implementation.',
        'If the tests fail, repair and rerun before calling finalize.',
      ].join(' '),
      repairActions: [{
        type: 'complete_phase_evidence',
        priority: 'critical',
        phaseId: 'qa_tests',
        tools: ['run_tests'],
        reason: 'autonomous_fusion_tests_required',
        checkpoint: 'Deterministic runtime validation must pass before finalization.',
      }],
      summary,
    };
  }

  return {
    ok: true,
    active: true,
    successfulTools,
    degraded: unavailable.size > 0,
    unavailableTools: Array.from(unavailable),
    summary,
  };
}

function validateAgentTaskFinalize({
  finalizeProfile,
  openclawRuntimeProfile = null,
  taskPlan = null,
  steps = [],
  unavailableTools = [],
} = {}) {
  const base = validateFinalize(finalizeProfile || { requiredTools: [] }, steps, { unavailableTools });
  if (!base?.ok) return base;

  const openclawGuard = validateOpenClawAutonomyFinalize(openclawRuntimeProfile, {
    steps,
    unavailableTools,
  });
  if (!openclawGuard.ok) {
    return {
      ...openclawGuard,
      requiredTools: unique([...(base.requiredTools || []), ...(openclawGuard.requiredTools || [])]),
    };
  }

  const progressGuard = validateAutonomyProgress({
    taskPlan,
    steps,
    unavailableTools,
    openclawRuntimeSummary: openclawGuard.summary
      || openclawCapabilityKernel.buildOpenClawRuntimeSummary(openclawRuntimeProfile),
  });
  if (!progressGuard.ok) {
    return {
      ...progressGuard,
      requiredTools: unique([
        ...(base.requiredTools || []),
        ...(openclawGuard.requiredTools || []),
        ...(progressGuard.requiredTools || []),
      ]),
      autonomyProgress: progressGuard.ledger,
    };
  }

  return {
    ...base,
    openclawAutonomy: openclawGuard.active
      ? {
        active: true,
        degraded: Boolean(openclawGuard.degraded),
        successfulTools: openclawGuard.successfulTools || [],
        unavailableTools: openclawGuard.unavailableTools || [],
      }
      : { active: false },
    autonomyProgress: progressGuard.ledger,
  };
}

module.exports = {
  isOpenClawAutonomyActive,
  validateAgentTaskFinalize,
  validateOpenClawAutonomyFinalize,
};
