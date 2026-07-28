'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  contextBudgetChars,
  createProtocolSafeTextStream,
} = require('../src/services/codex/agent-loop');
const {
  parseSettingsObject,
  mergeSettings,
  toolDecision,
  commandDecision,
  requiresApproval,
} = require('../src/services/codex/project-settings');
const {
  applyStopHooks,
  parseHooks,
} = require('../src/services/codex/project-hooks');
const {
  checkProjectBudget,
  configuredBudgetUsd,
} = require('../src/services/codex/project-budget');
const {
  detectMediaType,
  readWorkspaceMedia,
} = require('../src/services/codex/workspace-media');
const {
  formatProgressContext,
  generateAutoLearnings,
} = require('../src/services/codex/progress-ledger');
const {
  BackgroundSubagentManager,
} = require('../src/services/codex/background-subagents');
const {
  createBackgroundTaskService,
} = require('../src/services/codex/background-tasks');
const {
  completionPayload,
  publishRunCompletion,
} = require('../src/services/codex/run-completion');
const {
  checkpointCommitBody,
} = require('../src/services/codex/checkpoint-service');
const {
  gitCommitAll,
} = require('../src/services/codex/workspace');
const {
  callOpenAICompatible,
  toAnthropicPayload,
  toOpenAICompatibleMessages,
} = require('../src/services/codex/llm-provider');
const {
  safeReadBinaryFile,
} = require('../../scripts/code-runner-fs-helper');

test('context budget follows the active model window and streaming hides tool protocol', async () => {
  const small = contextBudgetChars({ contextWindow: 16_000, maxOutputTokens: 2_000 }, {});
  const large = contextBudgetChars({ contextWindow: 200_000, maxOutputTokens: 8_000 }, {});
  assert.ok(large > small);
  assert.equal(contextBudgetChars({ contextWindow: 200_000 }, { CODEX_CONTEXT_MAX_CHARS: '12345' }), 12345);

  const deltas = [];
  const stream = createProtocolSafeTextStream(async (delta) => deltas.push(delta));
  await stream.push('Voy a editar. ');
  await stream.push('```tool_call\n{"name":"write_file"}');
  assert.equal(deltas.join(''), 'Voy a editar. ');
});

test('OpenAI-compatible streaming emits text and reasoning deltas with usage', async () => {
  let request;
  const chunks = [
    { id: 'gen-1', choices: [{ delta: { reasoning: 'pienso ' } }] },
    { choices: [{ delta: { content: 'hola ' } }] },
    { choices: [{ delta: { content: 'mundo' } }], usage: { prompt_tokens: 7, completion_tokens: 4 } },
  ];
  const client = {
    chat: {
      completions: {
        create: async (input) => {
          request = input;
          return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
          };
        },
      },
    },
  };
  const text = [];
  const reasoning = [];
  const out = await callOpenAICompatible({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 100,
    model: 'test-model',
    client,
    providerLabel: 'OpenRouter',
    effort: 'high',
    onTextDelta: async (delta) => text.push(delta),
    onReasoningDelta: async (delta) => reasoning.push(delta),
  });
  assert.equal(out.content, 'hola mundo');
  assert.equal(out.reasoning, 'pienso ');
  assert.equal(text.join(''), 'hola mundo');
  assert.equal(reasoning.join(''), 'pienso ');
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.deepEqual(
    { tokensIn: out.usage.tokensIn, tokensOut: out.usage.tokensOut },
    { tokensIn: 7, tokensOut: 4 },
  );
});

