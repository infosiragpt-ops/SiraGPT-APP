'use strict';

// Owner policy on /agentes agent tasks: a model the user picked (the task
// route sets `modelPinned`) is never switched. When its provider fails, the
// task ends with the exact cause (billing-failover.buildFailureMessage) and
// the «sin saldo» memo is still fed. Internal callers (no modelPinned) and a
// remapped stand-in keep the cross-provider ladder.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

async function withTaskEnv(label, reactRun, fn) {
  const restoreEnv = rememberEnv([
    'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY',
    'AGENT_TASK_STORE_DIR', 'AGENT_TASK_MODEL_FAILOVER', 'AGENT_TASK_AGENT_RUNNER', 'AGENT_TASK_LLM_RECOVERY', 'NODE_ENV',
  ]);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), `siragpt-pinned-${label}-`));
  delete process.env.OPENROUTER_API_KEY;
  process.env.CEREBRAS_API_KEY = 'test-cerebras-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  delete process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_TASK_STORE_DIR = storeDir;
  process.env.AGENT_TASK_MODEL_FAILOVER = '1';
  process.env.AGENT_TASK_AGENT_RUNNER = '0';
  process.env.AGENT_TASK_LLM_RECOVERY = '0';
  process.env.NODE_ENV = 'test';
  clearAgentModules();
  const billing = require('../src/services/ai/billing-failover');
  billing.__resetForTests();

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
  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  persistence.persistGeneratedArtifact = async () => null;
  taskContractResolver.resolveTaskContract = async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' });
  reactAgent.run = reactRun;
  try {
    const { runAgentTaskJob } = require('../src/services/agents/agent-task-runner');
    const taskStore = require('../src/services/agents/task-store');
    await fn({ runAgentTaskJob, taskStore, billing });
  } finally {
    persistence.upsertAgentTask = original.upsert;
    persistence.appendAgentTaskEvent = original.append;
    persistence.persistGeneratedArtifact = original.artifact;
    reactAgent.run = original.run;
    taskContractResolver.resolveTaskContract = original.resolve;
    fs.rmSync(storeDir, { recursive: true, force: true });
    clearAgentModules();
    billing.__resetForTests();
    restoreEnv();
  }
}

const NO_CREDIT = {
  finalAnswer: 'Hubo un problema temporal con el modelo y no pude completar la respuesta.',
  steps: [],
  stoppedReason: 'model_error: 402 Insufficient credits',
  modelError: { status: 402, code: null, message: '402 Insufficient credits', reason: 'billing' },
};

function payload(taskId, extra = {}) {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    user: { id: `user-${taskId}`, email: 'pinned@example.com' },
    goal: 'Redacta una respuesta breve y responde solo en el chat.',
    displayGoal: 'Redacta una respuesta breve y responde solo en el chat.',
    files: [],
    fileMetadata: [],
    documentPolicy: { mode: 'chat_only', autoGenerate: false },
    maxSteps: 4,
    maxRuntimeMs: 60_000,
    ...extra,
  };
}

test('a picked model keeps its provider: no ladder, the exact cause in Spanish, memo still fed', async () => {
  const models = [];
  await withTaskEnv('kept', async (_client, args) => {
    models.push(args.model);
    return NO_CREDIT;
  }, async ({ runAgentTaskJob, taskStore, billing }) => {
    await runAgentTaskJob(payload('task-pinned-kept-1', { model: 'gpt-4o', modelPinned: true }));
    const snapshot = taskStore.getTaskSnapshotForUser('task-pinned-kept-1', 'user-task-pinned-kept-1');
    assert.deepEqual(models, ['gpt-4o'], 'never another model');
    const finalText = snapshot.streamState.finalText;
    assert.match(finalText, /no pudo responder: su proveedor no tiene saldo ahora\./);
    assert.match(finalText, /No cambié de modelo/);
    assert.doesNotMatch(finalText, /problema temporal/);
    assert.doesNotMatch(finalText, /gpt-4o/, 'a display name or «El modelo elegido», never the raw id');
    assert.match(String(snapshot.streamState.stoppedReason), /^model_error/);
    assert.equal(billing.isOutOfCredit('OpenAI'), true, 'the «sin saldo» memo is still fed');
  });
});

