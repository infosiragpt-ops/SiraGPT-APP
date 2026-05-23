'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectCodeTaskIntent,
  runCodexPipeline,
  createRunRecord,
} = require('../src/services/codex/codex-run-orchestrator');
const codexRunStore = require('../src/services/codex/codex-run-store');
const chatTaskScope = require('../src/services/agents/chat-task-scope');

test('detectCodeTaskIntent flags coding prompts', () => {
  const hit = detectCodeTaskIntent('Please fix the bug in api.js and run npm test');
  assert.equal(hit.isCodeTask, true);
  assert.ok(hit.confidence >= 0.75);
  const miss = detectCodeTaskIntent('Explain quantum physics');
  assert.equal(miss.isCodeTask, false);
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
