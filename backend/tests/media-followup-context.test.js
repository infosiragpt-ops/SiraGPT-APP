'use strict';

// A follow-up turn about an earlier recording («¿qué dijo sobre X?») must
// read its transcript. Attachment snapshots never carry media text, so the
// route re-loads it (owner-scoped, newest first, bounded) and the fallback
// copy never claims the recording «could not be transcribed».
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadHistoryMediaTranscripts, describeUnextractedAttachment } = require('../src/services/message-attachments');

function prismaWith(rows, calls = []) {
  return { file: { async findMany(args) {
    calls.push(args);
    return rows.filter(row => args.where.id.in.includes(row.id) && row.userId === args.where.userId && !row.deletedAt);
  } } };
}

const media = (id, extra = {}) => ({ id, name: `${id}.mp4`, mimeType: 'video/mp4', extractedText: null, ...extra });

test('re-loads transcripts of media attached earlier, owner-scoped and narrow', async () => {
  const calls = [];
  const prisma = prismaWith([
    { id: 'clase', userId: 'u1', mimeType: 'video/mp4', originalName: 'clase.mp4', processingStage: 'ready', extractedText: '[00:00:01] Hoy hablamos de la mitocondria.' },
    { id: 'ajeno', userId: 'u2', mimeType: 'video/mp4', originalName: 'ajeno.mp4', processingStage: 'ready', extractedText: 'Privado de otra persona.' },
  ], calls);
  const messages = [{ files: JSON.stringify([media('clase'), media('ajeno')]) }];
  const map = await loadHistoryMediaTranscripts(prisma, { userId: 'u1', messages });
  assert.equal(map.get('clase'), '[00:00:01] Hoy hablamos de la mitocondria.');
  assert.equal(map.has('ajeno'), false);
  assert.equal(calls[0].where.userId, 'u1');
  assert.equal(calls[0].where.deletedAt, null);
  assert.equal(calls[0].select.extractedText, true);
});

test('skips documents, attachments that already carry text, unfinished or failed transcripts, and caps the newest files', async () => {
  const calls = [];
  const prisma = prismaWith([
    { id: 'pendiente', userId: 'u1', mimeType: 'audio/mpeg', originalName: 'p.mp3', processingStage: 'extracting', extractedText: null },
    { id: 'fallido', userId: 'u1', mimeType: 'audio/mpeg', originalName: 'f.mp3', processingStage: 'failed', extractedText: 'parcial' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, userId: 'u1', mimeType: 'audio/mpeg', originalName: `a${i}.mp3`, processingStage: 'ready', extractedText: `texto ${i}` })),
  ], calls);
  const messages = [
    { files: [media('a0'), media('a1'), { id: 'doc', name: 'informe.pdf', mimeType: 'application/pdf' }] },
    { files: [media('a2'), media('ya', { extractedText: 'ya tiene texto' })] },
    { files: [media('pendiente'), media('fallido')] },
    { files: ['a3', media('a4'), media('a5'), media('a6'), media('a7')] },
  ];
  const map = await loadHistoryMediaTranscripts(prisma, { userId: 'u1', messages, maxFiles: 6 });
  const asked = calls[0].where.id.in;
  assert.equal(asked.length, 6, 'bounded');
  assert.ok(!asked.includes('doc') && !asked.includes('ya'));
  assert.deepEqual(asked.slice(0, 4), ['a3', 'a4', 'a5', 'a6'], 'newest message first');
  assert.equal(map.has('pendiente'), false);
  assert.equal(map.has('fallido'), false);
});

test('never throws and returns an empty map without prisma, user or history', async () => {
  assert.equal((await loadHistoryMediaTranscripts(null, { userId: 'u1', messages: [{ files: [media('x')] }] })).size, 0);
  assert.equal((await loadHistoryMediaTranscripts(prismaWith([]), { messages: [{ files: [media('x')] }] })).size, 0);
  const broken = { file: { async findMany() { throw new Error('db down'); } } };
  assert.equal((await loadHistoryMediaTranscripts(broken, { userId: 'u1', messages: [{ files: [media('x')] }] })).size, 0);
});

test('the fallback copy for media without a transcript never says it could not be transcribed', () => {
  const text = describeUnextractedAttachment({ name: 'clase.mp4', mimeType: 'video/mp4' });
  assert.match(text, /no está disponible en este turno/);
  assert.doesNotMatch(text, /no se obtuvo/);
  assert.match(text, /No inventes su contenido/);
});
