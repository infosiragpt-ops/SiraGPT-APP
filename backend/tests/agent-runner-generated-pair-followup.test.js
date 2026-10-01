'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-generated-pair-edit-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;
after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

const { saveArtifact } = require('../src/services/agents/task-tools');
const { fixturePair, saveReadableArtifact } = require('./helpers/readable-sav-xlsx-fixtures');
const { resolveTurnFiles, assertSelectedSavXlsxInputs } = require('../src/services/agent-runner/artifacts');

const EDIT_PAIR = 'En los dos archivos que acabas de entregar, cambia únicamente P01 del participante ID=1 de 4 a 5. Devuelve nuevos archivos .sav y .xlsx y comprueba que las 400 respuestas coincidan.';

async function artifact(filename, body, options = {}) {
  return saveReadableArtifact(filename, { ...options, token: body.replace(/\b(?:SAV|Excel|XLSX)\b/gi, '').trim() });
}

function delivery(id, files) {
  return { id, content: '```agent-task-state\n' + JSON.stringify({ artifacts: files, done: true }) + '\n```' };
}

function prismaFor(messages, rows = []) {
  return {
    chat: { findFirst: async ({ where }) => where.id === 'chat-a' && where.userId === 'owner' ? { id: 'chat-a' } : null },
    message: { findMany: async () => messages },
    generatedArtifact: { findMany: async ({ where }) => rows.filter((row) => row.chatId === where.chatId && row.userId === where.userId) },
  };
}

function editedFiles(prisma, options = {}) {
  return resolveTurnFiles({
    prisma,
    userId: options.userId || 'owner',
    chatId: options.chatId || 'chat-a',
    instruction: EDIT_PAIR,
    attachedFiles: [],
    objectStorage: { readFile: async (ref) => fs.promises.readFile(ref) },
  });
}

test('a paired SAV/XLSX edit mounts both validated binaries from the last delivery in one AgentRunner turn', async () => {
  const olderSav = await artifact('encuesta_20x20.sav', 'old SAV');
  const olderXlsx = await artifact('encuesta_20x20.xlsx', 'old Excel');
  const sav = await artifact('encuesta_20x20.sav', 'latest SAV');
  const xlsx = await artifact('encuesta_20x20.xlsx', 'latest Excel');
  const prisma = prismaFor([
    delivery('latest', [sav, xlsx]),
    delivery('older', [olderSav, olderXlsx]),
  ], [sav, xlsx, olderSav, olderXlsx].map((item) => ({ ...item, userId: 'owner', chatId: 'chat-a', taskId: null })));

  const resolved = await editedFiles(prisma);
  assert.deepEqual(new Set(resolved.priorArtifacts.map((file) => file.artifactId)), new Set([sav.id, xlsx.id]));
  assert.deepEqual(new Set(resolved.files.map((file) => file.artifactId)), new Set([sav.id, xlsx.id]));
  assert.deepEqual(resolved.files.find((file) => file.name.endsWith('.sav')).buffer, fs.readFileSync(sav.path));
  assert.deepEqual(resolved.files.find((file) => file.name.endsWith('.xlsx')).buffer, fs.readFileSync(xlsx.path));
  assert.ok(resolved.files.every((file) => file.isPriorArtifact === true));

  const equivalentWording = await resolveTurnFiles({
    prisma,
    userId: 'owner',
    chatId: 'chat-a',
    instruction: 'Cambia P01 en el SAV y Excel que acabas de entregar; conserva las demás respuestas',
    attachedFiles: [],
    objectStorage: { readFile: async (ref) => fs.promises.readFile(ref) },
  });
  assert.deepEqual(new Set(equivalentWording.files.map((file) => file.artifactId)), new Set([sav.id, xlsx.id]));
});

test('a paired edit can recover one validated DB delivery when its chat card is unavailable', async () => {
  const sav = await artifact('database.sav', 'DB SAV');
  const xlsx = await artifact('database.xlsx', 'DB Excel');
  const prisma = prismaFor([], [
    { ...xlsx, userId: 'owner', chatId: 'chat-a', taskId: 'task-latest', createdAt: new Date('2026-09-29T12:00:02Z') },
    { ...sav, userId: 'owner', chatId: 'chat-a', taskId: 'task-latest', createdAt: new Date('2026-09-29T12:00:01Z') },
  ]);

  const resolved = await editedFiles(prisma);
  assert.deepEqual(new Set(resolved.files.map((file) => file.artifactId)), new Set([sav.id, xlsx.id]));
  assert.ok(resolved.files.every((file) => file.isPriorArtifact === true));
});

test('a paired edit recovers a delivered pair grouped by messageId when taskId was never stored', async () => {
  const sav = await artifact('message.sav', 'message SAV');
  const xlsx = await artifact('message.xlsx', 'message Excel');
  const prisma = prismaFor([], [
    { ...xlsx, userId: 'owner', chatId: 'chat-a', taskId: null, messageId: 'assistant-latest', createdAt: new Date('2026-09-29T12:00:02Z') },
    { ...sav, userId: 'owner', chatId: 'chat-a', taskId: null, messageId: 'assistant-latest', createdAt: new Date('2026-09-29T12:00:01Z') },
  ]);

  const resolved = await editedFiles(prisma);
  assert.deepEqual(new Set(resolved.files.map((file) => file.artifactId)), new Set([sav.id, xlsx.id]));
});

