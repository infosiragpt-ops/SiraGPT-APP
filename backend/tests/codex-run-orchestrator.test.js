'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectCodeTaskIntent,
  detectRunRequest,
  runCodexPipeline,
  createRunRecord,
} = require('../src/services/codex/codex-run-orchestrator');
const codexRunStore = require('../src/services/codex/codex-run-store');
const chatTaskScope = require('../src/services/agents/chat-task-scope');

test('detectCodeTaskIntent flags coding prompts', () => {
  const hit = detectCodeTaskIntent('Please fix the bug in api.js and run npm test');
  assert.equal(hit.isCodeTask, true);
  assert.ok(hit.confidence >= 0.75);
  const repoHit = detectCodeTaskIntent('Dame en local https://github.com/open-webui/open-webui y sube los cambios a main cuando CI esté verde');
  assert.equal(repoHit.isCodeTask, true);
  assert.ok(repoHit.confidence >= 0.75);
  const miss = detectCodeTaskIntent('Explain quantum physics');
  assert.equal(miss.isCodeTask, false);
});

test('detectCodeTaskIntent catches Spanish repo automation requests', () => {
  const hit = detectCodeTaskIntent('Clona github.com/open-webui/open-webui en local, mejora el software, sube a main y vigila estatus verde');
  assert.equal(hit.isCodeTask, true);
  assert.ok(hit.confidence >= 0.75);
});

test('detectRunRequest finds run intent and valid requested ports', () => {
  assert.deepEqual(detectRunRequest('Clona el repo y dame la web en local 5000'), {
    wantsRun: true,
    requestedPort: 5000,
  });
  assert.deepEqual(detectRunRequest('start it at localhost:5173'), {
    wantsRun: true,
    requestedPort: 5173,
  });
  assert.deepEqual(detectRunRequest('clona el repo en puerto 80'), {
    wantsRun: true,
    requestedPort: null,
  });
  assert.deepEqual(detectRunRequest('solo clona el repo'), {
    wantsRun: false,
    requestedPort: null,
  });
});

test('chat-task-scope requires chatId unless global', async () => {
  const blocked = await chatTaskScope.assertChatScopeForAgentTask({ userId: 'u1', body: {} });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 400);

  const globalOk = await chatTaskScope.assertChatScopeForAgentTask({
    userId: 'u1',
    body: { scopeMode: 'global' },
  });
  assert.equal(globalOk.ok, true);
  assert.equal(globalOk.scopeMode, 'global');
});

test('runCodexPipeline emits plan and done phases with mocks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  process.env.CODEX_RUN_STORE_DIR = dir;

  const record = createRunRecord({
    userId: 'user-1',
    chatId: 'chat-1',
    goal: 'Implement health endpoint',
  });

  const events = [];
  const result = await runCodexPipeline(
    {
      runId: record.runId,
      userId: 'user-1',
      chatId: 'chat-1',
      goal: 'Implement health endpoint',
      taskId: 'task-1',
      onEvent: (e) => events.push(e),
    },
    {
      runAgentTaskJob: async () => ({ ok: true }),
      runVerification: async () => ({ ok: true, exitCode: 0 }),
      githubConnector: null,
    },
  );

  assert.equal(result.status, 'completed');
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'plan'));
  assert.ok(events.some((e) => e.type === 'done'));
});

