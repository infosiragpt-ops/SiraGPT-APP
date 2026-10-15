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

function setup({ duration = 5 * 3600, env = {}, handoff, ctx = { userId: 'u1', chatId: 'c1' } } = {}) {
  const calls = [];
  const handed = [];
  const transcribed = [];
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
    transcribe: async (filePath, mime, name) => { transcribed.push(name); return { ok: true, method: 'local', transcript: 'Hola.', segments: [] }; },
    saveArtifact: (input) => ({ id: 'a1', filename: input.filename, mime: input.mime, format: 'txt', sizeBytes: 1, downloadUrl: '/a1' }),
    durableHandoff: handoff === undefined ? async (payload) => {
      handed.push({ ...payload, clipExists: fs.existsSync(payload.clipPath) });
      return { ok: true, fileId: 'f1', deliveryId: 'md_1', message: 'Recibí «Clase de Bioquímica» (≈5 h). Te aviso aquí.' };
    } : handoff,
  };
  return { deps, ctx, calls, handed, transcribed };
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