test('a per-minute window of a picked model says how long to wait', async () => {
  await withTaskEnv('window', async () => ({
    finalAnswer: '',
    steps: [],
    stoppedReason: 'model_error: 429 Rate limit reached for requests',
    modelError: { status: 429, code: 'rate_limit_exceeded', message: '429 Rate limit reached for requests. Please try again in 12s.', reason: null },
  }), async ({ runAgentTaskJob, taskStore }) => {
    await runAgentTaskJob(payload('task-pinned-window-1', { model: 'gpt-4o', modelPinned: true }));
    const snapshot = taskStore.getTaskSnapshotForUser('task-pinned-window-1', 'user-task-pinned-window-1');
    assert.match(snapshot.streamState.finalText, /límite de solicitudes por minuto\. Espera 12 s/);
  });
});

test('internal callers without modelPinned keep the cross-provider ladder', async () => {
  const models = [];
  await withTaskEnv('ladder', async (_client, args) => {
    models.push(args.model);
    if (models.length === 1) return NO_CREDIT;
    return { finalAnswer: 'Respuesta recuperada por un proveedor alternativo.', steps: [], stoppedReason: 'completed' };
  }, async ({ runAgentTaskJob, taskStore }) => {
    const result = await runAgentTaskJob(payload('task-pinned-ladder-1', { model: 'gpt-4o' }));
    const snapshot = taskStore.getTaskSnapshotForUser('task-pinned-ladder-1', 'user-task-pinned-ladder-1');
    assert.equal(result.status, 'completed');
    assert.equal(models.length, 2);
    assert.equal(models[0], 'gpt-4o');
    assert.match(snapshot.streamState.finalText, /proveedor alternativo/);
  });
});

test('a remapped stand-in (the runner cannot run the pick) still uses the ladder', async () => {
  const models = [];
  await withTaskEnv('remapped', async (_client, args) => {
    models.push(args.model);
    if (models.length === 1) return NO_CREDIT;
    return { finalAnswer: 'Respuesta del respaldo.', steps: [], stoppedReason: 'completed' };
  }, async ({ runAgentTaskJob }) => {
    const { normalizeAgentRuntimeModel } = require('../src/services/agents/agent-task-runner');
    if (typeof normalizeAgentRuntimeModel === 'function') {
      assert.equal(normalizeAgentRuntimeModel('totally-unknown-model-x9').remapped, true);
    }
    const result = await runAgentTaskJob(payload('task-pinned-remapped-1', { model: 'totally-unknown-model-x9', modelPinned: true }));
    assert.equal(result.status, 'completed');
    assert.equal(models.length, 2);
  });
});

async function withAttachmentTaskEnv(label, reactRun, fn) {
  const restoreEnv = rememberEnv(['AGENT_TASK_ATTACHMENT_FASTPATH']);
  const prisma = require('../src/config/database');
  const aiService = require('../src/services/ai-service');
  const documentIntelligence = require('../src/services/document-intelligence');
  const originalFindMany = prisma.file.findMany;
  const originalFindFirst = prisma.file.findFirst;
  const originalAnalyzeFile = documentIntelligence.analyzeFile;
  const originalGetClient = aiService.getClient;
  const recoveryCalls = [];
  const fileRow = {
    id: `file-${label}`,
    userId: `user-task-${label}`,
    filename: 'informe.pdf',
    originalName: 'informe.pdf',
    mimeType: 'application/pdf',
    size: 4096,
    path: '/tmp/informe.pdf',
    extractedText: [
      'Informe trimestral de ventas de la región andina correspondiente al tercer trimestre.',
      'Las ventas totales alcanzaron 283000 dólares frente a una meta contratada de 270000 dólares.',
      'La diferencia positiva fue de 13000 dólares y la retención ponderada de clientes llegó a 92.8 por ciento.',
      'El equipo comercial atribuye el resultado a la renovación de contratos corporativos y a la apertura de dos oficinas nuevas.',
      'Para el próximo trimestre se proyecta un crecimiento moderado condicionado a la estabilidad cambiaria de la región.',
    ].join(' '),
    openaiFileId: null,
    documentAnalysis: null,
  };
  // Every DB read the attachment context makes is stubbed: with a real
  // database behind the un-stubbed retriever (CI's postgres) the fake file
  // id is «not found», the context becomes the «sin evidencia» note and the
  // thin-attachment guard ends the turn before the model is ever called.
  prisma.file.findMany = async () => [fileRow];
  prisma.file.findFirst = async () => fileRow;
  documentIntelligence.analyzeFile = async () => null;
  aiService.getClient = (provider) => ({
    chat: {
      completions: {
        create: async (body) => {
          recoveryCalls.push(`${provider}:${body.model}`);
          return { choices: [{ message: { content: 'Respuesta de OTRO modelo sobre el informe: ventas 283000 frente a 270000.' } }] };
        },
      },
    },
  });
  try {
    await withTaskEnv(label, reactRun, async (ctx) => {
      // Recovery ON (the path that used to answer with another model).
      process.env.AGENT_TASK_LLM_RECOVERY = '1';
      process.env.AGENT_TASK_ATTACHMENT_FASTPATH = '0';
      await fn({ ...ctx, recoveryCalls });
    });
  } finally {
    prisma.file.findMany = originalFindMany;
    prisma.file.findFirst = originalFindFirst;
    documentIntelligence.analyzeFile = originalAnalyzeFile;
    aiService.getClient = originalGetClient;
    restoreEnv();
  }
}