test('a paired edit never joins two DB rows with different messageIds', async () => {
  const olderSav = await artifact('older-message.sav', 'older SAV');
  const newestXlsx = await artifact('newest-message.xlsx', 'newest Excel');
  const prisma = prismaFor([], [
    { ...newestXlsx, userId: 'owner', chatId: 'chat-a', taskId: null, messageId: 'assistant-newest', createdAt: new Date('2026-09-29T12:00:02Z') },
    { ...olderSav, userId: 'owner', chatId: 'chat-a', taskId: null, messageId: 'assistant-older', createdAt: new Date('2026-09-29T12:00:01Z') },
  ]);

  await assert.rejects(() => editedFiles(prisma), /SAV y el Excel|dos archivos|ambos archivos/);
});

test('a paired edit never fills a missing SAV from an older delivery', async () => {
  const olderSav = await artifact('old.sav', 'old SAV');
  const olderXlsx = await artifact('old.xlsx', 'old Excel');
  const latestXlsx = await artifact('latest.xlsx', 'latest Excel');
  const prisma = prismaFor([
    delivery('latest', [latestXlsx]),
    delivery('older', [olderSav, olderXlsx]),
  ], [latestXlsx, olderSav, olderXlsx].map((item) => ({ ...item, userId: 'owner', chatId: 'chat-a', taskId: null })));

  try {
    const resolved = await editedFiles(prisma);
    assert.ok(!resolved.priorArtifacts.some((file) => file.name.endsWith('.sav')));
    assert.ok(!resolved.files.some((file) => file.name.endsWith('.sav')));
  } catch (error) {
    assert.match(String(error), /SAV|Excel|par|entrega|archivo/i);
  }
});

test('a paired edit does not mount unvalidated or foreign-owner/chat artifact cards', async () => {
  const validSav = await artifact('valid.sav', 'valid SAV');
  const unvalidatedXlsx = await artifact('unvalidated.xlsx', 'bad Excel', { passed: false });
  const foreignXlsx = await artifact('foreign.xlsx', 'foreign Excel', { userId: 'other' });
  const otherChatXlsx = await artifact('other-chat.xlsx', 'other chat Excel', { chatId: 'chat-b' });
  const prisma = prismaFor([delivery('latest', [validSav, unvalidatedXlsx, foreignXlsx, otherChatXlsx])],
    [validSav, unvalidatedXlsx, foreignXlsx, otherChatXlsx].map((item) => ({ ...item, userId: 'owner', chatId: 'chat-a', taskId: null })));

  try {
    const resolved = await editedFiles(prisma);
    assert.ok(resolved.files.every((file) => file.artifactId === validSav.id));
    assert.ok(!resolved.files.some((file) => file.name.endsWith('.xlsx')));
  } catch (error) {
    assert.match(String(error), /SAV|Excel|par|entrega|archivo/i);
  }
});

test('a newly selected pair fails closed when either upload id is unreadable', () => {
  assert.throws(() => assertSelectedSavXlsxInputs({
    instruction: EDIT_PAIR,
    fileIds: ['selected-sav', 'selected-xlsx'],
    loadedFiles: [{ fileId: 'selected-xlsx', name: 'new.xlsx', buffer: Buffer.from('xlsx') }],
  }), /No pude abrir los dos archivos/);
  assert.throws(() => assertSelectedSavXlsxInputs({
    instruction: EDIT_PAIR,
    fileIds: ['selected-sav', 'selected-xlsx'],
    loadedFiles: [],
  }), /No pude abrir los dos archivos/);
});

test('one newly attached file never borrows the missing pair member from an older chat delivery', async () => {
  const sav = await artifact('old.sav', 'old SAV');
  const xlsx = await artifact('old.xlsx', 'old Excel');
  const prisma = prismaFor([delivery('old', [sav, xlsx])]);
  const uploadedXlsx = (await fixturePair('new-upload')).xlsx;
  await assert.rejects(() => resolveTurnFiles({
    prisma,
    userId: 'owner',
    chatId: 'chat-a',
    instruction: EDIT_PAIR,
    attachedFiles: [{ name: 'new.xlsx', buffer: uploadedXlsx }],
  }), /dos originales SAV y Excel/);
});

test('two explicit SAV and XLSX uploads replace the older generated pair as the complete edit source', async () => {
  const oldSav = await artifact('old.sav', 'generated SAV');
  const oldXlsx = await artifact('old.xlsx', 'generated Excel');
  const prisma = prismaFor([delivery('old', [oldSav, oldXlsx])],
    [oldSav, oldXlsx].map((item) => ({ ...item, userId: 'owner', chatId: 'chat-a', taskId: 'old-task' })));
  const attached = [
    { name: 'uploaded.sav', mime: 'application/x-spss-sav', buffer: (await fixturePair('uploaded')).sav },
    { name: 'uploaded.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: (await fixturePair('uploaded')).xlsx },
  ];

  const resolved = await resolveTurnFiles({
    prisma,
    userId: 'owner',
    chatId: 'chat-a',
    instruction: 'Modifica P01 en los archivos SAV y Excel adjuntos y guarda ambos',
    attachedFiles: attached,
    objectStorage: { readFile: async (ref) => fs.promises.readFile(ref) },
  });
  assert.equal(resolved.files.length, 2);
  assert.deepEqual(resolved.files, attached);
  assert.deepEqual(resolved.priorArtifacts, []);
  assert.equal(resolved.latest, null);
});

test('a forged passed:true on plaintext SAV/XLSX cannot become a validated edit source', async () => {
  const files = ['sav', 'xlsx'].map((format) => saveArtifact({ filename: `forged.${format}`,
    base64: Buffer.from('not a statistical or spreadsheet file').toString('base64'), ownerUserId: 'owner', chatId: 'chat-a', validation: { passed: true } }));
  assert.ok(files.every((file) => file.validation.passed === false));
  await assert.rejects(() => editedFiles(prismaFor([delivery('forged', files)])), /SAV y el Excel|dos archivos|ambos archivos/);
});
