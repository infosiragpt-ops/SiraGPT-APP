'use strict';

/**
 * F2 — complete routing: the AgentRunner is the PRIMARY path on ALL
 * document entry points (chat, /api/doc/generate, /api/ai/generate gate,
 * /api/agent/task). These tests pin the F2 gate:
 *   - every create-ppt / style-follow-up phrase claims the runner;
 *   - a claimed failure NEVER reaches the generic advanced pipeline
 *     (generateAutoDocument) nor fabricates a new create_document stub;
 *   - non-document chat ("hola") never enters the runner;
 *   - the routing telemetry helper normalizes its records.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { PassThrough } = require('node:stream');

const agentRunner = require('../src/services/agent-runner');
const agenticStream = require('../src/services/agentic-chat-stream');
const { logDocumentRouting, DOCUMENT_ROUTING_PATHS } = require('../src/services/agent-runner/telemetry');

// ── Claim coverage: create-doc + style phrases route into the runner ────

const CREATE_DOC_PHRASES = [
  'crea una ppt del embarazo de color rosado la ppt',
  'crea una ppt del embarazo de color celeste',
  'créame una presentación de marketing digital',
  'genera un word del informe trimestral',
  'genera un excel de gastos mensuales',
  'hazme una presentación en powerpoint sobre ventas',
  'diseña una presentación de la empresa',
  'arma un documento word con el plan',
  'create a pptx about climate change',
];

const STYLE_FOLLOWUP_PHRASES = [
  'ponlas todas rosadas',
  'ponlas todas de color celeste',
  'uniformisa el color de la ppts todas de color blanco',
  'píntalas de verde',
  'cámbialas al hex #1E3A8A',
  'cambia el fondo a #FF00AA',
];

test('F2: every create-doc phrase claims the runner AND routes into the agentic chat', () => {
  for (const phrase of CREATE_DOC_PHRASES) {
    assert.equal(
      agentRunner.shouldRunAgentRunner({ text: phrase }),
      true,
      `shouldRunAgentRunner must claim: "${phrase}"`,
    );
    assert.equal(
      agentRunner.isRunnerOnlyDocumentTurn(phrase),
      true,
      `runner-only (honest error on failure): "${phrase}"`,
    );
    assert.equal(
      agenticStream.shouldUseAgenticChat({ prompt: phrase }),
      true,
      `shouldUseAgenticChat must route: "${phrase}"`,
    );
  }
});

test('F2: every style/color follow-up claims the runner AND routes into the agentic chat', () => {
  for (const phrase of STYLE_FOLLOWUP_PHRASES) {
    assert.equal(
      agentRunner.shouldRunAgentRunner({ text: phrase }),
      true,
      `shouldRunAgentRunner must claim: "${phrase}"`,
    );
    assert.equal(
      agentRunner.isRunnerOnlyDocumentTurn(phrase),
      true,
      `runner-only (honest error on failure): "${phrase}"`,
    );
    assert.equal(
      agenticStream.shouldUseAgenticChat({ prompt: phrase }),
      true,
      `shouldUseAgenticChat must route: "${phrase}"`,
    );
  }
});

test('F2: non-document chat never enters the runner nor claims the doc route', async () => {
  for (const phrase of ['hola', 'gracias!', '¿cuál es la capital de Francia?', 'escríbeme un poema sobre el mar']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ text: phrase }), false, `must NOT claim: "${phrase}"`);
  }
  assert.equal(agenticStream.shouldUseAgenticChat({ prompt: 'hola' }), false);
  const docRoute = await agentRunner.runAgentRunnerForDocRoute({
    prisma: { generatedArtifact: { findMany: async () => [] } },
    userId: 'u1',
    chatId: 'c1',
    prompt: 'hola, ¿cómo estás?',
    fileIds: [],
  });
  assert.equal(docRoute, null, 'non-claimed prompts leave the pipeline available');
});

// ── Telemetry helper ─────────────────────────────────────────────────────

test('F2: logDocumentRouting normalizes records and never throws', () => {
  assert.deepEqual(
    DOCUMENT_ROUTING_PATHS,
    ['agent_runner', 'agent_runner_failed', 'source_preserving_edit', 'advanced_pipeline', 'skipped'],
  );
  const ok = logDocumentRouting({ entry: 'chat', path: 'agent_runner', chatId: 'c1' });
  assert.equal(ok.entry, 'chat');
  assert.equal(ok.path, 'agent_runner');
  assert.equal(ok.chatId, 'c1');
  const unknown = logDocumentRouting({ entry: 'doc_generate', path: 'something_else', reason: 'x'.repeat(500) });
  assert.equal(unknown.path, 'skipped', 'unknown paths collapse to skipped');
  assert.ok(unknown.reason.length <= 120);
  const bare = logDocumentRouting({});
  assert.equal(bare.entry, 'unknown');
  assert.equal(bare.path, 'skipped');
});

// ── /api/agent/task entry (durable agent-task runner) ───────────────────

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

/**
 * Patch the module loader so `require('../agent-runner')` inside
 * agent-task-runner resolves to the real module with the given overrides
 * (same pattern as the F1 agentic-chat-stream tests).
 */
