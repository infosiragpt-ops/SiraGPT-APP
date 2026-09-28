'use strict';

// Document follow-up P1-4 on /api/agent/task: when the UI asks to edit the
// chat's latest file (preferRecentArtifact) and the quick editor finds no
// base or cannot plan the edit, the AgentRunner edits that artifact instead
// of a fresh document being generated in its place. When the runner cannot,
// the task ends with an honest error — never a new document.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const agentRunner = require('../src/services/agent-runner');
const sourcePreserving = require('../src/services/source-preserving-document-edit');

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function clearAgentModules() {
  for (const modulePath of [
    '../src/services/agents/agent-task-runner',
    '../src/services/agents/task-store',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch { /* ignore */ }
  }
}

async function withRecentArtifactEnv({ label, runnerOverrides, quickEdit, reactRun }, fn) {
  const restoreEnv = rememberEnv([
    'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV',
    'AGENT_TASK_AGENT_RUNNER', 'AGENT_TASK_MODEL_FAILOVER', 'AGENT_TASK_LLM_RECOVERY',
  ]);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), `siragpt-p14-${label}-`));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  delete process.env.OPENROUTER_API_KEY;
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_AGENT_RUNNER = '1';
  process.env.AGENT_TASK_MODEL_FAILOVER = '0';
  process.env.AGENT_TASK_LLM_RECOVERY = '0';
  clearAgentModules();

  const originalQuickEdit = sourcePreserving.tryGenerateSourcePreservingDocumentEdit;
  sourcePreserving.tryGenerateSourcePreservingDocumentEdit = quickEdit;
  const persistence = require('../src/services/agents/agent-task-persistence');
  const reactAgent = require('../src/services/react-agent');
  const taskContractResolver = require('../src/services/agents/task-contract-resolver');
  const autoDocument = require('../src/services/agents/auto-document-delivery');
  const original = {
    upsert: persistence.upsertAgentTask,
    append: persistence.appendAgentTaskEvent,
    artifact: persistence.persistGeneratedArtifact,
    run: reactAgent.run,
    resolve: taskContractResolver.resolveTaskContract,
    generate: autoDocument.generateAutoDocument,
  };
  const counters = { genericPipeline: 0, react: 0 };
  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  autoDocument.generateAutoDocument = async () => {
    counters.genericPipeline += 1;
    throw new Error('a fresh document must never replace the edit of the latest file');
  };
  reactAgent.run = async (...args) => {
    counters.react += 1;
    return reactRun(...args);
  };

  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === '../agent-runner' || request.endsWith('/agent-runner')) {
      return { ...agentRunner, ...runnerOverrides };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    await fn({ runAgentTaskJob, taskStore, counters });
  } finally {
    Module._load = originalLoad;
    sourcePreserving.tryGenerateSourcePreservingDocumentEdit = originalQuickEdit;
    persistence.upsertAgentTask = original.upsert;
    persistence.appendAgentTaskEvent = original.append;
    persistence.persistGeneratedArtifact = original.artifact;
    reactAgent.run = original.run;
    taskContractResolver.resolveTaskContract = original.resolve;
    autoDocument.generateAutoDocument = original.generate;
    fs.rmSync(storeDir, { recursive: true, force: true });
    clearAgentModules();
    restoreEnv();
  }
}

const GOAL = 'en la misma ppt puede agregarle un poco mas de diseño';

function payload(taskId) {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    user: { id: `user-${taskId}`, email: 'p14@example.com' },
    goal: GOAL,
    displayGoal: GOAL,
    files: [],
    fileMetadata: [],
    preferRecentArtifact: true,
    chatId: `chat-${taskId}`,
    model: 'gpt-4o',
    documentPolicy: { mode: 'doc_required', format: 'pptx', autoGenerate: true },
    maxSteps: 4,
    maxRuntimeMs: 60_000,
  };
}

const DECK = {
  id: 'art-p14-v2',
  filename: 'gestion-administrativa-v2.pptx',
  format: 'pptx',
  mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  sizeBytes: 4321,
  downloadUrl: '/api/agent/artifact/art-p14-v2',
};

test('isRecentArtifactEditTurn: edits and design upgrades yes, a new document or small talk no', () => {
  clearAgentModules();
  const { isRecentArtifactEditTurn } = require('../src/services/agents/agent-task-runner');
  assert.equal(isRecentArtifactEditTurn(GOAL, [], 'pptx'), true);
  assert.equal(isRecentArtifactEditTurn('hazla más profesional', [], 'pptx'), true);
  assert.equal(isRecentArtifactEditTurn('agrégale una lámina de conclusiones a la ppt', [], 'pptx'), true);
  assert.equal(isRecentArtifactEditTurn('crea una ppt sobre el ciclo del agua', [], 'pptx'), false);
  assert.equal(isRecentArtifactEditTurn('hola', [], 'pptx'), false);
  assert.equal(isRecentArtifactEditTurn('', [], 'pptx'), false);
});

