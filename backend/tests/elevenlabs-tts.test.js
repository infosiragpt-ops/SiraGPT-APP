const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate generated files to a temp dir BEFORE requiring the module (audioDir
// is resolved at module load from UPLOAD_DIR).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-tts-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.ELEVENLABS_API_KEY = 'test-key';
delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
delete process.env.ELEVENLABS_DEFAULT_MODEL_ID;

const tts = require('../src/services/ai/elevenlabs-tts');

// A fake ElevenLabs SDK client that records the args it was called with and
// streams back a couple of buffers — no network.
function makeFakeClientCtor(captured) {
  return class FakeClient {
    constructor({ apiKey }) {
      captured.apiKey = apiKey;
      this.textToSpeech = {
        convert: async (voiceId, opts) => {
          captured.voiceId = voiceId;
          captured.opts = opts;
          return (async function* () {
            yield Buffer.from('ID3');
            yield Buffer.from(`-${opts.text}`);
          })();
        },
      };
    }
  };
}

test('generateSpeechFile: writes an mp3 and returns a /api-served url', async () => {
  const captured = {};
  const result = await tts.generateSpeechFile({
    text: 'Hola mundo',
    ElevenLabsClientCtor: makeFakeClientCtor(captured),
  });

  assert.equal(captured.apiKey, 'test-key');
  // Default voice + multilingual model when none supplied.
  assert.equal(captured.voiceId, tts.DEFAULT_VOICE_ID);
  assert.equal(captured.opts.model_id, tts.DEFAULT_MODEL_ID);

  assert.equal(result.mime, 'audio/mpeg');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.ok(result.filename.endsWith('.mp3'));
  assert.equal(result.characters, 'Hola mundo'.length);
  assert.ok(result.sizeBytes > 0);
  // The file actually exists on disk and holds the streamed bytes.
  assert.ok(fs.existsSync(result.audioPath));
  assert.equal(fs.readFileSync(result.audioPath).toString(), 'ID3-Hola mundo');
});

test('generateSpeechFile: honours an explicit voice and model', async () => {
  const captured = {};
  const result = await tts.generateSpeechFile({
    text: 'Prueba',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    modelId: 'eleven_v3',
    ElevenLabsClientCtor: makeFakeClientCtor(captured),
  });
  assert.equal(captured.voiceId, 'EXAVITQu4vr4xnSDxMaL');
  assert.equal(captured.opts.model_id, 'eleven_v3');
  assert.equal(result.voiceId, 'EXAVITQu4vr4xnSDxMaL');
  assert.equal(result.modelId, 'eleven_v3');
});

test('generateSpeechFile: clamps voice settings into [0,1]', async () => {
  const captured = {};
  await tts.generateSpeechFile({
    text: 'Ajustes',
    voiceSettings: { stability: 5, similarity_boost: -2, style: 0.3, use_speaker_boost: false },
    ElevenLabsClientCtor: makeFakeClientCtor(captured),
  });
  assert.equal(captured.opts.voice_settings.stability, 1);
  assert.equal(captured.opts.voice_settings.similarity_boost, 0);
  assert.equal(captured.opts.voice_settings.style, 0.3);
  assert.equal(captured.opts.voice_settings.use_speaker_boost, false);
});

test('generateSpeechFile: rejects empty text', async () => {
  await assert.rejects(
    () => tts.generateSpeechFile({ text: '   ', ElevenLabsClientCtor: makeFakeClientCtor({}) }),
    (err) => err.code === 'TEXT_REQUIRED'
  );
});

test('generateSpeechFile: rejects when the key is missing', async () => {
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.equal(tts.isElevenLabsConfigured(), false);
    await assert.rejects(
      () => tts.generateSpeechFile({ text: 'Hola', ElevenLabsClientCtor: makeFakeClientCtor({}) }),
      (err) => err.code === 'ELEVENLABS_NOT_CONFIGURED'
    );
  } finally {
    process.env.ELEVENLABS_API_KEY = saved;
  }
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