function attachmentPayload(taskId) {
  return payload(taskId, {
    model: 'gpt-4o',
    modelPinned: true,
    goal: '¿Cuáles son las ventas totales y la meta contratada según el informe adjunto?',
    displayGoal: '¿Cuáles son las ventas totales y la meta contratada según el informe adjunto?',
    files: [`file-${taskId.replace(/^task-/, '')}`],
    fileMetadata: [{ id: `file-${taskId.replace(/^task-/, '')}`, name: 'informe.pdf', mimeType: 'application/pdf' }],
  });
}

test('a picked model that fails on a turn WITH an attachment: no recovery pass answers with another model (429 and unknown cause)', async () => {
  const cases = [
    {
      label: 'att-429',
      result: {
        finalAnswer: 'Hubo un problema temporal con el modelo y no pude completar la respuesta. Por favor vuelve a intentarlo.',
        steps: [],
        stoppedReason: 'model_error: 429 Rate limit reached for requests',
        modelError: { status: 429, code: 'rate_limit_exceeded', message: '429 Rate limit reached for requests. Please try again in 12s.', reason: null },
      },
      expect: /no pudo responder: su proveedor alcanzó el límite de solicitudes por minuto\. Espera 12 s/,
    },
    {
      label: 'att-400',
      result: {
        finalAnswer: 'Hubo un problema temporal con el modelo y no pude completar la respuesta. Por favor vuelve a intentarlo; si el problema persiste, reformula la solicitud.',
        steps: [],
        stoppedReason: 'model_error: 400 Invalid schema for function',
        modelError: { status: 400, code: null, message: '400 Invalid schema for function', reason: null },
      },
      expect: /no pudo responder\. No cambié de modelo; elige otro en el selector o inténtalo más tarde\./,
    },
  ];
  for (const { label, result, expect } of cases) {
    const models = [];
    await withAttachmentTaskEnv(label, async (_client, args) => {
      models.push(args.model);
      return result;
    }, async ({ runAgentTaskJob, taskStore, recoveryCalls }) => {
      const taskId = `task-${label}`;
      await runAgentTaskJob(attachmentPayload(taskId));
      const snapshot = taskStore.getTaskSnapshotForUser(taskId, `user-${taskId}`);
      assert.deepEqual(models, ['gpt-4o'], `${label}: the picked model only`);
      assert.deepEqual(recoveryCalls, [], `${label}: no second model is called`);
      const finalText = snapshot.streamState.finalText;
      assert.match(finalText, expect, label);
      assert.doesNotMatch(finalText, /OTRO modelo|problema temporal|gpt-4o/, label);
      assert.notEqual(snapshot.streamState.stoppedReason, 'attachment_empty_response_recovery', label);
      assert.match(String(snapshot.streamState.stoppedReason), /^model_error/, label);
    });
  }
});

