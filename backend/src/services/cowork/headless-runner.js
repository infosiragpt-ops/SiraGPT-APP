'use strict';

const OpenAI = require('openai');
const controlPlane = require('./control-plane');
const { inferProviderFromModelId } = require('../ai/provider-inference');
const {
  createInstrumentedCerebrasClient,
  getCerebrasConfig,
} = require('../ai/cerebras-client');

const THINKING_LEVELS = new Set(['low', 'medium', 'high']);

function normalizeThinking(value) {
  const normalized = String(value || 'low').trim().toLowerCase();
  return THINKING_LEVELS.has(normalized) ? normalized : 'low';
}

function resolveHeadlessRuntime({ model = null, client = null, provider = null } = {}) {
  if (client && model) {
    return {
      client,
      model: String(model),
      provider: provider || inferProviderFromModelId(model),
    };
  }

  const configuredModel = String(model || process.env.SIRAGPT_COWORK_HEADLESS_MODEL || '').trim();
  const inferred = provider || (configuredModel ? inferProviderFromModelId(configuredModel) : null);
  if (configuredModel && inferred === 'Cerebras') {
    const cerebras = createInstrumentedCerebrasClient();
    if (cerebras) return { client: cerebras, model: configuredModel, provider: 'Cerebras' };
  }
  if (!configuredModel) {
    const fallback = getCerebrasConfig();
    const cerebras = fallback.enabled ? createInstrumentedCerebrasClient() : null;
    if (cerebras) return { client: cerebras, model: fallback.model, provider: fallback.provider };
  }

  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('No provider is configured for Cowork headless tasks.');
    error.code = 'cowork_headless_provider_unavailable';
    throw error;
  }
  return {
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    model: configuredModel && inferred === 'OpenAI' ? configuredModel : 'gpt-4o-mini',
    provider: 'OpenAI',
  };
}

async function runCoworkHeadless(prisma, {
  run,
  chatId,
  prompt,
  source,
  model = null,
  client = null,
  provider = null,
  thinking = 'low',
  onEvent = null,
  maxRuntimeMs = 30 * 60 * 1000,
  resumeCheckpoint = null,
}) {
  if (!run?.id || !run?.userId || !run?.workspaceId) {
    const error = new Error('A persisted Cowork run with a workspace is required.');
    error.code = 'cowork_headless_context_invalid';
    throw error;
  }
  const runtime = resolveHeadlessRuntime({ model, client, provider });
  const { runAgent } = require('../agents/agent-entry');
  return runAgent({
    userId: run.userId,
    prompt,
    thinking: normalizeThinking(thinking),
    mode: 'sandbox',
    source: source || `cowork-headless:${run.id}`,
    maxSteps: run.maxSteps,
    maxRuntimeMs,
    model: runtime.model,
    provider: runtime.provider,
    openai: runtime.client,
    prisma,
    chatId,
    workspaceId: run.workspaceId,
    coworkRunId: run.id,
    attachCoworkHarness: true,
    onEvent,
    toolContext: {
      prisma,
      userId: run.userId,
      chatId,
      workspaceId: run.workspaceId,
      coworkWorkspaceId: run.workspaceId,
      coworkRunId: run.id,
      onEvent,
    },
    extraSystem: [
      'You are running as a headless Cowork task.',
      'Work inside the mounted versioned workspace and deliver files there.',
      'Use update_checklist for multi-step work and verify deliverables before finalizing.',
      'Use workspace_memory for stable project decisions and never store secrets there.',
    ].join('\n'),
    onBeforeStep: ({ step }) => controlPlane.beforeStep(prisma, {
      runId: run.id,
      userId: run.userId,
      step,
      onEvent,
    }),
    onStepDone: (stepRecord) => controlPlane.recordStep(prisma, {
      runId: run.id,
      userId: run.userId,
      step: Number(stepRecord?.step) + 1,
      tokensEstimate: stepRecord?.usage?.tokensEstimate || 0,
      costUsd: stepRecord?.usage?.costUsd || 0,
      event: `Completed headless step ${Number(stepRecord?.step) + 1}`,
    }),
    onCheckpoint: (checkpoint) => controlPlane.saveCheckpoint(prisma, {
      runId: run.id,
      userId: run.userId,
      checkpoint,
    }),
    resumeCheckpoint,
  });
}

function terminalStatus(stoppedReason) {
  const reason = String(stoppedReason || 'finalized');
  if (/cancel|abort|budget_exhausted|max_steps/i.test(reason)) return 'cancelled';
  if (/error|failed|control_plane_error/i.test(reason)) return 'failed';
  return 'completed';
}

async function resumeCoworkRun(prisma, {
  runId,
  userId,
  onEvent = null,
}) {
  let run = await controlPlane.getOwnedRun(prisma, { runId, userId });
  if (!run.checkpoint || typeof run.checkpoint !== 'object') {
    const error = new Error('This task has no durable checkpoint to resume.');
    error.code = 'cowork_checkpoint_unavailable';
    error.status = 409;
    throw error;
  }
  if (!run.chatId || !run.workspaceId) {
    const error = new Error('The task no longer has a chat and workspace.');
    error.code = 'cowork_resume_context_invalid';
    error.status = 409;
    throw error;
  }
  if (run.status === 'paused') {
    run = await controlPlane.transitionRun(prisma, {
      runId: run.id,
      userId,
      action: 'resume',
    });
  } else if (run.status !== 'running') {
    const error = new Error(`Cannot resume a ${run.status} task.`);
    error.code = 'cowork_transition_invalid';
    error.status = 409;
    throw error;
  }

  try {
    const result = await runCoworkHeadless(prisma, {
      run,
      chatId: run.chatId,
      prompt: run.prompt,
      source: `cowork-resume:${run.id}`,
      onEvent,
      resumeCheckpoint: run.checkpoint,
    });
    const answer = String(result?.answer || '').trim();
    if (answer) {
      await prisma.message.create({
        data: {
          chatId: run.chatId,
          role: 'ASSISTANT',
          content: answer,
          metadata: {
            coworkRunId: run.id,
            resumedFromCheckpoint: true,
            stoppedReason: result?.stoppedReason || null,
          },
        },
      });
    }
    const status = terminalStatus(result?.stoppedReason);
    await controlPlane.finishRun(prisma, {
      runId: run.id,
      userId,
      status,
      lastEvent: `Resumed task ${status}: ${String(result?.stoppedReason || 'finalized')}`,
    });
    return { runId: run.id, status, answer, stoppedReason: result?.stoppedReason || null };
  } catch (error) {
    await controlPlane.finishRun(prisma, {
      runId: run.id,
      userId,
      status: 'failed',
      lastEvent: `Checkpoint resume failed: ${error.message}`,
    }).catch(() => {});
    throw error;
  }
}

module.exports = {
  normalizeThinking,
  resolveHeadlessRuntime,
  runCoworkHeadless,
  resumeCoworkRun,
  terminalStatus,
};
