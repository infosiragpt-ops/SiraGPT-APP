const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate generated files to a temp dir BEFORE requiring the module (audioDir
// is resolved at module load from UPLOAD_DIR).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-minimax-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.MINIMAX_API_KEY = 'test-minimax-key';

const minimax = require('../src/services/ai/minimax-music');

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from('not-audio'),
  };
}

test('generateMinimaxMusicFile: posts the official body and downloads the mp3', async () => {
  const captured = {};
  const result = await minimax.generateMinimaxMusicFile({
    prompt: 'epic orchestral trailer',
    durationSeconds: 30,
    fetchImpl: async (url, opts) => {
      if (String(url).includes('/v1/music_generation')) {
        captured.url = url;
        captured.opts = opts;
        captured.body = JSON.parse(opts.body);
        return jsonResponse({ base_resp: { status_code: 0, status_msg: 'success' }, audio_url: 'https://cdn.test/track.mp3' });
      }
      captured.downloadUrl = url;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('ID3-minimax-bytes') };
    },
  });
  assert.equal(captured.url, 'https://api.minimax.io/v1/music_generation');
  assert.equal(captured.opts.headers.Authorization, 'Bearer test-minimax-key');
  assert.equal(captured.body.model, minimax.MINIMAX_MUSIC_MODEL);
  assert.equal(captured.body.prompt, 'epic orchestral trailer');
  assert.equal(captured.body.lyrics_optimizer, true);
  assert.equal(captured.body.output_format, 'url');
  assert.equal(captured.body.audio_setting.format, 'mp3');
  assert.equal(captured.downloadUrl, 'https://cdn.test/track.mp3');
  assert.equal(result.mime, 'audio/mpeg');
  assert.equal(result.modelLabel, 'MiniMax');
  assert.equal(result.modelKey, 'minimax');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.equal(fs.readFileSync(result.audioPath).toString(), 'ID3-minimax-bytes');
});

test('generateMinimaxMusicFile: surfaces base_resp failures', async () => {
  await assert.rejects(
    () => minimax.generateMinimaxMusicFile({
      prompt: 'x',
      fetchImpl: async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'balance insufficient' } }),
    }),
    (err) => err.code === 'INSUFFICIENT_CREDITS'
  );
});

test('generateMinimaxMusicFile: decodes inline hex audio without downloading', async () => {
  const hex = Buffer.from('ID3-inline').toString('hex');
  const result = await minimax.generateMinimaxMusicFile({
    prompt: 'x',
    fetchImpl: async () => jsonResponse({ base_resp: { status_code: 0 }, audio: hex }),
  });
  assert.equal(fs.readFileSync(result.audioPath).toString(), 'ID3-inline');
});

test('generateMinimaxMusicFile: rejects empty prompt, missing key and empty audio', async () => {
  await assert.rejects(
    () => minimax.generateMinimaxMusicFile({ prompt: '   ', fetchImpl: async () => jsonResponse({}) }),
    (err) => err.code === 'PROMPT_REQUIRED'
  );
  const saved = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  try {
    assert.equal(minimax.isMinimaxConfigured(), false);
    await assert.rejects(
      () => minimax.generateMinimaxMusicFile({ prompt: 'x', fetchImpl: async () => jsonResponse({}) }),
      (err) => err.code === 'MINIMAX_NOT_CONFIGURED'
    );
  } finally {
    process.env.MINIMAX_API_KEY = saved;
  }
  await assert.rejects(
    () => minimax.generateMinimaxMusicFile({
      prompt: 'x',
      fetchImpl: async () => jsonResponse({ base_resp: { status_code: 0 } }),
    }),
    (err) => err.code === 'EMPTY_AUDIO'
  );
});

test('classifyMinimaxError: mapping covers music failures', () => {
  assert.equal(minimax.classifyMinimaxError(402, ''), 'INSUFFICIENT_CREDITS');
  assert.equal(minimax.classifyMinimaxError(200, 'balance insufficient'), 'INSUFFICIENT_CREDITS');
  assert.equal(minimax.classifyMinimaxError(429, ''), 'RATE_LIMITED');
  assert.equal(minimax.classifyMinimaxError(400, ''), 'INVALID_PARAMS');
  assert.equal(minimax.classifyMinimaxError(500, ''), 'API_ERROR');
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