function withStubbedAgentRunner(overrides, fn) {
  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === '../agent-runner' || request.endsWith('/agent-runner')) {
      return { ...agentRunner, ...overrides };
    }
    return originalLoad.apply(this, arguments);
  };
  const restore = () => { Module._load = originalLoad; };
  return Promise.resolve()
    .then(() => fn())
    .finally(restore);
}

function setupAgentTaskEnv(label) {
  const restoreEnv = rememberEnv([
    'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'AGENT_TASK_STORE_DIR', 'NODE_ENV',
    'AGENT_TASK_AGENT_RUNNER', 'AGENT_TASK_MODEL_FAILOVER', 'AGENT_TASK_LLM_RECOVERY',
  ]);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), `siragpt-f2-${label}-`));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  delete process.env.OPENROUTER_API_KEY;
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_TASK_AGENT_RUNNER = '1'; // opt in (default-off under test)
  process.env.AGENT_TASK_MODEL_FAILOVER = '0';
  process.env.AGENT_TASK_LLM_RECOVERY = '0';
  clearAgentModules();

  const persistence = require('../src/services/agents/agent-task-persistence');
  const reactAgent = require('../src/services/react-agent');
  const taskContractResolver = require('../src/services/agents/task-contract-resolver');
  const original = {
    upsert: persistence.upsertAgentTask,
    append: persistence.appendAgentTaskEvent,
    artifact: persistence.persistGeneratedArtifact,
    run: reactAgent.run,
    resolve: taskContractResolver.resolveTaskContract,
  };
  const counters = { persistedArtifacts: 0 };
  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => { counters.persistedArtifacts += 1; };
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });

  return {
    counters,
    setReactRun(fn) { reactAgent.run = fn; },
    cleanup() {
      persistence.upsertAgentTask = original.upsert;
      persistence.appendAgentTaskEvent = original.append;
      persistence.persistGeneratedArtifact = original.artifact;
      reactAgent.run = original.run;
      taskContractResolver.resolveTaskContract = original.resolve;
      fs.rmSync(storeDir, { recursive: true, force: true });
      clearAgentModules();
      restoreEnv();
    },
  };
}