test('Anthropic ladder preserves workspace image and PDF blocks', () => {
  const document = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' },
  };
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
  };
  const payload = toAnthropicPayload([
    { role: 'system', content: 'system' },
    { role: 'user', content: [{ type: 'text', text: 'inspect' }, image, document] },
  ]);
  assert.equal(payload.system, 'system');
  assert.equal(payload.messages[0].content[1].type, 'image');
  assert.equal(payload.messages[0].content[2].type, 'document');

  const openAi = toOpenAICompatibleMessages(payload.messages);
  assert.equal(openAi[0].content[1].type, 'image_url');
  assert.equal(openAi[0].content.some((block) => block.type === 'document'), false);

  const backToAnthropic = toAnthropicPayload([
    { role: 'user', content: openAi[0].content },
  ]);
  assert.equal(backToAnthropic.messages[0].content[1].type, 'image');
});

test('project settings merge hierarchically and enforce modes, tools and commands', () => {
  const base = parseSettingsObject({
    mode: 'auto',
    tools: { allow: ['read_*', 'run_command'], requireApproval: ['run_command'] },
    commands: { allow: ['git *', 'npm run *'], deny: ['git reset *'] },
    budget: { dailyUsd: 3 },
  });
  const workspace = parseSettingsObject({
    mode: 'confirm',
    tools: { deny: ['read_media'] },
    subagents: { defaultEffort: 'high', explorerModel: 'cheap-model' },
  });
  const settings = mergeSettings(base, workspace);
  assert.equal(settings.mode, 'confirm');
  assert.equal(settings.budget.dailyUsd, 3);
  assert.equal(settings.subagents.explorerModel, 'cheap-model');
  assert.equal(toolDecision(settings, 'read_file').allowed, true);
  assert.equal(toolDecision(settings, 'read_media').allowed, false);
  assert.equal(commandDecision(settings, ['git', 'status']).allowed, true);
  assert.equal(commandDecision(settings, ['git', 'reset', '--hard']).allowed, false);
  assert.equal(requiresApproval(settings, 'run_command'), true);
  assert.equal(requiresApproval(settings, 'read_file'), false);
});

test('Stop hooks can block or transform a terminal outcome', () => {
  const deny = parseHooks(JSON.stringify({
    stop: [{ matcher: 'done', action: 'deny', message: 'quality pending' }],
  }));
  assert.deepEqual(
    applyStopHooks(deny, { status: 'done' }),
    { allowed: false, outcome: { status: 'done' }, message: 'quality pending' },
  );
  const transform = parseHooks(JSON.stringify({
    stop: [{ matcher: 'done', action: 'transform', args: { status: 'error', error: 'policy' } }],
  }));
  assert.deepEqual(
    applyStopHooks(transform, { status: 'done' }),
    { allowed: true, outcome: { status: 'error', error: 'policy' }, message: '' },
  );
});

