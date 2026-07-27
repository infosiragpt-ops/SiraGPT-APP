const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-gemini-tts-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.GEMINI_API_KEY = 'test-gemini-key';

const geminiTts = require('../src/services/ai/gemini-tts');

function successBody(pcm = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])) {
  return {
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'audio/L16;codec=pcm;rate=24000',
            data: pcm.toString('base64'),
          },
        }],
      },
    }],
  };
}

test('generateGeminiSpeechFile wraps Gemini PCM in a playable WAV artifact', async () => {
  let captured;
  const result = await geminiTts.generateGeminiSpeechFile({
    text: 'Hola desde SiraGPT',
    language: 'Spanish',
    accent: 'Latino',
    effect: 'Studio Clean',
    stability: 100,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => successBody() };
    },
  });

  assert.match(captured.url, /gemini-2\.5-flash-preview-tts:generateContent$/);
  assert.equal(captured.init.headers['x-goog-api-key'], 'test-gemini-key');
  const payload = JSON.parse(captured.init.body);
  assert.deepEqual(payload.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(
    payload.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    geminiTts.DEFAULT_VOICE,
  );
  assert.match(payload.contents[0].parts[0].text, /Hola desde SiraGPT/);

  assert.equal(result.mime, 'audio/wav');
  assert.equal(result.format, 'wav');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  const file = fs.readFileSync(result.audioPath);
  assert.equal(file.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(file.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(file.readUInt32LE(24), 24000);
  assert.equal(file.length, 52);
});

test('generateGeminiSpeechFile rejects a pre-aborted request before fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await assert.rejects(
    () => geminiTts.generateGeminiSpeechFile({
      text: 'No generar',
      signal: controller.signal,
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => successBody() };
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(called, false);
});

test('generateGeminiSpeechFile classifies provider rate limits', async () => {
  await assert.rejects(
    () => geminiTts.generateGeminiSpeechFile({
      text: 'Hola',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Quota exceeded' } }),
      }),
    }),
    (error) => error?.code === 'RATE_LIMITED' && error?.status === 429,
  );
});

test('buildSpeechPrompt keeps the transcript and professional controls', () => {
  const prompt = geminiTts.buildSpeechPrompt('Texto exacto.', {
    language: 'Spanish',
    accent: 'Mexican',
    effect: 'Podcast',
    stability: 90,
  });
  assert.match(prompt, /Spanish/);
  assert.match(prompt, /Mexican/);
  assert.match(prompt, /Podcast/);
  assert.match(prompt, /TRANSCRIPT:\nTexto exacto\.$/);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