test('agentTaskAgentRunnerEnabled: default on, off under NODE_ENV=test unless opted in', () => {
  clearAgentModules();
  const { agentTaskAgentRunnerEnabled } = require('../src/services/agents/agent-task-runner');
  assert.equal(agentTaskAgentRunnerEnabled({}), true);
  assert.equal(agentTaskAgentRunnerEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(agentTaskAgentRunnerEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(agentTaskAgentRunnerEnabled({ NODE_ENV: 'test', AGENT_TASK_AGENT_RUNNER: '1' }), true);
  assert.equal(agentTaskAgentRunnerEnabled({ AGENT_TASK_AGENT_RUNNER: '0' }), false);
});

test('agent-task: claimed create turn served by the AgentRunner — loop and pipeline never run', async () => {
  const env = setupAgentTaskEnv('runner-success');
  let reactInvoked = false;
  env.setReactRun(async () => {
    reactInvoked = true;
    throw new Error('react loop must not run when the runner delivers');
  });
  let runnerCalls = 0;
  try {
    await withStubbedAgentRunner({
      hasConversationArtifacts: async () => false,
      executeAgentRunnerTurn: async ({ onEvent }) => {
        runnerCalls += 1;
        const artifact = {
          id: 'art-f2-1',
          filename: 'embarazo-rosado.pptx',
          format: 'pptx',
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sizeBytes: 12345,
          downloadUrl: '/api/agent/artifact/art-f2-1',
        };
        onEvent({ type: 'tool_call', tool: 'create_presentation', label: 'Ejecutando código', preview: 'rosado' });
        onEvent({ type: 'tool_result', tool: 'create_presentation', ok: true, preview: 'ok' });
        onEvent({ type: 'file_artifact', artifact });
        return {
          ok: true,
          summary: 'Listo. Generé embarazo-rosado.pptx con el color pedido.',
          artifacts: [artifact],
          steps: [],
          stoppedReason: 'agent_runner',
        };
      },
    }, async () => {
      const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
      const taskStore = require('../src/services/agents/task-store');
      const result = await runAgentTaskJob({
        taskId: 'task-f2-runner-success-1',
        traceId: 'trace-f2-runner-success-1',
        user: { id: 'user-f2-1', email: 'f2@example.com' },
        goal: 'crea una ppt del embarazo de color rosado la ppt',
        displayGoal: 'crea una ppt del embarazo de color rosado la ppt',
        files: [],
        fileMetadata: [],
        model: 'gpt-4o',
        documentPolicy: { mode: 'doc_required', format: 'pptx', autoGenerate: true },
        maxSteps: 6,
        maxRuntimeMs: 60_000,
      });
      const snapshot = taskStore.getTaskSnapshotForUser('task-f2-runner-success-1', 'user-f2-1');
      assert.equal(result.status, 'completed');
      assert.equal(result.artifacts, 1);
      assert.equal(runnerCalls, 1);
      assert.equal(reactInvoked, false, 'the LLM loop must never run when the runner delivered');
      assert.equal(snapshot.streamState.stoppedReason, 'agent_runner');
      assert.match(snapshot.streamState.finalText, /embarazo-rosado\.pptx/);
      assert.equal(snapshot.streamState.artifacts.length, 1);
      assert.equal(snapshot.streamState.artifacts[0].filename, 'embarazo-rosado.pptx');
    });
  } finally {
    env.cleanup();
  }
});

test('agent-task: claimed create turn + runner failure → honest error, NEVER the generic pipeline', async () => {
  const env = setupAgentTaskEnv('runner-402');
  let reactInvoked = false;
  env.setReactRun(async () => {
    reactInvoked = true;
    throw new Error('react loop must not run for a claimed create-doc failure');
  });
  try {
    await withStubbedAgentRunner({
      hasConversationArtifacts: async () => false,
      executeAgentRunnerTurn: async () => ({
        ok: false,
        skipped: false,
        summary: '',
        artifacts: [],
        steps: [],
        stoppedReason: 'llm_402',
        errorMessage: 'This request requires more credits… can only afford 694.',
      }),
    }, async () => {
      const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
      const taskStore = require('../src/services/agents/task-store');
      const result = await runAgentTaskJob({
        taskId: 'task-f2-runner-402-1',
        traceId: 'trace-f2-runner-402-1',
        user: { id: 'user-f2-2', email: 'f2@example.com' },
        goal: 'crea una ppt del embarazo de color celeste la ppt',
        displayGoal: 'crea una ppt del embarazo de color celeste la ppt',
        files: [],
        fileMetadata: [],
        model: 'gpt-4o',
        documentPolicy: { mode: 'doc_required', format: 'pptx', autoGenerate: true },
        maxSteps: 6,
        maxRuntimeMs: 60_000,
      });
      const snapshot = taskStore.getTaskSnapshotForUser('task-f2-runner-402-1', 'user-f2-2');
      assert.equal(result.status, 'completed');
      assert.equal(result.artifacts, 0, 'no stub deck may be fabricated');
      assert.equal(env.counters.persistedArtifacts, 0, 'generateAutoDocument (advanced pipeline) must be unreachable');
      assert.equal(reactInvoked, false, 'the LLM loop (create_document) must be unreachable');
      assert.equal(snapshot.streamState.stoppedReason, 'agent_runner_failed');
      assert.match(snapshot.streamState.finalText, /créditos/);
      assert.match(snapshot.streamState.finalText, /plantilla genérica/);
      assert.equal(snapshot.streamState.artifacts.length, 0);
    });
  } finally {
    env.cleanup();
  }
});

test('agent-task: non-claimed goal never invokes the runner and keeps the normal loop', async () => {
  const env = setupAgentTaskEnv('not-claimed');
  let reactInvoked = false;
  env.setReactRun(async () => {
    reactInvoked = true;
    return { finalAnswer: 'Aquí tienes la respuesta redactada.', steps: [], stoppedReason: 'completed' };
  });
  let runnerCalls = 0;
  try {
    await withStubbedAgentRunner({
      executeAgentRunnerTurn: async () => {
        runnerCalls += 1;
        throw new Error('runner must not be invoked for non-claimed goals');
      },
    }, async () => {
      const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
      const result = await runAgentTaskJob({
        taskId: 'task-f2-not-claimed-1',
        traceId: 'trace-f2-not-claimed-1',
        user: { id: 'user-f2-3', email: 'f2@example.com' },
        goal: 'Redacta una respuesta breve y responde solo en el chat.',
        displayGoal: 'Redacta una respuesta breve y responde solo en el chat.',
        files: [],
        fileMetadata: [],
        model: 'gpt-4o',
        documentPolicy: { mode: 'chat_only', autoGenerate: false },
        maxSteps: 4,
        maxRuntimeMs: 60_000,
      });
      assert.equal(result.status, 'completed');
      assert.equal(runnerCalls, 0, 'runner must not claim a plain chat goal');
      assert.equal(reactInvoked, true, 'the normal loop still serves non-claimed goals');
    });
  } finally {
    env.cleanup();
  }
});

test('agent-task: claimed EDIT turn + runner failure keeps the loop but bans create_document + auto pipeline', async () => {
  const env = setupAgentTaskEnv('edit-continues');
  let loopToolNames = null;
  env.setReactRun(async (_client, args) => {
    loopToolNames = (args.tools || []).map((tool) => tool && tool.name).filter(Boolean);
    return { finalAnswer: 'Apliqué los cambios solicitados en el archivo anterior.', steps: [], stoppedReason: 'completed' };
  });
  try {
    await withStubbedAgentRunner({
      // Prior conversation artifacts + a work verb claim the runner without
      // making the turn runner-only (no create-doc phrase, no style+color).
      hasConversationArtifacts: async () => true,
      executeAgentRunnerTurn: async () => ({
        ok: false,
        skipped: false,
        summary: '',
        artifacts: [],
        steps: [],
        stoppedReason: 'no_output',
        errorMessage: null,
      }),
    }, async () => {
      const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
      const taskStore = require('../src/services/agents/task-store');
      const result = await runAgentTaskJob({
        taskId: 'task-f2-edit-continues-1',
        traceId: 'trace-f2-edit-continues-1',
        user: { id: 'user-f2-4', email: 'f2@example.com' },
        goal: 'agrega los totales del trimestre al archivo anterior',
        displayGoal: 'agrega los totales del trimestre al archivo anterior',
        files: [],
        fileMetadata: [],
        chatId: 'chat-f2-4',
        model: 'gpt-4o',
        documentPolicy: { mode: 'doc_required', format: 'xlsx', autoGenerate: true },
        maxSteps: 4,
        maxRuntimeMs: 60_000,
      });
      const snapshot = taskStore.getTaskSnapshotForUser('task-f2-edit-continues-1', 'user-f2-4');
      assert.equal(result.status, 'completed');
      assert.ok(Array.isArray(loopToolNames), 'the loop still runs for claimed EDIT turns');
      assert.equal(loopToolNames.includes('create_document'), false, 'create_document must be banned after a claimed failure');
      assert.equal(snapshot.documentPolicy.autoGenerate, false, 'the auto-document pipeline must stay banned');
      assert.equal(snapshot.documentPolicy.thresholds.agentRunnerFailure, 'no_output');
      assert.equal(result.artifacts, 0);
    });
  } finally {
    env.cleanup();
  }
});

// ── Chat loop: claimed failure bans create_document for the turn ────────

function makeFakeRes() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c.toString('utf-8')));
  stream.flushHeaders = () => {};
  stream.setHeader = () => {};
  return { res: stream };
}

