'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const stoppedReason of [
  'verification_failed:missing_evidence', 'resume_budget_exhausted',
  'invalid_resume_checkpoint', 'no_message', 'source_preserving_document_edit_failed',
  'agent_runner_failed', 'aborted',
]) {
  test(`worker preserves ${stoppedReason} with an attached document and no recovery side effects`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-outcome-worker-'));
    const env = {
      NODE_ENV: 'test', OPENAI_API_KEY: 'test-synthetic-no-network',
      AGENT_TASK_STORE_DIR: path.join(dir, 'tasks'),
      ENTERPRISE_EXECUTION_STORE_DIR: path.join(dir, 'execution'),
      AGENT_TASK_PRISMA_SYNC: '0', AGENT_TASK_ATTACHMENT_FASTPATH: '0',
      AGENT_TASK_LLM_RECOVERY: '0', AGENT_TASK_MODEL_FAILOVER: '0',
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
    const cached = require.cache[runnerPath];
    delete require.cache[runnerPath];
    t.after(() => {
      t.mock.restoreAll();
      if (cached) require.cache[runnerPath] = cached; else delete require.cache[runnerPath];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Exercise the real worker, event reducer and filesystem store. Provider
    // and attachment adapters are synthetic; this is not a live E2E claim.
    let networkCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => { networkCalls += 1; throw new Error('Network prohibited in outcome test'); });
    const context = [
      'La prediccion indica que las ventas del proximo trimestre subiran dieciocho por ciento con una campania digital semanal.',
      'Los resultados dependen de seguimiento comercial a clientes frecuentes y de la disponibilidad de inventario.',
      'Los riesgos son conversion rural baja, mayores costos publicitarios y retrasos de soporte para clientes nuevos.',
      'Se recomienda medir resultados cada semana, capacitar al personal y establecer un plan alternativo de distribucion.',
    ].join('\n');
    t.mock.method(require('../src/services/message-attachments'), 'buildUploadedFileContext', async () => context);
    const prisma = require('../src/config/database');
    const originalFindMany = prisma.file.findMany;
    prisma.file.findMany = async () => [{ id: 'fixture', originalName: 'informe.txt', mimeType: 'text/plain', extractedText: context }];
    t.after(() => { prisma.file.findMany = originalFindMany; });
    const persistence = require('../src/services/agents/agent-task-persistence');
    t.mock.method(persistence, 'upsertAgentTask', async () => null);
    t.mock.method(persistence, 'appendAgentTaskEvent', async () => null);
    let artifactsGenerated = 0;
    t.mock.method(require('../src/services/agents/auto-document-delivery'), 'generateAutoDocument', async () => {
      artifactsGenerated += 1;
      throw new Error('Document generation must not run after a failed/stopped outcome');
    });
    t.mock.method(require('../src/services/agents/task-contract-resolver'), 'resolveTaskContract', async ({ fallback }) => ({ contract: fallback(), source: 'synthetic-test' }));
    let engineCalls = 0;
    t.mock.method(require('../src/services/react-agent'), 'run', async () => {
      engineCalls += 1;
      return { finalAnswer: '', steps: [], stoppedReason };
    });

    const { runAgentTaskJob } = require(runnerPath);
    const taskId = `outcome-${stoppedReason.replace(/[^a-z_]/g, '')}`;
    const result = await runAgentTaskJob({
      taskId, user: { id: 'outcome-owner' },
      goal: 'Explica las tendencias de ventas y los riesgos comerciales de la prediccion adjunta.',
      files: ['fixture'], fileMetadata: [{ id: 'fixture', name: 'informe.txt', mimeType: 'text/plain' }],
      model: 'gpt-4o', maxSteps: 4, maxRuntimeMs: 60_000,
      documentPolicy: { mode: 'doc_required', format: 'docx', autoGenerate: true },
    });
    const snapshot = require('../src/services/agents/task-store').readTaskSnapshot(taskId);
    const expected = stoppedReason === 'aborted' ? 'cancelled' : 'failed';
    assert.equal(engineCalls, 1, 'fixture must reach the real worker ReAct boundary');
    assert.equal(result.status, expected);
    assert.equal(snapshot.status, expected);
    assert.equal(snapshot.streamState.stoppedReason, stoppedReason);
    assert.equal(snapshot.documentPolicy.autoGenerate, false);
    assert.equal(artifactsGenerated, 0);
    assert.equal(networkCalls, 0);
    assert.equal(snapshot.streamState.finalText, '');
    assert.equal(snapshot.events.some((event) => event.type === 'repair_attempt' && event.status === 'recovered'), false);
    assert.equal(snapshot.terminalMetricStatus, expected === 'cancelled' ? 'cancelled' : 'error');
  });
}
