'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'src/services/agents/agent-task-runner.js');
const ARTIFACT = { id: 'abcde01234567890', filename: 'qa.csv', format: 'csv', mime: 'text/csv', sizeBytes: 30, downloadUrl: '/api/agent/artifact/abcde01234567890' };
const OLD = { ...ARTIFACT, id: '1111101234567890' };
const QUEUED_AT = '2026-10-03T10:00:00.000Z';

async function workerFixture(t, { deterministic = false, failImport = false, blockImport = false, historyFailure = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-workspace-runner-'));
  const keys = ['NODE_ENV', 'OPENAI_API_KEY', 'AGENT_TASK_STORE_DIR', 'AGENT_TASK_AGENT_RUNNER', 'AGENT_TASK_MODEL_FAILOVER', 'AGENT_TASK_LLM_RECOVERY', 'ENTERPRISE_EXECUTION_STORE_DIR'];
  const oldEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { NODE_ENV: 'test', OPENAI_API_KEY: 'test-openai-key', AGENT_TASK_STORE_DIR: dir, ENTERPRISE_EXECUTION_STORE_DIR: path.join(dir, 'graphs'), AGENT_TASK_AGENT_RUNNER: '1', AGENT_TASK_MODEL_FAILOVER: '0', AGENT_TASK_LLM_RECOVERY: '0' });
  const imports = [], events = [], captures = [];
  let entered, release;
  const importing = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const prisma = {
    chat: { findFirst: async () => ({ id: 'chat-a', userId: 'user-a', title: 'Synthetic', coworkWorkspaceId: 'workspace-a' }) },
    message: { create: async ({ data }) => ({ id: 'message-a', ...data }), update: async ({ data }) => ({ id: 'message-a', ...data }) },
  };
  const persistence = { upsertAgentTask: async () => null, appendAgentTaskEvent: async () => null, persistGeneratedArtifact: async () => null };
  const originalLoad = Module._load;
  const intercept = function(request, parent) {
    if (request === '../../config/database' && parent?.filename === source) return prisma;
    if (request === './task-conversation-history') return { loadTaskConversationHistory: async (_db, args) => { captures.push(args); if (historyFailure) { const error = new Error('No pude recuperar el contexto de esta conversación. Reintenta antes de generar el archivo.'); error.code = 'E_HISTORY_UNAVAILABLE'; throw error; } return '\nSynthetic previous USER: id,units\n1,7'; } };
    if (request === '../cowork/workspace-store') return {
      ensureWorkspaceForChat: async (_db, args) => { assert.equal(args.userId, 'user-a'); assert.equal(args.chatId, 'chat-a'); return { id: 'workspace-a' }; },
      importAgentArtifact: async (_db, args) => {
        imports.push(args); entered(); if (blockImport) await waiting;
        if (failImport) throw new Error('Bearer private-token Cookie private-cookie');
        return { id: 'file-a', path: 'deliverables/qa.csv', currentVersion: 1, mime: 'text/csv', size: 30, artifactId: args.artifactId };
      },
    };
    if (request.endsWith('/agent-task-persistence')) return persistence;
    if (request === './task-contract-resolver' && parent?.filename === source) return { resolveTaskContract: async ({ fallback }) => ({ contract: fallback(), source: 'test-fallback' }) };
    if (request === './auto-document-delivery' && parent?.filename === source) return { generateAutoDocument: async () => { throw new Error('unexpected generic generation'); } };
    if (request === '../source-preserving-document-edit' && parent?.filename === source) return { isSourcePreservingEditRequest: () => false, tryGenerateSourcePreservingDocumentEdit: async () => null };
    if (request === '../agent-runner' && parent?.filename === source) {
      const actual = originalLoad.apply(this, arguments);
      return { ...actual, shouldRunAgentRunner: () => deterministic, hasConversationArtifacts: async () => false,
        executeAgentRunnerTurn: async ({ onEvent }) => { onEvent({ type: 'file_artifact', artifact: ARTIFACT }); return { ok: true, artifacts: [ARTIFACT], summary: 'Archivo listo.', steps: [], stoppedReason: 'agent_runner' }; } };
    }
    if (request === '../react-agent' && parent?.filename === source) return { run: async (_client, args) => {
      captures.push({ extraSystem: args.extraSystem });
      args.ctx.onEvent({ type: 'file_artifact', artifact: OLD });
      args.ctx.onEvent({ type: 'file_artifact', artifact: ARTIFACT });
      return { finalAnswer: 'Guardado en el workspace.', steps: [], stoppedReason: 'finalized' };
    } };
    return originalLoad.apply(this, arguments);
  };
  Module._load = intercept;
  for (const target of [source, path.join(ROOT, 'src/services/agents/task-store.js'), path.join(ROOT, 'src/services/agents/agent-task-workspace-delivery.js')]) delete require.cache[target];
  t.after(() => {
    Module._load = originalLoad;
    for (const key of keys) oldEnv[key] === undefined ? delete process.env[key] : process.env[key] = oldEnv[key];
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[source];
  });
  const { runAgentTaskJob } = require(source);
  const taskStore = require(path.join(ROOT, 'src/services/agents/task-store.js'));
  const append = taskStore.appendTaskEvent;
  taskStore.appendTaskEvent = (task, event) => { events.push(event); return append(task, event); };
  t.after(() => { taskStore.appendTaskEvent = append; });
  const run = () => runAgentTaskJob({ taskId: deterministic ? 'deterministic-delivery' : 'loop-delivery', createdAt: QUEUED_AT, user: { id: 'user-a' },
    goal: 'Crea un único archivo CSV descargable llamado qa.csv con los registros y guarda el archivo en el workspace.',
    displayGoal: 'Crea un único archivo CSV descargable llamado qa.csv con los registros y guarda el archivo en el workspace.',
    files: [], chatId: 'chat-a', model: 'gpt-4o', documentPolicy: { mode: 'doc_required', format: 'csv', autoGenerate: true }, maxSteps: 4, maxRuntimeMs: 60000 });
  return { run, imports, events, importing, release, captures, snapshot: () => taskStore.getTaskSnapshotForUser(deterministic ? 'deterministic-delivery' : 'loop-delivery', 'user-a') };
}

