'use strict';

const crypto = require('crypto');
const { buildAgentTaskPlan } = require('../agents/agent-task-plan');
const { buildExecutionProfile } = require('../agents/agentic-execution-profile');
const { buildUserIntentAlignmentProfile } = require('../agents/user-intent-alignment');
const codexRunStore = require('./codex-run-store');
const streamCache = require('../stream-cache');

const PHASES = ['plan', 'execute', 'verify', 'ship'];

function detectCodeTaskIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return { isCodeTask: false, confidence: 0 };
  const patterns = [
    /\b(fix|refactor|implement|debug|bug|pull request|commit|github|codex|cursor|npm test|eslint)\b/i,
    /\b(creates?|write|genera|implementa).{0,40}\b(api|endpoint|component|funci[oó]n|script|module|class)\b/i,
    /\b(push|merge|deploy|ci)\b/i,
  ];
  const hits = patterns.filter((re) => re.test(t)).length;
  if (hits >= 2) return { isCodeTask: true, confidence: 0.9 };
  if (hits === 1) return { isCodeTask: true, confidence: 0.75 };
  return { isCodeTask: false, confidence: 0 };
}

function createRunRecord(params = {}) {
  const runId = params.runId || crypto.randomUUID();
  return codexRunStore.writeRun({
    runId,
    userId: params.userId,
    chatId: params.chatId || null,
    goal: params.goal,
    repository: params.repository || null,
    branch: params.branch || 'main',
    status: 'queued',
    phase: 'plan',
    percent: 0,
    taskId: params.taskId || null,
    events: [{ type: 'run_created', goal: params.goal }],
  });
}

async function touchStreamProgress(userId, chatId, progress) {
  if (!userId || !chatId) return;
  try {
    await streamCache.updateAgentProgress(userId, chatId, progress);
  } catch {
    /* best-effort */
  }
}

async function runCodexPipeline(params = {}, deps = {}) {
  const {
    runId,
    userId,
    chatId,
    goal,
    repository = null,
    branch = 'main',
    taskId = null,
    onEvent = null,
  } = params;

  const emit = (event) => {
    codexRunStore.appendEvent(runId, event);
    if (typeof onEvent === 'function') onEvent(event);
  };

  const setPhase = async (phase, percent, extra = {}) => {
    codexRunStore.updateRun(runId, { phase, percent, status: 'running', ...extra });
    await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase, percent });
    emit({ type: 'phase', phase, percent, ...extra });
  };

  try {
    await setPhase('plan', 5);
    const executionProfile = buildExecutionProfile({ goal, fileIds: [] });
    const intentAlignmentProfile = buildUserIntentAlignmentProfile({ goal, executionProfile });
    const plan = buildAgentTaskPlan({
      goal,
      executionProfile,
      intentAlignmentProfile,
      fileIds: [],
      maxRuntimeMs: params.maxRuntimeMs || 2 * 60 * 60 * 1000,
    });
    emit({ type: 'plan', plan });

    await setPhase('execute', 35);
    const runner = deps.runAgentTaskJob || null;
    if (typeof runner === 'function' && taskId) {
      await runner({
        taskId,
        user: { id: userId },
        goal,
        chatId,
        model: params.model || 'gpt-4o',
      });
    } else {
      emit({ type: 'execute_skipped', reason: 'no_task_runner' });
    }

    await setPhase('verify', 65);
    const sandbox = deps.runVerification || null;
    if (typeof sandbox === 'function') {
      const verify = await sandbox({ goal });
      emit({ type: 'verify', ok: verify?.ok !== false, detail: verify });
    } else {
      emit({ type: 'verify_skipped', reason: 'no_sandbox' });
    }

    await setPhase('ship', 85);
    const github = deps.githubConnector || null;
    if (repository && typeof github === 'object') {
      if (typeof github.createBranch === 'function') {
        const branchName = `codex/${runId.slice(0, 8)}`;
        await github.createBranch({ repository, baseBranch: branch, branchName });
        emit({ type: 'branch', branch: branchName });
      }
      if (typeof github.openPullRequest === 'function') {
        const pr = await github.openPullRequest({
          repository,
          title: `Codex: ${goal.slice(0, 72)}`,
          body: `Automated Codex run ${runId}`,
          head: `codex/${runId.slice(0, 8)}`,
          base: branch,
        });
        codexRunStore.updateRun(runId, { prUrl: pr?.url || null });
        emit({ type: 'pr_url', url: pr?.url || null });
      }
      if (typeof github.watchWorkflowRun === 'function') {
        const ci = await github.watchWorkflowRun({ repository, branch, timeoutMs: 120_000 });
        codexRunStore.updateRun(runId, { ciRunId: ci?.runId || null });
        emit({ type: 'ci_status', status: ci?.status || 'unknown', conclusion: ci?.conclusion || null });
      }
    } else {
      emit({ type: 'ship_skipped', reason: repository ? 'no_github_connector' : 'no_repository' });
    }

    codexRunStore.updateRun(runId, { status: 'completed', phase: 'done', percent: 100 });
    await touchStreamProgress(userId, chatId, { taskId: taskId || runId, phase: 'done', percent: 100 });
    emit({ type: 'done', runId });
    return codexRunStore.readRun(runId);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    codexRunStore.updateRun(runId, { status: 'failed', error: message, percent: 100 });
    emit({ type: 'error', message });
    throw err;
  }
}

function enqueueCodexRun(params = {}, deps = {}) {
  const record = createRunRecord(params);
  setImmediate(() => {
    runCodexPipeline({ ...params, runId: record.runId }, deps).catch(() => {});
  });
  return record;
}

module.exports = {
  PHASES,
  detectCodeTaskIntent,
  createRunRecord,
  runCodexPipeline,
  enqueueCodexRun,
};
