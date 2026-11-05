'use strict';

// The browser-side audio extraction tells the server what the uploaded
// audio stands for (clientExtracted). The normaliser is strict: only the
// shape the composer produces, bounded strings and numbers, never throws.

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../src/services/client-extracted-metadata');

test('normalizeClientExtracted keeps the browser shape, bounds every field and rejects anything else', () => {
  assert.deepEqual(m.normalizeClientExtracted({ tier: 'opus', sourceName: 'Clase 3 (final).mp4', sourceSize: 3221225472, sourceType: 'video/mp4', codec: 'aac', durationSeconds: 36000.25 }),
    { tier: 'opus', sourceName: 'Clase 3 (final).mp4', sourceSize: 3221225472, sourceType: 'video/mp4', codec: 'aac', durationSeconds: 36000.25 });
  assert.deepEqual(m.normalizeClientExtracted({ tier: 'COPY', sourceName: '  a\u0000b.mov ', sourceSize: '512', sourceType: 'VIDEO/QUICKTIME', codec: 'pcm-s16', durationSeconds: -1 }),
    { tier: 'copy', sourceName: 'a b.mov', sourceSize: 512, sourceType: 'video/quicktime', codec: 'pcm-s16', durationSeconds: null });
  assert.equal(m.normalizeClientExtracted({ tier: 'opus', sourceName: 'x'.repeat(300), sourceSize: 1 }).sourceName.length, 255);
  assert.equal(m.normalizeClientExtracted({ tier: 'opus', sourceName: 'a.mp4', sourceSize: 1, codec: '<script>' }).codec, null);
  for (const bad of [null, 'opus', [], { tier: 'raw', sourceName: 'a', sourceSize: 1 }, { tier: 'opus', sourceSize: 1 }, { tier: 'opus', sourceName: 'a' }, { tier: 'opus', sourceName: 'a', sourceSize: -5 }, { tier: 'opus', sourceName: 'a', sourceSize: Number.POSITIVE_INFINITY }]) {
    assert.equal(m.normalizeClientExtracted(bad), null, JSON.stringify(bad));
  }
});

test('parseClientExtracted accepts an object or a JSON string; parseClientExtractedMap keys valid entries by file name', () => {
  assert.equal(m.parseClientExtracted(undefined), null);
  assert.equal(m.parseClientExtracted('not json'), null);
  assert.equal(m.parseClientExtracted('x'.repeat(5000)), null);
  assert.deepEqual(m.parseClientExtracted(JSON.stringify({ tier: 'opus', sourceName: 'a.mp4', sourceSize: 10 })).tier, 'opus');
  const map = m.parseClientExtractedMap(JSON.stringify({
    'clase.audio.ogg': { tier: 'opus', sourceName: 'clase.mp4', sourceSize: 100 },
    'bad.ogg': { tier: 'nope' },
    '': { tier: 'opus', sourceName: 'x', sourceSize: 1 },
  }));
  assert.deepEqual([...map.keys()], ['clase.audio.ogg']);
  assert.equal(map.get('clase.audio.ogg').sourceName, 'clase.mp4');
  assert.equal(m.parseClientExtractedMap('[1,2]').size, 0);
  assert.equal(m.parseClientExtractedMap({ 'a.ogg': { tier: 'copy', sourceName: 'a.mkv', sourceSize: 5 } }).size, 1);
});

test('parseClientExtractedField: an array aligned with the files wins (same names never swap); the map form stays for older tabs', () => {
  const field = m.parseClientExtractedField(JSON.stringify([
    { tier: 'opus', sourceName: 'Semana 1/Clase.mp4', sourceSize: 100 },
    null,
    { tier: 'opus', sourceName: 'Semana 2/Clase.mp4', sourceSize: 200 },
    { tier: 'nope' },
  ]));
  assert.equal(field.byIndex.length, 4);
  assert.equal(field.byIndex[0].sourceName, 'Semana 1/Clase.mp4');
  assert.equal(field.byIndex[1], null);
  assert.equal(field.byIndex[2].sourceSize, 200);
  assert.equal(field.byIndex[3], null, 'an invalid entry is null, never shifted');
  assert.equal(field.byName.size, 0);
  const legacy = m.parseClientExtractedField({ 'a.ogg': { tier: 'copy', sourceName: 'a.mkv', sourceSize: 5 } });
  assert.equal(legacy.byIndex, null);
  assert.equal(legacy.byName.get('a.ogg').sourceName, 'a.mkv');
  assert.deepEqual(m.parseClientExtractedField('{bad'), { byIndex: null, byName: new Map() });
  assert.equal(m.parseClientExtractedField(JSON.stringify(Array.from({ length: 900 }, () => null))).byIndex.length, 500);
});

test('frames of a video whose audio alone was uploaded fail with an explicit reason, not «not found»', async () => {
  const runtime = require('../src/services/agents/media-inspection-runtime');
  const rows = [{ id: 'f1', userId: 'u1', originalName: 'Clase 3.audio.ogg', mimeType: 'audio/ogg', path: '/tmp/x.ogg', deletedAt: null }];
  const prisma = {
    file: {
      findFirst: async ({ where }) => rows.find(row => row.id === where.id && row.userId === where.userId) || null,
      findMany: async ({ where }) => rows.filter(row => where.id.in.includes(row.id) && row.userId === where.userId),
    },
    documentAnalysis: {
      findMany: async ({ where }) => (where.fileId.in.includes('f1') && where.userId === 'u1'
        ? [{ metadata: { clientExtracted: { tier: 'opus', sourceName: 'Clase 3.mp4', sourceSize: 9e8, sourceType: 'video/mp4' } } }] : []),
    },
  };
  await assert.rejects(runtime.resolveOwnedMediaSource({ allowedKinds: ['video'] }, { userId: 'u1', fileIds: ['f1'], prisma }),
    (err) => err.code === 'MEDIA_ORIGINAL_NOT_UPLOADED' && /Clase 3\.mp4/.test(err.message));
  // A plain audio upload keeps the usual answer.
  prisma.documentAnalysis.findMany = async () => [];
  await assert.rejects(runtime.resolveOwnedMediaSource({ allowedKinds: ['video'] }, { userId: 'u1', fileIds: ['f1'], prisma }),
    (err) => err.code === 'MEDIA_FILE_NOT_FOUND');
});

test('a refine keeps the video provenance of its transcript; silent extracted audio is a final, explained failure', () => {
  const queue = require('../src/services/media-transcription-queue');
  const previous = { segments: [{ start: 0, end: 10, text: 'uno' }, { start: 10, end: 20, text: 'dos' }, { start: 20, end: 30, text: 'tres' }],
    durationSec: 30, coverage: 1, gaps: [], providers: { local: 3 }, engine: 'local', sourceMedia: 'video', sourceName: 'Clase.mp4' };
  const refined = { segments: [{ start: 10, end: 20, text: 'dos corregido' }], durationSec: 30, coverage: 1, gaps: [], providers: { local: 1 }, engine: 'local',
    refineSpans: [{ start: 10, end: 20 }] };
  const out = queue.spliceRefinedRange(previous, refined, { start: 10, end: 20 });
  assert.equal(out.sourceMedia, 'video');
  assert.equal(out.sourceName, 'Clase.mp4');
  assert.equal(queue.isTransientMediaError({ code: 'extracted_audio_no_speech' }), false);
});