for (const deterministic of [false, true]) test(`the ${deterministic ? 'deterministic' : 'loop'} worker awaits workspace delivery before done`, async t => {
  const f = await workerFixture(t, { deterministic, blockImport: true });
  const running = f.run();
  // If no delivery starts the worker finishes; race proves the missing hook
  // without a longer test timeout or a fake successful import.
  const phase = await Promise.race([f.importing.then(() => 'import'), running.then(() => 'done')]);
  assert.equal(phase, 'import');
  assert.equal(f.events.some(e => e.type === 'done'), false);
  assert.equal(f.events.some(e => e.type === 'error'), false, 'finally must not close a task while delivery is pending');
  f.release();
  assert.equal((await running).status, 'completed');
  assert.equal(f.snapshot().status, 'completed');
  assert.equal(f.snapshot().streamState.error, undefined);
  assert.deepEqual(f.imports.map(item => item.artifactId), [ARTIFACT.id]);
  assert.equal(f.imports[0].workspaceId, 'workspace-a');
  assert.ok(f.events.some(e => e.type === 'cowork_file_changed'));
  if (!deterministic) {
    assert.deepEqual(f.captures[0], { userId: 'user-a', chatId: 'chat-a', taskId: 'loop-delivery', before: QUEUED_AT });
    assert.equal(f.snapshot().createdAt, QUEUED_AT);
    assert.match(f.captures[1].extraSystem, /Synthetic previous USER: id,units\n1,7/);
  }
});

test('workspace failure keeps the download but closes the worker as failed with a safe explanation', async t => {
  const f = await workerFixture(t, { failImport: true });
  assert.equal((await f.run()).status, 'failed');
  const done = f.events.find(e => e.type === 'done');
  assert.equal(done.stoppedReason, 'control_plane_error:workspace_delivery_failed');
  const answer = f.events.filter(e => e.type === 'final_text').at(-1).markdown;
  assert.match(answer, /no pude guardarlo/i);
  assert.doesNotMatch(answer, /Guardado en el workspace|private-token|private-cookie/);
  assert.ok(f.events.some(e => e.type === 'file_artifact' && e.artifact.id === ARTIFACT.id));
});


test('missing conversation history fails before the model can substitute invented source records', async t => {
  const f = await workerFixture(t, { historyFailure: true });
  await assert.rejects(f.run(), { code: 'E_HISTORY_UNAVAILABLE' });
  assert.equal(f.captures.some(item => Object.hasOwn(item, 'extraSystem')), false);
  assert.equal(f.imports.length, 0);
  assert.equal(f.events.some(e => e.type === 'done' || e.type === 'file_artifact'), false);
  const error = f.events.find(e => e.type === 'error');
  assert.equal(error.code, 'E_HISTORY_UNAVAILABLE');
  assert.match(error.message, /recuperar el contexto/);
});
