'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audioTranscriber = require('../src/services/audio-transcriber');

function tempAudio(t, name = 'note.ogg') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from('fake-whatsapp-ptt'));
  return filePath;
}

test('ogg / opus / application-ogg mimes are accepted', () => {
  assert.equal(audioTranscriber.normalizeAudioMime('audio/ogg; codecs=opus', 'ptt.ogg'), 'audio/ogg');
  assert.equal(audioTranscriber.normalizeAudioMime('audio/opus', 'note.opus'), 'audio/opus');
  assert.equal(audioTranscriber.normalizeAudioMime('application/ogg', 'voice.ogg'), 'application/ogg');
  assert.ok(audioTranscriber.AUDIO_MIME_MAP['audio/ogg']);
  assert.ok(audioTranscriber.AUDIO_MIME_MAP['audio/opus']);
  assert.ok(audioTranscriber.AUDIO_MIME_MAP['application/ogg']);
});

test('default language hint is es when WHISPER_LANGUAGE is unset', () => {
  const env = { ...process.env };
  delete env.WHISPER_LANGUAGE;
  assert.equal(audioTranscriber.resolveLanguage({ env }), 'es');
});

test('no OPENAI_API_KEY uses the local path, not a missing-key placeholder', async (t) => {
  const filePath = tempAudio(t);
  let localCalls = 0;
  const result = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
    env: { WHISPER_LANGUAGE: 'es' },
    async localTranscribe() {
      localCalls += 1;
      return { text: 'Hola Luis, te llamo al almuerzo.', model: 'base', language: 'es', segments: [] };
    },
  });
  assert.equal(localCalls, 1);
  assert.equal(result.method, 'local-whisper');
  assert.match(result.transcript, /Hola Luis/);
  assert.doesNotMatch(result.text, /OPENAI_API_KEY|placeholder-for-missing-key|Set OPENAI/);
});

test('OpenAI 401 falls back to local and never leaks sk-proj or the 401 body', async (t) => {
  const filePath = tempAudio(t);
  const fakeKeyShape = 'sk-proj-TESTKEY_NOT_A_REAL_SECRET_xxxxxx';
  let localCalls = 0;
  const result = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: fakeKeyShape, WHISPER_LANGUAGE: 'es' },
    openai: {
      audio: {
        transcriptions: {
          async create() {
            const err = new Error(`401 Incorrect API key provided: ${fakeKeyShape}`);
            err.status = 401;
            err.code = 'invalid_api_key';
            throw err;
          },
        },
      },
    },
    async localTranscribe() {
      localCalls += 1;
      return { text: 'Mensaje de voz transcrito en local.', model: 'base', language: 'es' };
    },
  });
  assert.equal(localCalls, 1);
  assert.equal(result.method, 'local-whisper');
  assert.doesNotMatch(result.text, /sk-proj/);
  assert.doesNotMatch(result.text, /401 Incorrect API key/);
  assert.doesNotMatch(result.text, /OPENAI_API_KEY/);
});

test('when local also fails the placeholder is Spanish and secret-safe', async (t) => {
  const filePath = tempAudio(t);
  const fakeKeyShape = 'sk-proj-TESTKEY_NOT_A_REAL_SECRET_yyyyyy';
  const result = await audioTranscriber.transcribe(filePath, 'audio/opus', 'ptt.opus', {
    env: { OPENAI_API_KEY: fakeKeyShape },
    openai: {
      audio: {
        transcriptions: {
          async create() {
            const err = new Error(`401 Incorrect API key provided: ${fakeKeyShape}`);
            err.status = 401;
            throw err;
          },
        },
      },
    },
    async localTranscribe() {
      throw new Error(`401 Incorrect API key provided: ${fakeKeyShape}`);
    },
  });
  assert.equal(result.method, 'placeholder');
  assert.match(result.text, /Transcripci[oó]n no disponible/);
  assert.doesNotMatch(result.text, /sk-proj/);
  assert.doesNotMatch(result.text, /401 Incorrect API key/);
  assert.doesNotMatch(result.text, /OPENAI_API_KEY/);
  assert.doesNotMatch(result.text, /Set OPENAI/);
});

test('aborted OpenAI calls do not fall back to local', async (t) => {
  const filePath = tempAudio(t);
  let localCalls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
      env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_NOT_A_REAL_SECRET_abort' },
      signal: controller.signal,
      openai: {
        audio: {
          transcriptions: {
            async create() {
              const err = new Error('aborted by user');
              err.name = 'AbortError';
              throw err;
            },
          },
        },
      },
      async localTranscribe() {
        localCalls += 1;
        return { text: 'should not run' };
      },
    }),
    /aborted by user/,
  );
  assert.equal(localCalls, 0);
});

test('sanitizeProviderError redacts key-shaped provider text', () => {
  const err = new Error('401 Incorrect API key provided: sk-proj-TESTKEY_NOT_A_REAL_SECRET_zzzzzz');
  err.status = 401;
  const sanitized = audioTranscriber.sanitizeProviderError(err);
  assert.doesNotMatch(sanitized, /sk-proj/);
  assert.doesNotMatch(sanitized, /TESTKEY/);
});
