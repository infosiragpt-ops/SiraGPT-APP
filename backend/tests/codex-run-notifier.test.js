'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildNotificationContent,
  createCodexRunNotifier,
} = require('../src/services/codex/codex-run-notifier');

test('buildNotificationContent maps outcomes to inbox content', () => {
  const done = buildNotificationContent({ outcome: 'completed', goal: 'Clona open-webui y arregla el bug' });
  assert.equal(done.type, 'codex_run_completed');
  assert.equal(done.severity, 'info');
  assert.ok(done.message.includes('open-webui'));

  const failed = buildNotificationContent({ outcome: 'failed', goal: 'x'.repeat(200) });
  assert.equal(failed.type, 'codex_run_failed');
  assert.equal(failed.severity, 'critical');
  assert.ok(failed.message.length < 200);
});

async function withTempStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notify-'));
  const prev = process.env.CODEX_RUN_STORE_DIR;
  process.env.CODEX_RUN_STORE_DIR = dir;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.CODEX_RUN_STORE_DIR;
    else process.env.CODEX_RUN_STORE_DIR = prev;
  }
}

function loadPipeline() {
  delete require.cache[require.resolve('../src/services/codex/codex-run-orchestrator')];
  // eslint-disable-next-line global-require
  const orchestrator = require('../src/services/codex/codex-run-orchestrator');
  const codexRunStore = require('../src/services/codex/codex-run-store');
  return { orchestrator, codexRunStore, createRecord: (params) => codexRunStore.writeRun({ status: 'queued', ...params }) };
}

test('notifyRunFinished delivers completed and failed through injected transport', async () => {
  const rows = [];
  const create = async (_prisma, args) => { rows.push(args); return { id: 'n1' }; };
  const { notifyRunFinished } = createCodexRunNotifier({ prisma: {}, createNotification: create });

  const ok = await notifyRunFinished({ userId: 'u1', chatId: 'c1', runId: 'r1', outcome: 'completed', goal: 'Mi tarea' });
  assert.deepEqual(rows[0].metadata, { runId: 'r1', chatId: 'c1' });
  assert.ok(ok.delivered);

  const bad = await notifyRunFinished({ userId: 'u1', runId: 'r2', outcome: 'failed' });
  assert.ok(bad.delivered);
  assert.equal(rows.length, 2);

  const invalid = await notifyRunFinished({ userId: 'u1', runId: 'r3', outcome: 'weird' });
  assert.equal(invalid.delivered, false);
  const noUser = await notifyRunFinished({ userId: '', runId: 'r4', outcome: 'completed' });
  assert.equal(noUser.delivered, false);
});

test('runCodexPipeline announces completion and failure via injected notifier', async () => {
  await withTempStore(async () => {
    const outcomes = [];
    const { orchestrator, codexRunStore, createRecord } = loadPipeline();
    const deps = {
      notifyRunFinished: async ({ userId, runId, outcome }) => {
        outcomes.push({ userId, runId, outcome });
      },
      runAgentTaskJob: async () => {},
    };

    createRecord({ runId: 'run-ok', userId: 'u1', goal: 'Refactoriza el endpoint de health y añade pruebas' });
    createRecord({ runId: 'run-fail', userId: 'u1', goal: 'Tarea que falla en ejecución' });
    await orchestrator.runCodexPipeline({
      runId: 'run-ok',
      userId: 'u1',
      chatId: 'c1',
      goal: 'Refactoriza el endpoint de health y añade pruebas',
      taskId: 't-ok',
    }, deps);

    await assert.rejects(
      orchestrator.runCodexPipeline({
        runId: 'run-fail',
        userId: 'u1',
        chatId: 'c1',
        goal: 'Tarea que falla en ejecución',
        taskId: 't-fail',
      }, {
        ...deps,
        runAgentTaskJob: async () => { throw new Error('sandbox exploded'); },
      }),
      /sandbox exploded/,
    );

    assert.deepEqual(outcomes, [
      { userId: 'u1', runId: 'run-ok', outcome: 'completed' },
      { userId: 'u1', runId: 'run-fail', outcome: 'failed' },
    ]);
    const failedRun = codexRunStore.readRun('run-fail');
    assert.equal(failedRun.status, 'failed');
  });
});

test('clone_repo path announces both success and failure', async () => {
  await withTempStore(async () => {
    const outcomes = [];
    const { orchestrator, codexRunStore, createRecord } = loadPipeline();
    const deps = {
      notifyRunFinished: async ({ runId, outcome }) => { outcomes.push({ runId, outcome }); },
      runAgentTaskJob: async () => {},
    };

    createRecord({ runId: 'run-clone-fail', userId: 'u1', goal: 'clona https://github.com/no-existe-jamas/rep-o-404' });
    await orchestrator.runCodexPipeline({
      runId: 'run-clone-fail',
      userId: 'u1',
      chatId: null,
      goal: 'clona https://github.com/no-existe-jamas/rep-o-404',
      taskId: 't-cf',
    }, deps);

    const row = codexRunStore.readRun('run-clone-fail');
    assert.equal(row.status, 'failed');
    assert.deepEqual(outcomes, [{ runId: 'run-clone-fail', outcome: 'failed' }]);
  });
});

test('notifier failure never breaks the pipeline', async () => {
  await withTempStore(async () => {
    const { orchestrator, codexRunStore, createRecord } = loadPipeline();
    const deps = {
      notifyRunFinished: async () => { throw new Error('notification down'); },
      runAgentTaskJob: async () => {},
    };

    createRecord({ runId: 'run-noisy', userId: 'u1', goal: 'Tarea con notificador roto para verificar resiliencia' });
    await orchestrator.runCodexPipeline({
      runId: 'run-noisy',
      userId: 'u1',
      chatId: null,
      goal: 'Tarea con notificador roto para verificar resiliencia',
      taskId: 't-noisy',
    }, deps);

    const row = codexRunStore.readRun('run-noisy');
    assert.equal(row.status, 'completed');
  });
});
