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

// Contract C7: «¿qué dijo en el minuto 95?» about a 5-hour class reads THAT
// window from the segments sidecar, never the transcript's first minutes.
test('a question about a moment brings that window of a long transcript, marked so it is not cut again', async () => {
  const head = Array.from({ length: 400 }, (_, i) => `[00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:00] Párrafo inicial ${i}.`).join('\n\n');
  const prisma = prismaWith([{ id: 'clase', userId: 'u1', mimeType: 'video/mp4', originalName: 'clase.mp4', processingStage: 'ready', extractedText: head }]);
  const reads = [];
  const readWindow = async (args, opts) => {
    reads.push({ args, opts });
    return { ok: true, window: { start: opts.start, end: opts.end, label: '01:34:00–01:39:00' }, durationSec: 18000,
      text: '[01:35:00] Aquí explica la mitocondria.' };
  };
  const messages = [{ files: [media('clase')] }];
  const map = await loadHistoryMediaTranscripts(prisma, { userId: 'u1', messages, query: '¿qué dijo el profesor en el minuto 95?', readWindow });
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].args, { userId: 'u1', fileId: 'clase', fileName: 'clase.mp4' });
  assert.equal(reads[0].opts.start, 5640);
  assert.equal(reads[0].opts.end, 5940);
  assert.match(map.get('clase'), /^\[Tramo 01:34:00–01:39:00 de una grabación de 05:00:00: solo esta parte/);
  assert.match(map.get('clase'), /mitocondria/);
  assert.doesNotMatch(map.get('clase'), /Párrafo inicial/);
  assert.ok(map.windows.has('clase'));
});

test('without a moment, with a short transcript or when the window cannot be read, the stored text stays', async () => {
  const long = 'x'.repeat(9000);
  const prisma = prismaWith([
    { id: 'larga', userId: 'u1', mimeType: 'audio/mpeg', originalName: 'larga.mp3', processingStage: 'ready', extractedText: long },
    { id: 'corta', userId: 'u1', mimeType: 'audio/mpeg', originalName: 'corta.mp3', processingStage: 'ready', extractedText: 'Hola, nota corta.' },
  ]);
  const messages = [{ files: [media('larga'), media('corta')] }];
  const never = async () => assert.fail('no window without a moment in the question');
  const plain = await loadHistoryMediaTranscripts(prisma, { userId: 'u1', messages, query: 'resúmelo', readWindow: never });
  assert.equal(plain.get('larga'), long);
  assert.equal(plain.windows.size, 0);
  const failing = await loadHistoryMediaTranscripts(prisma, { userId: 'u1', messages, query: '¿qué dijo en el minuto 95?',
    readWindow: async ({ fileId }) => { assert.equal(fileId, 'larga', 'a short transcript is already whole'); return { ok: false, code: 'out_of_range' }; } });
  assert.equal(failing.get('larga'), long);
  assert.equal(failing.get('corta'), 'Hola, nota corta.');
  assert.equal(failing.windows.size, 0);
});