test('«Reintentar» on a pinned task that failed keeps the pick: the snapshot remembers modelPinned', async () => {
  const models = [];
  await withTaskEnv('retry', async (_client, args) => {
    models.push(args.model);
    return NO_CREDIT;
  }, async ({ runAgentTaskJob, taskStore }) => {
    const taskId = 'task-pinned-retry-1';
    const userId = `user-${taskId}`;
    await runAgentTaskJob(payload(taskId, { model: 'gpt-4o', modelPinned: true }));
    const failed = taskStore.getTaskSnapshotForUser(taskId, userId);
    assert.equal(failed.modelPinned, true, 'the durable snapshot keeps the pin');
    // The payload POST /task/:id/retry and the boot resume rebuild from it.
    await runAgentTaskJob(payload(taskId, {
      model: failed.model,
      modelPinned: failed.modelPinned === true,
      retryOf: taskId,
    }));
    assert.deepEqual(models, ['gpt-4o', 'gpt-4o'], 'the retry never calls a second model');
    const after = taskStore.getTaskSnapshotForUser(taskId, userId);
    assert.match(after.streamState.finalText, /no pudo responder: su proveedor no tiene saldo ahora\./);
    assert.doesNotMatch(JSON.stringify(after.events || []), /Modelo de respaldo activado/);
  });
});

test('boot resume re-enqueues a pinned task with modelPinned (and an unpinned one without)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-pinned-boot-'));
  const restoreEnv = rememberEnv(['AGENT_TASK_STORE_DIR']);
  process.env.AGENT_TASK_STORE_DIR = dir;
  delete require.cache[require.resolve('../src/services/agents/task-store')];
  delete require.cache[require.resolve('../src/services/agents/agent-task-boot-recovery')];
  try {
    const taskStore = require('../src/services/agents/task-store');
    const bootRecovery = require('../src/services/agents/agent-task-boot-recovery');
    const checkpoint = { v: 1, stepsCompleted: 3, messages: [{ role: 'user', content: 'q' }] };
    taskStore.writeTaskSnapshot({ taskId: 'boot-pinned', userId: 'u1', status: 'error', agentGoal: 'g', displayGoal: 'g', model: 'grok-4.7', modelPinned: true, runnerCheckpoint: checkpoint });
    taskStore.writeTaskSnapshot({ taskId: 'boot-free', userId: 'u1', status: 'error', agentGoal: 'g', displayGoal: 'g', model: 'gpt-4o', runnerCheckpoint: checkpoint });
    assert.equal(taskStore.readTaskSnapshot('boot-pinned').modelPinned, true);
    assert.equal(taskStore.readTaskSnapshot('boot-free').modelPinned, false);
    const enqueued = [];
    await bootRecovery.resumeCheckpointedTasks({
      env: { REDIS_URL: 'redis://x' },
      taskStore,
      recoveredRows: [{ taskId: 'boot-pinned', userId: 'u1' }, { taskId: 'boot-free', userId: 'u1' }],
      enqueue: async (job, opts) => { enqueued.push(job); return { id: opts.jobId }; },
    });
    const byId = Object.fromEntries(enqueued.map((job) => [job.taskId, job]));
    assert.equal(byId['boot-pinned'].modelPinned, true);
    assert.equal(byId['boot-free'].modelPinned, false);
  } finally {
    delete require.cache[require.resolve('../src/services/agents/task-store')];
    delete require.cache[require.resolve('../src/services/agents/agent-task-boot-recovery')];
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv();
  }
});