test('quick editor without a base → the AgentRunner edits the latest file (no fresh document)', async () => {
  const runnerCalls = [];
  const priorFormatSeen = [];
  await withRecentArtifactEnv({
    label: 'runner-edits',
    quickEdit: async () => null,
    reactRun: async () => ({ finalAnswer: 'no debería correr', steps: [], stoppedReason: 'completed' }),
    runnerOverrides: {
      hasConversationArtifacts: async () => true,
      getConversationArtifactFormat: async () => 'pptx',
      // Not claimed by the preloop gate: the P1-4 fallback must invoke it.
      shouldRunAgentRunner: (args) => { priorFormatSeen.push(args.priorArtifactFormat); return false; },
      executeAgentRunnerTurn: async (params) => {
        runnerCalls.push(params);
        params.onEvent({ type: 'file_artifact', artifact: DECK });
        return { ok: true, summary: 'Listo: rediseñé gestion-administrativa-v2.pptx.', artifacts: [DECK], steps: [], stoppedReason: 'agent_runner' };
      },
    },
  }, async ({ runAgentTaskJob, taskStore, counters }) => {
    const result = await runAgentTaskJob(payload('task-p14-edit-1'));
    const snapshot = taskStore.getTaskSnapshotForUser('task-p14-edit-1', 'user-task-p14-edit-1');
    assert.deepEqual(priorFormatSeen, ['pptx'], 'the gate receives the prior artifact format');
    assert.equal(runnerCalls.length, 1);
    assert.equal(runnerCalls[0].instruction, GOAL);
    assert.equal(runnerCalls[0].chatId, 'chat-task-p14-edit-1');
    assert.equal(result.status, 'completed');
    assert.equal(snapshot.streamState.stoppedReason, 'agent_runner');
    assert.equal(snapshot.streamState.artifacts[0].filename, 'gestion-administrativa-v2.pptx');
    assert.equal(counters.genericPipeline, 0);
    assert.equal(counters.react, 0);
  });
});

test('the runner cannot edit the latest file → honest error, never a new document', async () => {
  let runnerCalls = 0;
  await withRecentArtifactEnv({
    label: 'runner-fails',
    quickEdit: async () => null,
    reactRun: async () => ({ finalAnswer: 'no debería correr', steps: [], stoppedReason: 'completed' }),
    runnerOverrides: {
      hasConversationArtifacts: async () => true,
      getConversationArtifactFormat: async () => 'pptx',
      shouldRunAgentRunner: () => false,
      executeAgentRunnerTurn: async () => {
        runnerCalls += 1;
        return {
          ok: false,
          skipped: false,
          summary: '',
          artifacts: [],
          steps: [],
          stoppedReason: 'E_PROVIDER',
          errorMessage: 'El proveedor del modelo seleccionado (DeepSeek V4 Flash) no tiene saldo en este momento. No cambié de modelo: elige otro o vuelve a intentarlo más tarde.',
        };
      },
    },
  }, async ({ runAgentTaskJob, taskStore, counters }) => {
    const result = await runAgentTaskJob(payload('task-p14-fail-1'));
    const snapshot = taskStore.getTaskSnapshotForUser('task-p14-fail-1', 'user-task-p14-fail-1');
    assert.equal(runnerCalls, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.artifacts, 0);
    assert.equal(snapshot.streamState.stoppedReason, 'agent_runner_failed');
    assert.match(snapshot.streamState.finalText, /^No pude generar el documento\. El proveedor del modelo seleccionado \(DeepSeek V4 Flash\) no tiene saldo/);
    assert.doesNotMatch(snapshot.streamState.finalText, /E_PROVIDER/);
    assert.equal(counters.genericPipeline, 0);
    assert.equal(counters.react, 0);
  });
});

test('a runner already tried by the preloop is not re-run; the task still never regenerates', async () => {
  let runnerCalls = 0;
  await withRecentArtifactEnv({
    label: 'claimed-then-null',
    quickEdit: async () => null,
    reactRun: async () => ({ finalAnswer: 'no debería correr', steps: [], stoppedReason: 'completed' }),
    runnerOverrides: {
      hasConversationArtifacts: async () => true,
      getConversationArtifactFormat: async () => 'pptx',
      shouldRunAgentRunner: () => true,
      isRunnerOnlyDocumentTurn: () => false,
      executeAgentRunnerTurn: async () => {
        runnerCalls += 1;
        return { ok: false, skipped: false, summary: '', artifacts: [], steps: [], stoppedReason: 'no_output', errorMessage: null };
      },
    },
  }, async ({ runAgentTaskJob, taskStore, counters }) => {
    const result = await runAgentTaskJob(payload('task-p14-claimed-1'));
    const snapshot = taskStore.getTaskSnapshotForUser('task-p14-claimed-1', 'user-task-p14-claimed-1');
    assert.equal(runnerCalls, 1, 'one runner attempt per turn');
    assert.equal(result.status, 'failed');
    assert.equal(snapshot.streamState.stoppedReason, 'agent_runner_failed');
    assert.equal(counters.genericPipeline, 0);
    assert.equal(counters.react, 0);
  });
});

test('a prior html page is not an Office edit target: the existing fresh-document path is kept', async () => {
  let runnerCalls = 0;
  await withRecentArtifactEnv({
    label: 'html-prior',
    quickEdit: async () => null,
    reactRun: async () => ({ finalAnswer: 'Actualicé la página según lo pedido.', steps: [], stoppedReason: 'completed' }),
    runnerOverrides: {
      hasConversationArtifacts: async () => true,
      getConversationArtifactFormat: async () => 'html',
      shouldRunAgentRunner: () => false,
      executeAgentRunnerTurn: async () => { runnerCalls += 1; return { ok: false, artifacts: [], stoppedReason: 'no_output' }; },
    },
  }, async ({ runAgentTaskJob }) => {
    await runAgentTaskJob({ ...payload('task-p14-html-1'), documentPolicy: { mode: 'chat_only', autoGenerate: false } });
    assert.equal(runnerCalls, 0);
  });
});
