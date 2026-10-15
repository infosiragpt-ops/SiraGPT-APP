'use strict';

// Integration seams between the chat turn, the media queue and the durable
// delivery: the record keeps what the deliverables must look like, and a
// turn that handed its work off does not send «Tarea terminada» hours
// before the transcript exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaDeliveryStore, normalizeNewRecord, FORMATS } = require('../src/services/media-delivery-store');
const taskStore = require('../src/services/agents/task-store');

test('a delivery record keeps the requested output (Word/PDF, subtitles, clip clock) and a safe link source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdi-'));
  const store = createMediaDeliveryStore({ root });
  const record = await store.create({ userId: 'u1', chatId: 'c1', fileIds: ['f1'], fileNames: ['clase.m4a'],
    formats: ['txt', 'pdf', 'srt'], output: { documentFormat: 'pdf', wantsSubtitles: true, timeOffsetSec: 3600 },
    source: { url: 'https://www.youtube.com/watch?v=x', host: 'www.youtube.com', title: 'Clase' } });
  assert.deepEqual(record.output, { documentFormat: 'pdf', wantsSubtitles: true, timeOffsetSec: 3600 });
  assert.deepEqual(record.source, { url: 'https://www.youtube.com/watch?v=x', host: 'www.youtube.com', title: 'Clase' });
  assert.ok(record.formats.includes('pdf'));
  assert.ok(FORMATS.includes('pdf'));
  const reread = await store.get(record.id);
  assert.deepEqual(reread.output, record.output);
});

test('junk output and non-http sources are dropped, never stored', () => {
  const record = normalizeNewRecord({ userId: 'u1', fileIds: ['f1'],
    output: { documentFormat: 'exe', wantsSubtitles: 'yes', timeOffsetSec: -5 }, source: { url: 'javascript:alert(1)' } });
  assert.deepEqual(record.output, { documentFormat: null, wantsSubtitles: false, timeOffsetSec: 0 });
  assert.equal(record.source, null);
  assert.deepEqual(normalizeNewRecord({ userId: 'u1', fileIds: ['f1'] }).output, { documentFormat: null, wantsSubtitles: false, timeOffsetSec: 0 });
});

test('a turn that handed a transcription off defers its «completed» notification to the delivery', () => {
  assert.equal(taskStore.deferredNotification({ stats: { stoppedReason: 'media_delivery_handoff' } }), true);
  assert.equal(taskStore.deferredNotification({ streamState: { stoppedReason: 'media_delivery_handoff' } }), true);
  assert.equal(taskStore.deferredNotification({ stats: { stoppedReason: 'transcription_finalize' } }), false);
  assert.equal(taskStore.deferredNotification({}), false);
});
