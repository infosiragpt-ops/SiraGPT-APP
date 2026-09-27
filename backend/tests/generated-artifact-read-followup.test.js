'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-artifact-followup-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;

const objectStorage = require('../src/services/object-storage');
const { saveArtifact, buildTaskTools, INTERNAL } = require('../src/services/agents/task-tools');
const { validateFinalize } = require('../src/services/agents/agentic-execution-profile');
const {
  isReadOnlyGeneratedArtifactFollowup,
  resolveReadOnlyGeneratedArtifactFollowup,
  buildGeneratedArtifactReadContext,
  requireGeneratedArtifactRead,
} = require('../src/services/agents/generated-artifact-followup');
const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');

test('files:[] comparison recovers both validated SAV and XLSX from this owner and chat', async () => {
  const ownerUserId = 'owner-followup';
  const chatId = 'chat-followup';
  const sav = saveArtifact({ filename: 'muestra.sav', base64: Buffer.from('SAV synthetic').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const xlsx = saveArtifact({ filename: 'muestra.xlsx', base64: Buffer.from('XLSX synthetic').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const foreign = saveArtifact({ filename: 'foreign.sav', base64: Buffer.from('foreign').toString('base64'), ownerUserId: 'other-owner', chatId, validation: { passed: true } });
  const otherChat = saveArtifact({ filename: 'other-chat.sav', base64: Buffer.from('other chat').toString('base64'), ownerUserId, chatId: 'another-chat', validation: { passed: true } });
  const failed = saveArtifact({ filename: 'failed.xlsx', base64: Buffer.from('failed').toString('base64'), ownerUserId, chatId, validation: { passed: false } });
  const rows = [
    { id: xlsx.id, filename: xlsx.filename, format: 'xlsx', taskId: 'task-pair', createdAt: new Date('2026-09-26T11:02:00Z') },
    { id: sav.id, filename: sav.filename, format: 'sav', taskId: 'task-pair', createdAt: new Date('2026-09-26T11:01:00Z') },
    { id: foreign.id, filename: foreign.filename, format: 'sav', taskId: 'task-pair', createdAt: new Date('2026-09-26T11:00:00Z') },
    { id: otherChat.id, filename: otherChat.filename, format: 'sav', taskId: 'task-pair', createdAt: new Date('2026-09-26T10:59:30Z') },
    { id: failed.id, filename: failed.filename, format: 'xlsx', taskId: 'task-pair', createdAt: new Date('2026-09-26T10:59:00Z') },
  ];
  let queriedWhere;
  const prisma = { generatedArtifact: { findMany: async ({ where }) => { queriedWhere = where; return rows; } } };
  const refs = await resolveReadOnlyGeneratedArtifactFollowup(prisma, {
    userId: ownerUserId,
    chatId,
    providedFileIds: [],
    goal: 'Sin crear ni modificar archivos: abre los dos archivos que acabas de entregar con pyreadstat.read_sav y openpyxl; compara los 400 valores del SAV y Excel.',
  });

  assert.deepEqual(queriedWhere, { userId: ownerUserId, chatId });
  assert.deepEqual(refs.map(({ id }) => id), [xlsx.id, sav.id]);
  assert.deepEqual(await resolveReadOnlyGeneratedArtifactFollowup(prisma, {
    userId: ownerUserId, chatId, providedFileIds: ['new-upload'], goal: 'Compara el SAV y Excel anteriores',
  }), []);
  assert.deepEqual(await resolveReadOnlyGeneratedArtifactFollowup(prisma, {
    userId: ownerUserId, chatId, providedFileIds: [], goal: '¿Cuánto es 2+2?',
  }), []);
  assert.deepEqual(await resolveReadOnlyGeneratedArtifactFollowup(prisma, {
    userId: ownerUserId, chatId, providedFileIds: [], goal: 'Abre los archivos subidos',
  }), [], 'an uploaded-file request must not be hijacked by generated files');
  const newerBatch = [{ ...rows[0], taskId: 'newer-task' }, ...rows.slice(1)];
  const latestOnly = await resolveReadOnlyGeneratedArtifactFollowup({ generatedArtifact: { findMany: async () => newerBatch } }, {
    userId: ownerUserId, chatId, providedFileIds: [], goal: 'Compara el SAV y Excel que acabas de entregar',
  });
  assert.deepEqual(latestOnly.map(({ id }) => id), [xlsx.id], 'never borrow the SAV from an older task');
  const incompleteContext = buildGeneratedArtifactReadContext(latestOnly, 'Compara el SAV y Excel que acabas de entregar');
  assert.match(incompleteContext, /Faltan.*\.sav/);
  assert.match(incompleteContext, /No puedes concluir que los archivos coinciden/);
  const latestPdf = saveArtifact({ filename: 'latest.pdf', base64: Buffer.from('latest').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const otherDelivery = await resolveReadOnlyGeneratedArtifactFollowup({ generatedArtifact: { findMany: async () => [
    { id: latestPdf.id, filename: latestPdf.filename, format: 'pdf', taskId: 'newer-task', createdAt: new Date('2026-09-26T11:03:00Z') },
    ...rows,
  ] } }, {
    userId: ownerUserId, chatId, providedFileIds: [], goal: 'Compara el SAV y Excel que acabas de entregar',
  });
  assert.deepEqual(otherDelivery, [], 'a newer PDF delivery must not resurrect the older SAV/XLSX pair');
  const latestImage = saveArtifact({ filename: 'latest.png', base64: Buffer.from('image').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const imageDelivery = await resolveReadOnlyGeneratedArtifactFollowup({ generatedArtifact: { findMany: async () => [
    { id: latestImage.id, filename: latestImage.filename, format: 'png', taskId: 'image-task', createdAt: new Date('2026-09-26T11:04:00Z') },
    ...rows,
  ] } }, {
    userId: ownerUserId, chatId, providedFileIds: [], goal: 'Abre los archivos que acabas de generar',
  });
  assert.deepEqual(imageDelivery, [], 'document follow-up never imports image artifacts or old documents');
  const editGoal = 'Abre y edita el Excel que acabas de entregar';
  assert.equal(isReadOnlyGeneratedArtifactFollowup(editGoal), false);
  assert.equal(isReadOnlyGeneratedArtifactFollowup('Abre el Excel que acabas de generar'), true);
  assert.deepEqual(await resolveReadOnlyGeneratedArtifactFollowup(prisma, {
    userId: ownerUserId, chatId, providedFileIds: [], goal: editGoal,
  }), []);
  const route = require('../src/routes/agent-task');
  assert.equal(route.INTERNAL.shouldResumeGeneratedArtifactForDocumentFollowup({
    goal: editGoal, providedFileIds: [], hasGeneratedArtifact: true,
  }), true, 'editing remains on source-preserving document continuation');

  const context = buildGeneratedArtifactReadContext(refs);
  assert.match(context, /muestra\.sav/);
  assert.match(context, /muestra\.xlsx/);
  assert.match(context, /ARTIFACT_FILES/);
  assert.doesNotMatch(context, new RegExp(`${sav.id}|${xlsx.id}`), 'internal artifact IDs must not enter model-visible context');
  const firstTool = buildTaskTools({ includeComputer: false, includeSkills: false })[0];
  assert.equal(firstTool.name, 'python_exec');
  assert.deepEqual(Object.keys(firstTool.parameters.properties).sort(), ['source', 'stdin', 'timeoutMs']);
  const finalizeProfile = requireGeneratedArtifactRead({ requiredTools: [] }, refs);
  assert.deepEqual(finalizeProfile.requiredTools, ['python_exec']);
  assert.equal(validateFinalize(finalizeProfile, []).ok, false);
  assert.equal(validateFinalize(finalizeProfile, [{ actions: [{ tool: 'python_exec', observation: { ok: false } }] }]).ok, false);
  assert.equal(validateFinalize(finalizeProfile, [{ actions: [{ tool: 'python_exec', observation: { ok: true } }] }]).ok, true);
});

test('python_exec reads both owner-scoped artifacts after their local copies move to object storage', async (t) => {
  const ownerUserId = 'owner-r2';
  const chatId = 'chat-r2';
  const sav = saveArtifact({ filename: 'values.sav', base64: Buffer.from('same 400 values').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const xlsx = saveArtifact({ filename: 'values.xlsx', base64: Buffer.from('same 400 values').toString('base64'), ownerUserId, chatId, validation: { passed: true } });
  const originals = new Map([[sav.id, fs.readFileSync(sav.path)], [xlsx.id, fs.readFileSync(xlsx.path)]]);
  const extensionById = new Map([[sav.id, '.sav'], [xlsx.id, '.xlsx']]);
  const previousToLocalTemp = objectStorage.toLocalTemp;
  t.after(() => { objectStorage.toLocalTemp = previousToLocalTemp; });
  for (const artifact of [sav, xlsx]) {
    const metaPath = INTERNAL.metadataPathFor(artifact.id);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.storageRef = `mock://${artifact.id}`;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    fs.rmSync(artifact.path);
  }
  objectStorage.toLocalTemp = async (ref) => {
    const id = String(ref).split('/').at(-1);
    const bytes = originals.get(id);
    if (!bytes) throw new Error('missing mock object');
    const destination = path.join(artifactDir, `hydrated-${id}${extensionById.get(id)}`);
    fs.writeFileSync(destination, bytes);
    return { path: destination, cleanup: async () => { fs.rmSync(destination, { force: true }); } };
  };
  const refs = [sav, xlsx].map(({ id, filename }) => ({ id, filename }));
  const output = await INTERNAL.pythonExec.execute({ source: [
    'from pathlib import Path',
    'assert len(ARTIFACT_FILES) == 2',
    'values = [Path(item["path"]).read_text() for item in ARTIFACT_FILES.values()]',
    'print("match=" + str(values[0] == values[1]).lower())',
  ].join('\n') }, { userId: ownerUserId, chatId, generatedArtifactRefs: refs });
  assert.equal(output.ok, true, output.stderr);
  assert.match(output.stdout, /match=true/);
  assert.equal(fs.existsSync(path.join(artifactDir, `hydrated-${sav.id}.sav`)), false);
  assert.equal(fs.existsSync(path.join(artifactDir, `hydrated-${xlsx.id}.xlsx`)), false);
  const redaction = await INTERNAL.pythonExec.execute({ source: 'print(ARTIFACT_FILES)' }, {
    userId: ownerUserId, chatId, generatedArtifactRefs: refs,
  });
  assert.equal(redaction.ok, true);
  assert.doesNotMatch(redaction.stdout, new RegExp(`${sav.id}|${xlsx.id}|hydrated-`));
  assert.match(redaction.stdout, /\[ruta interna\]/);

  const denied = await INTERNAL.pythonExec.execute({ source: 'print("ran")' }, {
    userId: 'other-owner', chatId, generatedArtifactRefs: refs,
  });
  assert.equal(denied.ok, false);
  assert.doesNotMatch(denied.stdout || '', /ran/);
  const wrongChat = await INTERNAL.pythonExec.execute({ source: 'print("ran")' }, {
    userId: ownerUserId, chatId: 'another-chat', generatedArtifactRefs: refs,
  });
  assert.equal(wrongChat.ok, false);
  assert.doesNotMatch(wrongChat.stdout || '', /ran/);
  const invalid = saveArtifact({ filename: 'not-validated.sav', base64: Buffer.from('untrusted').toString('base64'), ownerUserId, chatId, validation: { passed: false } });
  const unvalidated = await INTERNAL.pythonExec.execute({ source: 'print("ran")' }, {
    userId: ownerUserId, chatId, generatedArtifactRefs: [{ id: invalid.id, filename: invalid.filename }],
  });
  assert.equal(unvalidated.ok, false);
  assert.doesNotMatch(unvalidated.stdout || '', /ran/);
});

test('HTTP files:[] follow-up reaches the selected model runner without an OpenAI key', async (t) => {
  const envKeys = ['OPENAI_API_KEY', 'REDIS_URL', 'AGENT_TASK_INLINE', 'AGENT_TASK_STORE_DIR'];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const taskStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-artifact-http-'));
  delete process.env.OPENAI_API_KEY;
  delete process.env.REDIS_URL;
  delete process.env.AGENT_TASK_INLINE;
  process.env.AGENT_TASK_STORE_DIR = taskStoreDir;
  const auth = installAuthSessionMock();
  const prisma = require('../src/config/database');
  const runner = require('../src/services/agents/agent-task-runner');
  const persistence = require('../src/services/agents/agent-task-persistence');
  const taskStore = require('../src/services/agents/task-store');
  const originalChat = prisma.chat.findFirst;
  const originalArtifacts = prisma.generatedArtifact.findMany;
  const originalRun = runner.runAgentTaskJob;
  const originalUpsert = persistence.upsertAgentTask;
  const originalAppend = persistence.appendAgentTaskEvent;
  let selectedModel = null;
  t.after(() => {
    prisma.chat.findFirst = originalChat;
    prisma.generatedArtifact.findMany = originalArtifacts;
    runner.runAgentTaskJob = originalRun;
    persistence.upsertAgentTask = originalUpsert;
    persistence.appendAgentTaskEvent = originalAppend;
    auth.restore();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(taskStoreDir, { recursive: true, force: true });
  });
  const chatId = 'http-generated-chat';
  const sav = saveArtifact({ filename: 'http-values.sav', base64: Buffer.from('sav').toString('base64'), ownerUserId: auth.user.id, chatId, validation: { passed: true } });
  const xlsx = saveArtifact({ filename: 'http-values.xlsx', base64: Buffer.from('xlsx').toString('base64'), ownerUserId: auth.user.id, chatId, validation: { passed: true } });
  prisma.chat.findFirst = async ({ where }) => where?.id === chatId && where?.userId === auth.user.id ? { id: chatId } : null;
  prisma.generatedArtifact.findMany = async () => [xlsx, sav].map((artifact) => ({
    id: artifact.id,
    filename: artifact.filename,
    format: artifact.format,
    taskId: 'http-previous-delivery',
    createdAt: new Date(),
  }));
  persistence.upsertAgentTask = async () => null;
  persistence.appendAgentTaskEvent = async () => null;
  runner.runAgentTaskJob = async (payload) => {
    selectedModel = payload.model;
    assert.deepEqual(payload.files, []);
    const snapshot = taskStore.getTaskSnapshotForUser(payload.taskId, payload.user.id);
    const state = { ...snapshot.streamState, done: true };
    const done = { type: 'done', taskId: payload.taskId, stoppedReason: 'test', stats: {} };
    const written = taskStore.appendTaskEvent(snapshot, done, state);
    taskStore.markTaskStatus(written, 'completed', { streamState: state });
  };
  const app = buildRouteTestApp('/api/agent', reloadModule('../src/routes/agent-task'));
  const response = await request(app).post('/api/agent/task')
    .set('Authorization', auth.authHeader)
    .send({
      goal: 'Abre el SAV y el Excel que acabas de entregar y compara los 400 valores',
      files: [], chatId, model: 'grok-4.7', maxSteps: 3, maxRuntimeMs: 60000,
    });
  assert.equal(response.status, 200, response.text);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.equal(selectedModel, 'grok-4.7');
  assert.match(response.text, /done/);
});