test('chat: claimed EDIT turn + runner failure removes create_document from the loop toolset', async () => {
  const capturedToolNames = [];
  const openai = {
    chat: {
      completions: {
        create: async (opts) => {
          for (const tool of opts.tools || []) {
            const name = tool && tool.function && tool.function.name;
            if (name) capturedToolNames.push(name);
          }
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_finalize',
                  type: 'function',
                  function: { name: 'finalize', arguments: JSON.stringify({ answer: 'Listo, edité el documento.' }) },
                }],
              },
            }],
          };
        },
      },
    },
  };
  const { res } = makeFakeRes();
  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === './agent-runner' || request.endsWith('/agent-runner')) {
      return {
        ...agentRunner,
        executeAgentRunnerTurn: async () => ({
          ok: false,
          skipped: false,
          summary: '',
          artifacts: [],
          steps: [],
          stoppedReason: 'llm_402',
          errorMessage: '402',
        }),
        hasConversationArtifacts: async () => false,
      };
    }
    if (request === './source-preserving-document-edit' || request.endsWith('/source-preserving-document-edit')) {
      return {
        isSourcePreservingEditRequest: () => false,
        tryGenerateSourcePreservingDocumentEdit: async () => null,
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../src/services/agentic-chat-stream')];
  const fresh = require('../src/services/agentic-chat-stream');
  try {
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'edita el documento adjunto: cambia el título a Informe Final',
      history: [],
      res,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: ['f1'], prisma: {} },
      toolsOverride: [
        {
          name: 'create_document',
          description: 'create a NEW generic document',
          parameters: { type: 'object', properties: { filename: { type: 'string' } } },
          execute: async () => { throw new Error('create_document must be unreachable'); },
        },
        {
          name: 'document_edit',
          description: 'edit attached document',
          parameters: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'] },
          execute: async () => ({ ok: true }),
        },
      ],
    });
    assert.notEqual(result.stoppedReason, 'agent_runner_failed', 'edit turns keep the surgical loop');
    assert.ok(capturedToolNames.length > 0, 'the loop must have offered tools to the model');
    assert.equal(capturedToolNames.includes('create_document'), false, 'create_document must be banned after a claimed failure');
    assert.equal(capturedToolNames.includes('document_edit'), true, 'document_edit (surgical) stays available');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/services/agentic-chat-stream')];
  }
});