test('image vision: a picked vision model is the only runtime; its error is kept for the exact cause', async () => {
  const { answerImageTurnWithVision } = require('../src/services/image-attachment-vision');
  const env = { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x' };
  const tmp = path.join(os.tmpdir(), `pinned-vision-${process.pid}.png`);
  fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const imageFiles = [{ path: tmp, mimeType: 'image/png', originalName: 'foto.png' }];
  const calls = [];
  const getClient = (provider) => ({
    chat: {
      completions: {
        create: async (req) => {
          calls.push(`${provider}:${req.model}`);
          if (provider === 'xAI') throw Object.assign(new Error('Your team has used all available credits.'), { status: 403 });
          return { choices: [{ message: { content: `respuesta de ${provider}` } }] };
        },
      },
    },
  });
  const prepareImage = async () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } });
  try {
    const pinned = await answerImageTurnWithVision({
      prompt: 'qué dice', imageFiles, provider: 'xAI', model: 'grok-4.7', env, getClient, prepareImage, pinned: true, logger: null,
    });
    assert.deepEqual(calls, ['xAI:grok-4.7'], 'never another vision model');
    assert.equal(pinned.text, '');
    assert.equal(pinned.pickedOnly, true);
    assert.equal(pinned.error.status, 403);

    calls.length = 0;
    const free = await answerImageTurnWithVision({
      prompt: 'qué dice', imageFiles, provider: 'xAI', model: 'grok-4.7', env, getClient, prepareImage, logger: null,
    });
    assert.equal(calls[0], 'xAI:grok-4.7');
    assert.ok(calls.length > 1, 'an unpinned turn still walks the vision runtimes');
    assert.equal(free.pickedOnly, false);
    assert.match(free.text, /^respuesta de /);

    // A text-only pick cannot see: the vision runtimes answer even when pinned.
    calls.length = 0;
    const textOnly = await answerImageTurnWithVision({
      prompt: 'qué dice', imageFiles, provider: 'DeepSeek', model: 'deepseek-v4-flash', env, getClient, prepareImage, pinned: true, logger: null,
    });
    assert.equal(textOnly.pickedOnly, false);
    assert.ok(textOnly.text);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('/agentes image-only turn with a picked vision model: no other model, the exact cause in Spanish', async () => {
  const restore = rememberEnv(['AGENT_TASK_ATTACHMENT_FASTPATH', 'XAI_API_KEY']);
  // The runner really runs Grok (an xAI key), so the pick is not remapped.
  process.env.XAI_API_KEY = 'test-xai-key';
  const prisma = require('../src/config/database');
  const aiService = require('../src/services/ai-service');
  const originalFindMany = prisma.file.findMany;
  const originalVision = aiService.answerImagesWithVision;
  const visionOpts = [];
  prisma.file.findMany = async () => [{
    id: 'file-img-1', userId: 'user-task-pinned-img-1', filename: 'foto.png', originalName: 'foto.png',
    mimeType: 'image/png', size: 2048, path: '/tmp/foto.png', extractedText: '', openaiFileId: null, documentAnalysis: null,
  }];
  aiService.answerImagesWithVision = async (_rows, _goal, opts) => {
    visionOpts.push(opts);
    return {
      text: '', provider: 'xAI', model: 'grok-4.7', attempts: [{ ok: false }], pickedOnly: true,
      error: Object.assign(new Error('402 Payment Required'), { status: 402 }),
    };
  };
  try {
    await withTaskEnv('img', async () => { throw new Error('the loop never runs for an image-only turn'); }, async ({ runAgentTaskJob, taskStore }) => {
      const taskId = 'task-pinned-img-1';
      await runAgentTaskJob(payload(taskId, {
        model: 'grok-4.7',
        modelPinned: true,
        goal: '¿Qué dice esta foto?',
        displayGoal: '¿Qué dice esta foto?',
        files: ['file-img-1'],
        fileMetadata: [{ id: 'file-img-1', name: 'foto.png', mimeType: 'image/png' }],
      }));
      assert.equal(visionOpts.length, 1);
      assert.equal(visionOpts[0].pinned, true, 'the runner asks for the picked model only');
      assert.equal(visionOpts[0].detailed, true);
      const snapshot = taskStore.getTaskSnapshotForUser(taskId, `user-${taskId}`);
      assert.match(snapshot.streamState.finalText, /no pudo responder: su proveedor no tiene saldo ahora\. No cambié de modelo/);
      assert.doesNotMatch(snapshot.streamState.finalText, /grok-4\.7/);
    });
  } finally {
    prisma.file.findMany = originalFindMany;
    aiService.answerImagesWithVision = originalVision;
    restore();
  }
});

test('the /agentes task routes set modelPinned from the composer\'s model', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'agent-task.js'), 'utf8');
  const matches = source.match(/modelPinned: isUserPickedModel\(req\.body\.model\),/g) || [];
  assert.equal(matches.length, 3, 'queued payload, local snapshot and local payload');
  assert.match(source, /modelPinned: payload\.modelPinned === true,/, 'the queued snapshot');
  assert.match(source, /function isUserPickedModel\(value\) \{\s*return typeof value === 'string' && value\.trim\(\)\.length > 0;/);
  // The durable snapshot remembers the pin, and «Reintentar» carries it.
  const retry = source.slice(source.indexOf("router.post('/task/:taskId/retry'"));
  assert.match(retry.slice(0, 3000), /modelPinned: snapshot\.modelPinned === true,/);
  assert.match(source, /modelPinned: existingSnapshot\?\.modelPinned === true \|\| modelPinned === true,/);
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agents', 'agent-task-runner.js'), 'utf8');
  assert.match(runner, /const pickedModelKept = modelPinned === true && runtimeModelProfile\.remapped !== true;/);
  assert.match(runner, /if \(modelFailed && agentModelFailoverEnabled\(\) && !pickedModelKept\)/);
});