test('runCodexPipeline clones, starts the requested port, and emits preview_ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-preview-'));
  process.env.CODEX_RUN_STORE_DIR = dir;

  const record = createRunRecord({
    userId: 'user-preview',
    chatId: null,
    goal: 'Clona https://github.com/acme/demo y dame la web en local 5000',
  });
  const events = [];
  const calls = [];
  const result = await runCodexPipeline(
    {
      runId: record.runId,
      userId: 'user-preview',
      goal: record.goal,
      allowRun: true,
      onEvent: (event) => events.push(event),
    },
    {
      githubAccessTokenFor: async () => null,
      harness: {
        parsePublicGithubRepo: () => ({
          owner: 'acme',
          repo: 'demo',
          webUrl: 'https://github.com/acme/demo',
          cloneUrl: 'https://github.com/acme/demo.git',
        }),
        clonePublicRepo: async (args) => {
          calls.push({ type: 'clone', args });
          return {
            workspacePath: '/runner/workspaces/run',
            commitSha: 'abc123',
            sourceBranch: 'main',
            authenticated: false,
          };
        },
      },
      previewTokenFor: () => 'preview-token',
      runner: {
        startDev: async (project, opts) => {
          calls.push({ type: 'startDev', project, opts });
          return { port: 5000 };
        },
        devStatus: async (project) => {
          calls.push({ type: 'devStatus', project });
          return { state: 'ready', ready: true, port: 5000 };
        },
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.status, 'completed');
  assert.equal(calls[0].type, 'clone');
  assert.equal(calls[1].type, 'startDev');
  assert.equal(calls[1].opts.requestedPort, 5000);
  assert.equal(calls[2].type, 'devStatus');
  assert.ok(events.some((event) => event.type === 'preview_ready' && event.port === 5000));
  assert.ok(events.some((event) => event.type === 'done' && event.port === 5000));
  assert.match(result.previewUrl, /\/api\/codex\/projects\/run-/);
});

test('runCodexPipeline records a stable preview failure code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-preview-fail-'));
  process.env.CODEX_RUN_STORE_DIR = dir;

  const record = createRunRecord({
    userId: 'user-preview-fail',
    goal: 'Clona https://github.com/acme/demo y dame la web en local 5000',
  });
  const events = [];
  const result = await runCodexPipeline(
    {
      runId: record.runId,
      userId: 'user-preview-fail',
      goal: record.goal,
      allowRun: true,
      onEvent: (event) => events.push(event),
    },
    {
      githubAccessTokenFor: async () => null,
      harness: {
        parsePublicGithubRepo: () => ({
          owner: 'acme',
          repo: 'demo',
          webUrl: 'https://github.com/acme/demo',
          cloneUrl: 'https://github.com/acme/demo.git',
        }),
        clonePublicRepo: async () => ({
          workspacePath: '/runner/workspaces/run',
          commitSha: 'abc123',
          sourceBranch: 'main',
          authenticated: false,
        }),
      },
      previewTokenFor: () => 'preview-token',
      runner: {
        startDev: async () => ({ port: 5000 }),
        devStatus: async () => ({ state: 'error', error: 'npm install failed' }),
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'preview_start_failed');
  assert.ok(events.some((event) => (
    event.type === 'preview_failed' && event.code === 'preview_start_failed'
  )));
});

test('runCodexPipeline skips runner execution without access and keeps classic clone path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-skip-'));
  process.env.CODEX_RUN_STORE_DIR = dir;

  const record = createRunRecord({
    userId: 'user-no-access',
    goal: 'Clona https://github.com/acme/demo y dame la web en local 5000',
  });
  const events = [];
  let cloneCalled = false;
  const result = await runCodexPipeline(
    {
      runId: record.runId,
      userId: 'user-no-access',
      goal: record.goal,
      allowRun: false,
      onEvent: (event) => events.push(event),
    },
    {
      cloneProject: async () => {
        cloneCalled = true;
        return { ok: true, path: '/classic/clone' };
      },
    },
  );

  assert.equal(result.status, 'completed');
  assert.equal(cloneCalled, true);
  assert.ok(events.some((event) => (
    event.type === 'run_skipped' && event.reason === 'codex_access_required'
  )));
  assert.ok(events.some((event) => event.type === 'clone_success' && event.path === '/classic/clone'));
});

test('codex run store persists events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
  process.env.CODEX_RUN_STORE_DIR = dir;
  const row = codexRunStore.writeRun({
    runId: 'run-test',
    userId: 'u1',
    goal: 'test',
    status: 'queued',
  });
  codexRunStore.appendEvent('run-test', { type: 'ping' });
  const loaded = codexRunStore.readRun('run-test');
  assert.equal(loaded.runId, row.runId);
  assert.equal(loaded.events.length, 1);
});
