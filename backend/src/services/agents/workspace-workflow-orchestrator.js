'use strict';

/**
 * workspace-workflow-orchestrator — Replit/Cursor-style durable chained runs.
 */

const crypto = require('crypto');
const { buildAgentTaskPlan } = require('./agent-task-plan');
const { buildExecutionProfile, buildExecutionProfilePrompt } = require('./agentic-execution-profile');
const { buildUserIntentAlignmentProfile, buildUserIntentAlignmentPrompt } = require('./user-intent-alignment');
const { buildDocumentDeliveryPolicy } = require('./document-delivery-policy');

const WORKFLOW_VERSION = 'workspace-workflow-2026-05';
const DEFAULT_MAX_RUNTIME_MS = 20 * 60 * 60 * 1000;
const MIN_RUNTIME_MS = 60 * 60 * 1000;
const MAX_RUNTIME_MS = 20 * 60 * 60 * 1000;
const DEFAULT_MODEL = process.env.SIRAGPT_WORKSPACE_ORCHESTRATOR_MODEL || 'claude-opus-4-20250514';
const DEFAULT_MAX_STEPS = 120;

function clampRuntimeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_RUNTIME_MS;
  return Math.min(MAX_RUNTIME_MS, Math.max(MIN_RUNTIME_MS, Math.floor(n)));
}

function buildOrchestratorContract({ goal, plan, subTasks, maxRuntimeMs, model }) {
  const phaseLines = (plan?.phases || []).map((p, i) => `${i + 1}. [${p.id}] ${p.objective}`);
  const chainLines = subTasks.map((t, i) => `${i + 1}. ${t.goal}`);
  return [
    'WORKSPACE ORCHESTRATOR CONTRACT',
    `version: ${WORKFLOW_VERSION}`,
    `orchestrator_model: ${model}`,
    `runtime_budget_ms: ${maxRuntimeMs}`,
    '',
    'You are the internal workspace orchestrator. Execute the FULL workflow sequentially.',
    'Do not stop after a single phase unless the user goal is fully satisfied or a hard blocker is documented.',
    'Prefer tool calls over prose. Checkpoint progress after each phase.',
    '',
    'USER GOAL:',
    goal,
    '',
    'PLAN PHASES:',
    phaseLines.length ? phaseLines.join('\n') : '(single-phase run)',
    '',
    'CHAIN SUB-TASKS:',
    chainLines.length ? chainLines.join('\n') : goal,
    '',
    'RULES:',
    '- Treat each sub-task output as context for the next step.',
    '- On transient errors, retry with backoff before escalating.',
    '- Persist artifacts via task tools when files are requested.',
    '- Emit concise status before major transitions.',
  ].join('\n');
}

function planToSubTasks(plan, goal) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  if (!phases.length) {
    return [{ goal, phaseId: 'main' }];
  }
  return phases.map((phase) => ({
    phaseId: phase.id,
    goal: `[${phase.id}] ${phase.objective}`,
    role: phase.role,
  }));
}

/**
 * Build queue payload + snapshot for POST /api/agent/workspace-workflow.
 */
function buildWorkspaceWorkflowJob(params = {}) {
  const goal = String(params.goal || '').trim();
  if (!goal) {
    return { ok: false, error: 'goal is required' };
  }

  const userId = params.user?.id || params.user?.userId;
  if (!userId) {
    return { ok: false, error: 'authenticated user required' };
  }

  const maxRuntimeMs = clampRuntimeMs(params.maxRuntimeMs);
  const model = String(params.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const maxSteps = Number.isFinite(Number(params.maxSteps))
    ? Math.min(200, Math.max(10, Number(params.maxSteps)))
    : DEFAULT_MAX_STEPS;

  const fileIds = Array.isArray(params.fileIds)
    ? params.fileIds.map(String).filter(Boolean).slice(0, 20)
    : [];

  const executionProfile = buildExecutionProfile({ goal, fileIds });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ goal, executionProfile });

  const plan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    fileIds,
    maxRuntimeMs,
  });

  const subTasks = planToSubTasks(plan, goal);
  const systemContract = [
    buildExecutionProfilePrompt(executionProfile),
    buildUserIntentAlignmentPrompt(intentAlignmentProfile),
    buildOrchestratorContract({ goal, plan, subTasks, maxRuntimeMs, model }),
  ].join('\n\n');

  const displayGoal = `Workflow: ${goal.slice(0, 240)}`;
  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const chatId = typeof params.chatId === 'string' ? params.chatId : null;

  const documentPolicy = buildDocumentDeliveryPolicy({
    goal,
    displayGoal,
    files: fileIds,
  });

  const payload = {
    taskId,
    traceId,
    user: { id: userId, email: params.user?.email },
    goal,
    displayGoal,
    systemContract,
    files: fileIds,
    fileMetadata: params.fileMetadata || [],
    chatId,
    model,
    maxSteps,
    maxRuntimeMs,
    documentPolicy,
    executionProfile,
    intentAlignmentProfile,
    taskPlan: plan,
    workflow: {
      version: WORKFLOW_VERSION,
      pattern: 'chain',
      subTasks,
      orchestratorModel: model,
    },
  };

  return {
    ok: true,
    taskId,
    traceId,
    payload,
    plan,
    subTasks,
    maxRuntimeMs,
    model,
    displayGoal,
    documentPolicy,
  };
}

module.exports = {
  buildWorkspaceWorkflowJob,
  WORKFLOW_VERSION,
  DEFAULT_MAX_RUNTIME_MS,
  MAX_RUNTIME_MS,
  DEFAULT_MODEL,
};
