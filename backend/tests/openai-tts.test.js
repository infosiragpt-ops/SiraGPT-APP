const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-openai-tts-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.OPENAI_API_KEY = 'test-openai-key';

const openaiTts = require('../src/services/ai/openai-tts');

function mp3Fetch(captured) {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    captured.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('ID3-openai-bytes'),
    };
  };
}

test('generateOpenAiSpeechFile persists a playable MP3 artifact', async () => {
  const captured = {};
  const result = await openaiTts.generateOpenAiSpeechFile({
    text: 'Hola desde OpenAI',
    fetchImpl: mp3Fetch(captured),
  });

  assert.match(captured.url, /\/audio\/speech$/);
  assert.equal(captured.init.headers.Authorization, 'Bearer test-openai-key');
  assert.equal(captured.body.model, openaiTts.DEFAULT_MODEL);
  assert.equal(captured.body.voice, openaiTts.DEFAULT_VOICE);
  assert.equal(captured.body.response_format, 'mp3');
  assert.equal(captured.body.input, 'Hola desde OpenAI');

  assert.equal(result.mime, 'audio/mpeg');
  assert.equal(result.format, 'mp3');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.ok(fs.existsSync(result.audioPath));
  assert.ok(result.sizeBytes > 0);
});

test('generateOpenAiSpeechFile sends instructions only to gpt-4o-mini-tts', async () => {
  const mini = {};
  await openaiTts.generateOpenAiSpeechFile({
    text: 'Hola',
    modelId: 'gpt-4o-mini-tts',
    instructions: 'Speak cheerfully.',
    fetchImpl: mp3Fetch(mini),
  });
  assert.equal(mini.body.instructions, 'Speak cheerfully.');

  const classic = {};
  await openaiTts.generateOpenAiSpeechFile({
    text: 'Hola',
    modelId: 'tts-1',
    instructions: 'Speak cheerfully.',
    fetchImpl: mp3Fetch(classic),
  });
  assert.equal(classic.body.instructions, undefined);
});

test('generateOpenAiSpeechFile clamps speed and normalises voices', async () => {
  const captured = {};
  const result = await openaiTts.generateOpenAiSpeechFile({
    text: 'Voces',
    modelId: 'tts-1',
    voiceId: 'Cedar', // tts-1 rejects the 4 newest voices -> default
    speed: 99,
    fetchImpl: mp3Fetch(captured),
  });
  assert.equal(captured.body.speed, 4.0);
  assert.equal(captured.body.voice, openaiTts.DEFAULT_VOICE);
  assert.equal(result.voiceId, openaiTts.DEFAULT_VOICE);

  const unknown = {};
  await openaiTts.generateOpenAiSpeechFile({
    text: 'Voces',
    voiceId: 'not-a-voice',
    fetchImpl: mp3Fetch(unknown),
  });
  assert.equal(unknown.body.voice, openaiTts.DEFAULT_VOICE);
});

test('generateOpenAiSpeechFile classifies auth and rate-limit errors', async () => {
  await assert.rejects(
    () => openaiTts.generateOpenAiSpeechFile({
      text: 'Hola',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'quota' }),
    }),
    (error) => error?.code === 'RATE_LIMITED' && error?.status === 429,
  );
  await assert.rejects(
    () => openaiTts.generateOpenAiSpeechFile({
      text: 'Hola',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }),
    }),
    (error) => error?.code === 'OPENAI_TTS_AUTH_ERROR',
  );
});

test('generateOpenAiSpeechFile rejects empty text and missing key', async () => {
  await assert.rejects(
    () => openaiTts.generateOpenAiSpeechFile({ text: '   ', fetchImpl: mp3Fetch({}) }),
    (error) => error?.code === 'TEXT_REQUIRED',
  );
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(openaiTts.isOpenAiTtsConfigured(), false);
    await assert.rejects(
      () => openaiTts.generateOpenAiSpeechFile({ text: 'Hola', fetchImpl: mp3Fetch({}) }),
      (error) => error?.code === 'OPENAI_TTS_NOT_CONFIGURED',
    );
  } finally {
    process.env.OPENAI_API_KEY = saved;
  }
});

test('generateOpenAiSpeechFile rejects a pre-aborted request before fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    () => openaiTts.generateOpenAiSpeechFile({
      text: 'No generar',
      signal: controller.signal,
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(1) };
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(called, false);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