test('project daily budget aggregates metrics and fails closed in production', async () => {
  let where;
  const prisma = {
    codexRunMetric: {
      aggregate: async (args) => {
        where = args.where;
        return { _sum: { costAppliedUsd: 2.5 } };
      },
    },
  };
  const allowed = await checkProjectBudget({
    prisma,
    projectId: 'p1',
    settings: { budget: { dailyUsd: 3 } },
    env: { NODE_ENV: 'production' },
    now: new Date('2026-07-26T15:00:00Z'),
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.remainingUsd, 0.5);
  assert.equal(where.run.projectId, 'p1');
  assert.equal(where.createdAt.gte.toISOString(), '2026-07-26T00:00:00.000Z');

  const blocked = await checkProjectBudget({
    prisma: {},
    projectId: 'p1',
    settings: { budget: { dailyUsd: 3 } },
    env: { NODE_ENV: 'production' },
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'budget_query_failed');
  assert.equal(configuredBudgetUsd({}, { NODE_ENV: 'production' }), 10);

  const blockedOutsideProduction = await checkProjectBudget({
    prisma: {},
    projectId: 'p1',
    settings: { budget: { dailyUsd: 3 } },
    env: { NODE_ENV: 'test' },
  });
  assert.equal(blockedOutsideProduction.allowed, false, 'kill switch failures always fail closed');
});

test('project daily budget includes unpersisted cost from the active run', async () => {
  const prisma = {
    codexRunMetric: {
      aggregate: async () => ({ _sum: { costOriginalUsd: 0.6, costAppliedUsd: 0 } }),
    },
  };
  const status = await checkProjectBudget({
    prisma,
    projectId: 'p1',
    settings: { budget: { dailyUsd: 1 } },
    env: { NODE_ENV: 'production' },
    now: new Date('2026-07-27T12:00:00Z'),
    inRunCostUsd: 0.4,
  });

  assert.equal(status.allowed, false, 'alcanzar exactamente el límite impide otra llamada');
  assert.equal(status.reason, 'daily_budget_exceeded');
  assert.equal(status.persistedCostTodayUsd, 0.6);
  assert.equal(status.inRunCostUsd, 0.4);
  assert.equal(status.costTodayUsd, 1);
  assert.equal(status.remainingUsd, 0);
});

test('workspace media detects images and provides PDF text plus native document blocks', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
  assert.equal(detectMediaType(png, 'x.bin'), 'image/png');
  const image = await readWorkspaceMedia({
    runner: {
      readBinaryFile: async () => ({
        bytes: png.length,
        contentBase64: png.toString('base64'),
      }),
    },
    project: 'p1',
    path: 'ui.png',
    modelCapabilities: { supportsImages: true },
    provider: 'openrouter',
  });
  assert.equal(image.observation[1].type, 'image_url');

  const pdf = Buffer.from('%PDF-1.7\nfake');
  const document = await readWorkspaceMedia({
    runner: {
      readBinaryFile: async () => ({
        bytes: pdf.length,
        contentBase64: pdf.toString('base64'),
      }),
    },
    project: 'p1',
    path: 'spec.pdf',
    modelCapabilities: { supportsImages: true },
    provider: 'anthropic',
    pdfParseImpl: async () => ({ numpages: 2, text: 'Acceptance criteria' }),
  });
  assert.equal(document.pages, 2);
  assert.match(document.observation[0].text, /Acceptance criteria/);
  assert.equal(document.observation[1].type, 'document');
});

test('binary workspace reads are bounded and reject symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-media-'));
  try {
    fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([1, 2, 3]));
    const read = safeReadBinaryFile(root, 'image.bin', 10);
    assert.equal(read.bytes, 3);
    assert.equal(Buffer.from(read.contentBase64, 'base64').toString('hex'), '010203');
    fs.symlinkSync(path.join(root, 'image.bin'), path.join(root, 'link.bin'));
    assert.throws(() => safeReadBinaryFile(root, 'link.bin', 10), /symlink|unsafe|operation/i);
    assert.throws(() => safeReadBinaryFile(root, 'image.bin', 2), /too_large|large/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background subagents are owned, observable and notify on completion', async () => {
  const manager = new BackgroundSubagentManager({ maxPerRun: 1, retentionMs: 60_000 });
  const notifications = [];
  const started = manager.start({
    runId: 'r1',
    project: 'p1',
    agent: 'explorer',
    execute: async () => ({
      ok: true,
      agent: 'explorer',
      result: 'found it',
      steps: 1,
      toolCallsCount: 2,
      model: 'cheap',
      effort: 'low',
    }),
    onComplete: async (task) => notifications.push(task),
  });
  await manager.tasks.get(started.taskId).promise;
  const status = manager.status({ taskId: started.taskId, runId: 'r1', project: 'p1' });
  assert.equal(status.status, 'done');
  assert.equal(status.outcome.result, 'found it');
  assert.equal(notifications.length, 1);
  assert.throws(
    () => manager.status({ taskId: started.taskId, runId: 'other', project: 'p1' }),
    /not_found/,
  );
  manager.reset();
});

