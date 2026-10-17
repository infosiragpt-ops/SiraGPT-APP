'use strict';

// A long section of a link (≥ 20 min, up to 12 h) leaves the chat turn: the
// clip becomes the user's media file, the durable queue transcribes it and
// the result is delivered into the chat. Short sections stay inline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../src/services/agent-harness/tools/transcribe-url-tool');

const URL = 'https://www.youtube.com/watch?v=clase5h';

function setup({ duration = 5 * 3600, env = {}, handoff, ctx = { userId: 'u1', chatId: 'c1' }, probe } = {}) {
  const calls = [];
  const handed = [];
  const transcribed = [];
  const probed = [];
  const runCommand = async (bin, args, { cwd } = {}) => {
    calls.push({ bin, args });
    if (bin === 'yt-dlp' && args.includes('--dump-single-json')) return { code: 0, stdout: JSON.stringify({ duration, title: 'Clase de Bioquímica' }), stderr: '' };
    if (bin === 'yt-dlp') { fs.writeFileSync(path.join(cwd, 'source.webm'), 'audio'); return { code: 0, stdout: '', stderr: '' }; }
    if (bin === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], 'aac'); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected ${bin}`);
  };
  const deps = {
    runCommand, dnsCheck: async () => true, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tud-')),
    env: { TRANSCRIBE_URL_MAX_SECONDS: String(3 * 3600), ...env },
    discoverMedia: async () => ({ ok: false, reason: 'no_media_found', candidates: [], loginWall: false }),
    cookieJar: { save: async () => ({ hosts: [] }), load: async () => null }, loadAttachedCookies: async () => null,
    computer: null, capture: null,
    probeDuration: async (filePath) => { probed.push(filePath); return probe ? probe(filePath) : 0; },
    transcribe: async (filePath, mime, name) => { transcribed.push(name); return { ok: true, method: 'local', transcript: 'Hola.', segments: [] }; },
    saveArtifact: (input) => ({ id: 'a1', filename: input.filename, mime: input.mime, format: 'txt', sizeBytes: 1, downloadUrl: '/a1' }),
    durableHandoff: handoff === undefined ? async (payload) => {
      handed.push({ ...payload, clipExists: fs.existsSync(payload.clipPath) });
      return { ok: true, fileId: 'f1', deliveryId: 'md_1', message: 'Recibí «Clase de Bioquímica» (≈5 h). Te aviso aquí.' };
    } : handoff,
  };
  return { deps, ctx, calls, handed, transcribed, probed };
}

test('a 5-hour link is accepted and handed to the durable queue instead of «media_too_long»', async () => {
  const s = setup();
  const result = await tool.executeTranscribeUrl({ url: URL }, s.ctx, s.deps);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.delivery, 'md_1');
  assert.equal(result.fileId, 'f1');
  assert.match(result.userMessage, /Te aviso aquí/);
  assert.equal(s.transcribed.length, 0, 'nothing is transcribed inside the chat turn');
  assert.equal(s.handed.length, 1);
  assert.equal(s.handed[0].clipExists, true, 'the clip exists while the hand-off copies it');
  assert.equal(s.handed[0].spanSec, 5 * 3600);
  assert.equal(s.handed[0].sectioned, false);
});

test('a requested section keeps the recording clock (offset) and is handed off when long', async () => {
  const s = setup();
  const result = await tool.executeTranscribeUrl({ url: URL, start: '1:00:00', end: '2:30:00', subtitles: true }, s.ctx, s.deps);
  assert.equal(result.deferred, true);
  assert.equal(s.handed[0].rangeStart, 3600);
  assert.equal(s.handed[0].rangeEnd, 9000);
  assert.equal(s.handed[0].sectioned, true);
  assert.equal(s.handed[0].subtitles, true);
});

test('short sections stay inline', async () => {
  const s = setup();
  const result = await tool.executeTranscribeUrl({ url: URL, start: '10:00', end: '15:00' }, s.ctx, s.deps);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, undefined);
  assert.equal(s.handed.length, 0);
  assert.equal(s.transcribed.length, 1);
});

test('a failed hand-off falls back inline when the section fits, and says «media_too_long» only when it does not', async () => {
  const failing = async () => { throw new Error('queue down'); };
  const fits = setup({ duration: 2 * 3600, handoff: failing });
  const inline = await tool.executeTranscribeUrl({ url: URL }, fits.ctx, fits.deps);
  assert.equal(inline.ok, true);
  assert.equal(fits.transcribed.length, 1);
  const tooLong = setup({ handoff: async () => ({ ok: false, reason: 'delivery_disabled' }) });
  const refused = await tool.executeTranscribeUrl({ url: URL }, tooLong.ctx, tooLong.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'media_too_long');
  assert.equal(tooLong.transcribed.length, 0);
});

test('without a chat (or with the kill switch) the inline ceiling applies as before', async () => {
  const noChat = setup({ ctx: { userId: 'u1' } });
  assert.equal((await tool.executeTranscribeUrl({ url: URL }, noChat.ctx, noChat.deps)).code, 'media_too_long');
  const off = setup({ env: { TRANSCRIBE_URL_DURABLE: '0' } });
  assert.equal((await tool.executeTranscribeUrl({ url: URL }, off.ctx, off.deps)).code, 'media_too_long');
  assert.equal(noChat.handed.length + off.handed.length, 0);
});

test('durable limits are configurable', () => {
  assert.deepEqual(tool.durableConfig({}, { userId: 'u', chatId: 'c' }), { enabled: true, minSeconds: 1200, maxSeconds: 43200 });
  assert.deepEqual(tool.durableConfig({ TRANSCRIBE_URL_DURABLE_MIN_SECONDS: '600', TRANSCRIBE_URL_DURABLE_MAX_SECONDS: '7200' }, { userId: 'u', chatId: 'c' }),
    { enabled: true, minSeconds: 600, maxSeconds: 7200 });
  assert.equal(tool.durableConfig({}, { userId: 'u' }).enabled, false);
});

// ── streams of unknown length are measured, never taken as 12 h ──────────

test('a stream of unknown length is measured: a short clip stays inline with its real range', async () => {
  const s = setup({ duration: null, probe: async () => 300 });
  const result = await tool.executeTranscribeUrl({ url: URL }, s.ctx, s.deps);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, undefined, 'a 5-minute clip is not handed off as a 12-hour recording');
  assert.equal(s.handed.length, 0);
  assert.equal(s.transcribed.length, 1);
  assert.equal(s.probed.length, 1);
  assert.equal(result.range.label, '00:00 → 05:00');
});

test('a long stream of unknown length is handed off with its measured duration', async () => {
  const s = setup({ duration: null, probe: async () => 2 * 3600 });
  const result = await tool.executeTranscribeUrl({ url: URL }, s.ctx, s.deps);
  assert.equal(result.deferred, true);
  assert.equal(s.handed[0].spanSec, 2 * 3600);
  assert.equal(s.handed[0].rangeEnd, 2 * 3600);
  assert.equal(result.range.label, '00:00 → 2:00:00');
});

test('an unmeasurable stream is transcribed inline, never refused as «media_too_long»', async () => {
  const s = setup({ duration: null, probe: async () => 0, handoff: async () => ({ ok: false, reason: 'delivery_disabled' }) });
  const result = await tool.executeTranscribeUrl({ url: URL }, s.ctx, s.deps);
  assert.equal(result.ok, true);
  assert.equal(s.transcribed.length, 1);
});

// ── the default hand-off: delivery first, offset recorded, nothing left behind ──

function handoffServices({ createDelivery, enqueue, claim } = {}) {
  const log = [];
  const files = new Map();
  const failedRecords = [];
  const created = [];
  const prisma = { file: {
    create: async ({ data }) => { const row = { id: `file${files.size + 1}`, deletedAt: null, ...data }; files.set(row.id, row); log.push('file.create'); return row; },
    delete: async ({ where }) => { files.delete(where.id); log.push('file.delete'); return { id: where.id }; },
    update: async () => { throw new Error('soft delete not expected'); },
    findFirst: async ({ where }) => { const row = files.get(where.id); return row && row.userId === where.userId && !row.deletedAt ? { id: row.id } : null; },
  } };
  const transcriptStore = { recordMediaClipOffset: async ({ timeOffsetSec }) => { log.push(`offset:${timeOffsetSec}`); return { ok: true, timeOffsetSec }; } };
  const store = {
    claim: claim || (async () => ({ token: 't1' })),
    markFailed: async (id, token, error, opts) => { failedRecords.push({ id, token, code: error.code, maxAttempts: opts.maxAttempts }); log.push('delivery.cancel'); return { status: 'failed' }; },
  };
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    createDelivery: async (record) => { log.push('delivery.create'); created.push(record); return createDelivery ? createDelivery(record) : { id: 'md_9', ...record }; },
    getMediaDeliveryService: () => ({ store }),
    estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
    handOffMessage: ({ fileNames }) => `Recibí «${fileNames[0]}». Te aviso aquí.`,
  };
  const enqueueMediaTranscription = async (payload) => { log.push('enqueue'); log.payload = payload; return enqueue ? enqueue(payload) : { queued: true }; };
  return { services: { prisma, delivery, transcriptStore, enqueueMediaTranscription }, log, files, failedRecords, created };
}

function handoffInput(services, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tud-handoff-'));
  const clipPath = path.join(dir, 'clip.m4a');
  fs.writeFileSync(clipPath, 'aac');
  const uploadDir = path.join(dir, 'uploads');
  return { uploadDir, input: { clipPath, title: 'Clase', url: new globalThis.URL(URL), rangeStart: 3600, rangeEnd: 9000, spanSec: 5400,
    sectioned: true, subtitles: false, ctx: { userId: 'u1', chatId: 'c1' }, env: { UPLOAD_DIR: uploadDir }, services, ...overrides } };
}

const userCopies = (uploadDir) => (fs.existsSync(path.join(uploadDir, 'u1')) ? fs.readdirSync(path.join(uploadDir, 'u1')).filter(name => name.startsWith('link-')) : []);

test('the hand-off records the clip offset and the delivery before the job, and queues it on the recording clock', async () => {
  const h = handoffServices();
  const { input, uploadDir } = handoffInput(h.services);
  const result = await tool.defaultDurableHandoff(input);
  assert.equal(result.ok, true);
  assert.equal(result.deliveryId, 'md_9');
  assert.match(result.message, /Te aviso aquí/);
  assert.deepEqual(h.log.slice(0, 4), ['file.create', 'offset:3600', 'delivery.create', 'enqueue']);
  assert.deepEqual(h.log.payload, { fileId: result.fileId, userId: 'u1', timeOffsetSec: 3600 });
  assert.equal(h.created[0].output.timeOffsetSec, 0, 'the stored transcript is already on the recording clock');
  assert.equal(userCopies(uploadDir).length, 1);
});

test('a delivery that cannot be created leaves no File, no copy and no job behind', async () => {
  for (const createDelivery of [async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, async () => null]) {
    const h = handoffServices({ createDelivery });
    const { input, uploadDir } = handoffInput(h.services);
    const result = await tool.defaultDurableHandoff(input);
    assert.equal(result.ok, false);
    assert.ok(!h.log.includes('enqueue'), 'nothing is queued, so the inline fallback has no twin');
    assert.ok(h.log.includes('file.delete'));
    assert.ok(h.log.includes('offset:0'), 'the offset record is removed');
    assert.equal(h.files.size, 0);
    assert.deepEqual(userCopies(uploadDir), []);
  }
});

test('a queue that refuses the job cancels the delivery silently and removes the File', async () => {
  const h = handoffServices({ enqueue: async () => { throw Object.assign(new Error('redis down'), { code: 'media_queue_unavailable' }); } });
  const { input, uploadDir } = handoffInput(h.services);
  const result = await tool.defaultDurableHandoff(input);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'media_queue_unavailable');
  assert.deepEqual(h.failedRecords, [{ id: 'md_9', token: 't1', code: 'queue_unavailable', maxAttempts: 1 }]);
  assert.equal(h.files.size, 0);
  assert.deepEqual(userCopies(uploadDir), []);
});

test('when the delivery cannot be cancelled the hand-off stands (reconcile re-queues the File) instead of a twin inline run', async () => {
  const h = handoffServices({ enqueue: async () => { throw new Error('redis down'); }, claim: async () => null });
  const { input, uploadDir } = handoffInput(h.services);
  const result = await tool.defaultDurableHandoff(input);
  assert.equal(result.ok, true);
  assert.equal(h.files.size, 1);
  assert.equal(userCopies(uploadDir).length, 1);
});

test('the clip offset survives in the real store for a job that reconcile re-queues without it', async () => {
  const store = require('../src/services/media-transcript-store');
  const h = handoffServices();
  const { input, uploadDir } = handoffInput({ ...h.services, transcriptStore: store });
  const result = await tool.defaultDurableHandoff(input);
  assert.equal(result.ok, true);
  assert.equal(await store.readMediaClipOffset({ fileId: result.fileId, userId: 'u1', env: { UPLOAD_DIR: uploadDir } }), 3600);
  // A whole recording (no section) records nothing.
  const whole = handoffServices();
  const plain = handoffInput({ ...whole.services, transcriptStore: store }, { sectioned: false, rangeStart: 0, rangeEnd: null });
  const second = await tool.defaultDurableHandoff(plain.input);
  assert.equal(await store.readMediaClipOffset({ fileId: second.fileId, userId: 'u1', env: { UPLOAD_DIR: plain.uploadDir } }), 0);
  assert.deepEqual(whole.log.payload, { fileId: second.fileId, userId: 'u1', timeOffsetSec: 0 });
});
