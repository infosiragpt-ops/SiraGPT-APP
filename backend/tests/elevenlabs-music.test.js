const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate generated files to a temp dir BEFORE requiring the module (audioDir
// is resolved at module load from UPLOAD_DIR).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-music-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.ELEVENLABS_API_KEY = 'test-key';

const music = require('../src/services/ai/elevenlabs-music');

// Fake fetch — records the request, returns a Response-like object with the
// fields generateMusicFile reads (ok/status/arrayBuffer/text). No network.
function makeFakeFetch(captured, { ok = true, status = 200, body = 'ID3-music', errText = '' } = {}) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    captured.body = JSON.parse(opts.body);
    return {
      ok,
      status,
      arrayBuffer: async () => Buffer.from(body),
      text: async () => errText,
    };
  };
}

test('generateMusicFile: writes an mp3 and returns a /api-served url', async () => {
  const captured = {};
  const result = await music.generateMusicFile({
    prompt: 'lofi piano relajante',
    durationSeconds: 12,
    fetchImpl: makeFakeFetch(captured),
  });
  assert.ok(captured.url.endsWith('/music'));
  assert.equal(captured.opts.headers['xi-api-key'], 'test-key');
  assert.equal(captured.body.prompt, 'lofi piano relajante');
  assert.equal(captured.body.music_length_ms, 12000);
  assert.equal(result.mime, 'audio/mpeg');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.ok(result.filename.endsWith('.mp3'));
  assert.equal(result.durationSeconds, 12);
  assert.ok(result.sizeBytes > 0);
  assert.ok(fs.existsSync(result.audioPath));
});

test('generateMusicFile: clamps duration into [5,300]', async () => {
  const high = {};
  await music.generateMusicFile({ prompt: 'x', durationSeconds: 5000, fetchImpl: makeFakeFetch(high) });
  assert.equal(high.body.music_length_ms, 300 * 1000);
  const low = {};
  await music.generateMusicFile({ prompt: 'x', durationSeconds: 1, fetchImpl: makeFakeFetch(low) });
  assert.equal(low.body.music_length_ms, 5 * 1000);
});

test('generateMusicFile: rejects empty prompt', async () => {
  await assert.rejects(
    () => music.generateMusicFile({ prompt: '   ', fetchImpl: makeFakeFetch({}) }),
    (err) => err.code === 'PROMPT_REQUIRED'
  );
});

test('generateMusicFile: surfaces 402 as INSUFFICIENT_CREDITS', async () => {
  await assert.rejects(
    () => music.generateMusicFile({ prompt: 'x', fetchImpl: makeFakeFetch({}, { ok: false, status: 402, errText: 'no credits' }) }),
    (err) => err.code === 'INSUFFICIENT_CREDITS'
  );
});

test('generateMusicFile: rejects when the key is missing', async () => {
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.equal(music.isElevenLabsConfigured(), false);
    await assert.rejects(
      () => music.generateMusicFile({ prompt: 'x', fetchImpl: makeFakeFetch({}) }),
      (err) => err.code === 'ELEVENLABS_NOT_CONFIGURED'
    );
  } finally {
    process.env.ELEVENLABS_API_KEY = saved;
  }
});

test('clampSeconds bounds the value', () => {
  assert.equal(music.clampSeconds(12), 12);
  assert.equal(music.clampSeconds(5000), 300);
  assert.equal(music.clampSeconds(1), 5);
  assert.equal(music.clampSeconds('nope', 30), 30);
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
