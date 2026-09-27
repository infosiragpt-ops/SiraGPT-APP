'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-artifact-followup-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;

const objectStorage = require('../src/services/object-storage');
const { saveArtifact, buildTaskTools, INTERNAL } = require('../src/services/agents/task-tools');
const { validateFinalize } = require('../src/services/agents/agentic-execution-profile');
const {
  resolveReadOnlyGeneratedArtifactFollowup,
  buildGeneratedArtifactReadContext,
  requireGeneratedArtifactRead,
} = require('../src/services/agents/generated-artifact-followup');

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
    const destination = path.join(artifactDir, `hydrated-${id}`);
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
  assert.equal(fs.existsSync(path.join(artifactDir, `hydrated-${sav.id}`)), false);
  assert.equal(fs.existsSync(path.join(artifactDir, `hydrated-${xlsx.id}`)), false);
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