test('background commands notify exactly when the supervised task is terminal', async () => {
  const service = createBackgroundTaskService({
    launchImpl: async ({ task }) => ({
      taskId: task.taskId,
      pid: 42,
      startedAt: task.startedAt,
      processStart: '123',
      status: 'starting',
    }),
    controlImpl: async ({ op, taskId }) => {
      if (op === 'list') return { active: 0, tasks: [] };
      if (op === 'logs') {
        return { task: { taskId, status: 'completed', exitCode: 0 }, log: 'build complete' };
      }
      throw new Error(`unexpected ${op}`);
    },
  });
  const task = await service.start({
    runner: {},
    project: 'p1',
    cmd: ['npm', 'run', 'build'],
    env: {},
  });
  const notifications = [];
  const result = await service.watch({
    runner: {},
    project: 'p1',
    taskId: task.taskId,
    onComplete: async (current) => notifications.push(current),
  });
  assert.equal(result.task.status, 'completed');
  assert.equal(result.log, 'build complete');
  assert.equal(notifications.length, 1);
});

test('structured memory is prompt-ready and auto-memory accepts bounded JSON', async () => {
  const project = {
    brief: {
      objectives: [{ title: 'Ship quality', status: 'active', priority: 1 }],
      ledger: [{
        runId: 'r1',
        department: 'interactive',
        outcome: 'passed',
        task: 'Fix preview',
        learnings: ['Use browser_check after Vite starts.'],
      }],
    },
  };
  const context = formatProgressContext(project);
  assert.match(context, /OBJETIVOS VIGENTES/);
  assert.match(context, /Use browser_check/);
  const result = await generateAutoLearnings({
    llmTurn: async () => ({
      text: '{"learnings":["Keep the verified Vite entrypoint.","Run smoke tests."]}',
      usage: { tokensIn: 5, tokensOut: 2 },
    }),
    task: 'x',
    outcome: 'passed',
    diffstat: { filesChanged: 1 },
  });
  assert.deepEqual(result.learnings, ['Keep the verified Vite entrypoint.', 'Run smoke tests.']);
  assert.equal(result.usage.tokensIn, 5);
});

test('completion webhooks are canonical, redacted and deduplicatable', async () => {
  const calls = [];
  const triggers = {
    publish: async (...args) => {
      calls.push(args);
      return { dispatched: 1, deduped: false, errors: [] };
    },
  };
  const run = {
    id: 'r1',
    projectId: 'p1',
    userId: 'u1',
    mode: 'build',
    model: 'm1',
    tier: 'power',
  };
  const result = await publishRunCompletion({
    run,
    status: 'error',
    error: 'OPENAI_API_KEY=secret-value Bearer abcdefghijklmnopqrstuvwxyz',
    triggers,
    env: {},
  });
  assert.equal(result.event, 'codex.run.failed');
  assert.equal(calls[0][0], 'codex.run.failed');
  assert.equal(calls[0][2], 'u1');
  assert.doesNotMatch(JSON.stringify(calls[0][1]), /secret-value|abcdefghijklmnop/);
  assert.equal(calls[0][3].idempotencyTtlMs, 24 * 60 * 60_000);
  assert.equal(completionPayload(run, 'done').error, null);
});

test('checkpoint commits carry a rich body without changing git argv safety', async () => {
  const body = checkpointCommitBody({
    run: { id: 'run-123', projectId: 'p1', mode: 'build', prompt: 'Build inventory' },
    project: { id: 'p1', name: 'Inventory' },
    changedFiles: ' M src/App.tsx\n?? src/api.ts',
    expectedTreeSha: 'a'.repeat(40),
  });
  assert.match(body, /Run: run-123/);
  assert.match(body, /Verified-Tree:/);
  assert.match(body, /src\/App.tsx/);

  const commands = [];
  const sha = await gitCommitAll({
    exec: async (_project, cmd) => {
      commands.push(cmd);
      if (cmd[1] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  }, 'p1', 'feat: rich checkpoint', { body });
  assert.equal(sha, 'abc123');
  const commit = commands.find((cmd) => cmd.includes('commit'));
  assert.equal(commit.filter((value) => value === '-m').length, 2);
  assert.ok(commit.includes(body));
});
