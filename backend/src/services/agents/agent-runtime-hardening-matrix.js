'use strict';

const MATRIX_VERSION = 'agent-runtime-hardening-matrix-2026-06';

const AGENT_RUNTIME_PATTERNS = [
  /\b(agente(?:s)?|agent(?:s)?|agentic|aut[oó]nom[oa]s?|autonomous)\b/i,
  /\b(plan(?:es|ner|ificador)?|runner|ejecutor|orquestador|orchestrator|workflow|tool(?:s)?|herramientas?)\b/i,
  /\b(agent-task|task\s+runner|tool\s+registry|capability\s+matrix|skill(?:s)?|checkpoint(?:s)?)\b/i,
];

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function hasAgentRuntimeIntent(goal) {
  const raw = String(goal || '');
  const normalized = normalize(raw);
  return AGENT_RUNTIME_PATTERNS.some((rx) => rx.test(raw) || rx.test(normalized));
}

function buildLane({ id, priority, objective, evidence, tests = [], risk = null }) {
  return {
    id,
    priority,
    objective,
    expectedEvidence: evidence,
    recommendedTests: unique(tests),
    risk,
  };
}

function buildAgentRuntimeHardeningMatrix({
  goal = '',
  executionProfile = null,
  openclawProfile = null,
  toolManifests = [],
} = {}) {
  const capabilities = executionProfile?.capabilities || {};
  const signals = openclawProfile?.signals || {};
  const openclawCapabilities = openclawProfile?.capabilities || {};
  const agentRuntimeIntent = hasAgentRuntimeIntent(goal);
  const active = Boolean(
    agentRuntimeIntent
    || capabilities.needsAgentRuntimeHardening
    || capabilities.needsAutonomousSoftware
    || signals.wantsAutonomousAgent
    || signals.externalRepoAdaptation
    || signals.nativeRewriteRequired
    || openclawCapabilities.nativeRepoAdaptation
  );

  if (!active) {
    return {
      version: MATRIX_VERSION,
      active: false,
      reason: 'no_agent_runtime_hardening_intent',
      lanes: [],
      recommendedTests: [],
      verificationGates: [],
      maturityScore: 0,
    };
  }

  const manifestNames = unique(toolManifests.map((manifest) => manifest?.name || manifest));
  const lanes = [
    buildLane({
      id: 'intent_and_plan_contracts',
      priority: 'high',
      objective: 'Classify agent work as a durable plan-execute-verify task, not a plain chat answer.',
      evidence: 'Task plan includes agent runtime diagnostics and explicit success criteria.',
      tests: ['backend/tests/agent-task-plan.test.js', 'backend/tests/agentic-execution-profile.test.js'],
      risk: 'Agent requests can be answered as promises instead of executed work.',
    }),
    buildLane({
      id: 'tool_gate_integrity',
      priority: 'high',
      objective: 'Ensure required agent tools are declared, callable, and enforced before finalization.',
      evidence: 'Finalize gates include run_tests and any contract-required executable tools.',
      tests: ['backend/tests/openclaw-autonomy-finalize-guard.test.js', 'backend/tests/agents-executor.test.js'],
      risk: 'A missing tool gate lets the agent claim software changes without deterministic evidence.',
    }),
    buildLane({
      id: 'durable_state_and_recovery',
      priority: signals.likelyLongRunning || openclawCapabilities.autonomousExecution ? 'high' : 'medium',
      objective: 'Persist task plan, checkpoints, unavailable tools, and recovery context for long-running work.',
      evidence: 'Task snapshots store plan/runtime profiles and can recover after queue or worker interruption.',
      tests: ['backend/tests/agent-task-store.test.js', 'backend/tests/agent-task-boot-recovery.test.js'],
      risk: 'Autonomous tasks lose progress or repeat unsafe actions after interruption.',
    }),
    buildLane({
      id: 'verification_and_regression_loop',
      priority: 'high',
      objective: 'Run targeted tests or invariants for every activated backend/runtime slice.',
      evidence: 'The latest task evidence includes passing focused tests for changed agent modules.',
      tests: ['backend/tests/agentic-execution-profile.test.js', 'backend/tests/agent-task-runner-branches.test.js'],
      risk: 'Agent capabilities expand without proving the execution path still works.',
    }),
  ];

  if (signals.externalRepoAdaptation || signals.nativeRewriteRequired || capabilities.needsExternalRepoAdaptation) {
    lanes.push(buildLane({
      id: 'external_reference_boundary',
      priority: 'high',
      objective: 'Keep OpenClaw or other upstream code as attributed reference material while activating only SiraGPT-owned rewrites.',
      evidence: 'Integration map, reference-only source signal, and focused tests exist for activated slices.',
      tests: ['backend/tests/openclaw-playbook-bridge.test.js', 'backend/tests/openclaw-source-inventory.test.js'],
      risk: 'Foreign runtime code, credentials, or maintainer assumptions leak into production paths.',
    }));
  }

  if (signals.massiveSourceFusion || capabilities.needsBulkSourceFusion) {
    lanes.push(buildLane({
      id: 'bulk_activation_budget',
      priority: 'high',
      objective: 'Rank large source-fusion slices and activate only reviewed, testable backend behavior.',
      evidence: 'Source inventory records license, owners, side effects, blocked surfaces, and activation budget.',
      tests: ['backend/tests/openclaw-source-inventory.test.js', 'backend/tests/openclaw-execution-dossier.test.js'],
      risk: 'Million-line imports create unreviewable behavior and CI instability.',
    }));
  }

  const verificationGates = [
    'Inspect the relevant agent service before editing.',
    'Run focused agent tests for every changed runtime slice.',
    'Keep UI files unchanged unless the user explicitly asks for interface work.',
    'Report residual risk only from observed test/tool output.',
  ];

  if (manifestNames.length) {
    verificationGates.push(`Tool manifest coverage observed: ${manifestNames.slice(0, 12).join(', ')}.`);
  }

  const recommendedTests = unique(lanes.flatMap((lane) => lane.recommendedTests));
  const maturityScore = Math.min(100, 40 + lanes.length * 10 + (manifestNames.length ? 10 : 0));

  return {
    version: MATRIX_VERSION,
    active: true,
    reason: agentRuntimeIntent ? 'agent_runtime_intent_detected' : 'agent_runtime_profile_signal_detected',
    lanes,
    recommendedTests,
    verificationGates,
    maturityScore,
  };
}

function buildAgentRuntimeHardeningPromptBlock(matrix) {
  if (!matrix?.active) return '';
  const lanes = (matrix.lanes || [])
    .map((lane, index) => `${index + 1}. ${lane.priority}/${lane.id}: ${lane.objective} Evidence: ${lane.expectedEvidence}`)
    .join('\n');
  const gates = (matrix.verificationGates || [])
    .map((gate, index) => `${index + 1}. ${gate}`)
    .join('\n');
  return [
    `Agent runtime hardening matrix: ${matrix.version}`,
    `reason=${matrix.reason} maturity_score=${matrix.maturityScore}`,
    'Hardening lanes:',
    lanes || 'No lanes generated.',
    'Verification gates:',
    gates || 'No gates generated.',
  ].join('\n');
}

module.exports = {
  MATRIX_VERSION,
  buildAgentRuntimeHardeningMatrix,
  buildAgentRuntimeHardeningPromptBlock,
  hasAgentRuntimeIntent,
};
