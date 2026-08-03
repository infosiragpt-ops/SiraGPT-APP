const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  OFFICE_SOUNDS,
  generateOfficeSoundscape,
} = require('../src/services/ai/elevenlabs-office-soundscape');

const originalApiKey = process.env.ELEVENLABS_API_KEY;

function fakeFetch(captured, body = 'ID3-office-sound') {
  return async (url, options) => {
    captured.url = url;
    captured.headers = options.headers;
    captured.body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(body),
      text: async () => '',
    };
  };
}

test('office soundscape uses a fixed prompt contract and atomically caches the result', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-office-sound-'));
  const captured = {};

  try {
    const first = await generateOfficeSoundscape({
      soundId: 'coast-day',
      outputDir,
      fetchImpl: fakeFetch(captured),
    });

    assert.equal(captured.url, 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128');
    assert.equal(captured.headers['xi-api-key'], 'test-key');
    assert.equal(captured.body.text, OFFICE_SOUNDS['coast-day'].text);
    assert.equal(captured.body.loop, true);
    assert.equal(captured.body.duration_seconds, 30);
    assert.equal(captured.body.prompt_influence, 0.72);
    assert.equal(captured.body.model_id, 'eleven_text_to_sound_v2');
    assert.equal(first.generated, true);
    assert.equal(first.audioUrl, '/elevenlabs/audio/office-city-day-v4.mp3');
    assert.equal(first.version, 4);
    assert.equal(first.fallback, false);
    assert.equal(fs.readFileSync(first.audioPath, 'utf8'), 'ID3-office-sound');
    assert.deepEqual(fs.readdirSync(outputDir), ['office-city-day-v4.mp3']);

    const second = await generateOfficeSoundscape({
      soundId: 'coast-day',
      outputDir,
      fetchImpl: async () => {
        throw new Error('cache miss');
      },
    });
    assert.equal(second.cached, true);
    assert.equal(second.generated, false);
    assert.equal(second.version, 4);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('office soundscape rejects arbitrary sound ids before contacting ElevenLabs', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  await assert.rejects(
    () => generateOfficeSoundscape({
      soundId: 'custom-user-prompt',
      fetchImpl: async () => {
        throw new Error('must not run');
      },
    }),
    (error) => error.code === 'OFFICE_SOUND_NOT_FOUND',
  );
});

test('office soundscape requires a server-side API key', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(
    () => generateOfficeSoundscape({ soundId: 'coast-night' }),
    (error) => error.code === 'ELEVENLABS_NOT_CONFIGURED',
  );
});

test('office soundscape serves a previously generated recording without an API key', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-office-sound-'));
  const filename = OFFICE_SOUNDS['coast-night'].filename;

  try {
    fs.writeFileSync(path.join(outputDir, filename), 'ID3-prerecorded-office');
    const result = await generateOfficeSoundscape({
      soundId: 'coast-night',
      outputDir,
      fetchImpl: async () => {
        throw new Error('must not contact provider');
      },
    });

    assert.equal(result.cached, true);
    assert.equal(result.generated, false);
    assert.equal(result.version, 4);
    assert.equal(result.fallback, false);
    assert.equal(result.filename, filename);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('office ambience prefers the v3 recording when v4 generation fails', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-office-sound-'));
  const definition = OFFICE_SOUNDS['coast-day'];
  const v3 = definition.fallbacks[0];

  try {
    fs.writeFileSync(path.join(outputDir, definition.legacyFilename), 'ID3-v2-office');
    fs.writeFileSync(path.join(outputDir, v3.filename), 'ID3-v3-office');
    const result = await generateOfficeSoundscape({
      soundId: 'coast-day',
      outputDir,
      fetchImpl: async () => ({
        ok: false,
        status: 402,
        text: async () => 'quota exceeded',
      }),
    });

    assert.equal(result.cached, true);
    assert.equal(result.generated, false);
    assert.equal(result.version, 3);
    assert.equal(result.fallback, true);
    assert.equal(result.filename, v3.filename);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('office ambience keeps v2 as the final fallback when v4 and v3 are unavailable', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-office-sound-'));
  const definition = OFFICE_SOUNDS['coast-night'];

  try {
    fs.writeFileSync(path.join(outputDir, definition.legacyFilename), 'ID3-v2-office');
    const result = await generateOfficeSoundscape({
      soundId: 'coast-night',
      outputDir,
      fetchImpl: async () => {
        throw new Error('must not contact provider');
      },
    });

    assert.equal(result.cached, true);
    assert.equal(result.generated, false);
    assert.equal(result.version, 2);
    assert.equal(result.fallback, true);
    assert.equal(result.filename, definition.legacyFilename);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('office soundscape keeps the prior ElevenLabs recording as a safe fallback', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-office-sound-'));
  const definition = OFFICE_SOUNDS['terrace-steps'];

  try {
    fs.writeFileSync(path.join(outputDir, definition.legacyFilename), 'ID3-legacy-office');
    const result = await generateOfficeSoundscape({
      soundId: 'terrace-steps',
      outputDir,
      fetchImpl: async () => ({
        ok: false,
        status: 402,
        text: async () => 'quota exceeded',
      }),
    });

    assert.equal(result.cached, true);
    assert.equal(result.generated, false);
    assert.equal(result.version, 2);
    assert.equal(result.fallback, true);
    assert.equal(result.filename, definition.legacyFilename);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test.after(() => {
  if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalApiKey;
});

test('office soundscape exposes only curated ambience and operational cues', () => {
  assert.deepEqual(Object.keys(OFFICE_SOUNDS).sort(), [
    'approval-ready',
    'attention',
    'coast-day',
    'coast-night',
    'terrace-steps',
    'work-complete',
    'work-start',
  ]);
  assert.equal(OFFICE_SOUNDS['coast-day'].loop, true);
  assert.equal(OFFICE_SOUNDS['coast-night'].loop, true);
  assert.equal(OFFICE_SOUNDS['coast-day'].version, 4);
  assert.equal(OFFICE_SOUNDS['coast-night'].version, 4);
  assert.deepEqual(OFFICE_SOUNDS['coast-day'].fallbacks, [
    { filename: 'office-city-day-v3.mp3', version: 3 },
  ]);
  assert.deepEqual(OFFICE_SOUNDS['coast-night'].fallbacks, [
    { filename: 'office-city-night-v3.mp3', version: 3 },
  ]);
  for (const definition of Object.values(OFFICE_SOUNDS)) {
    assert.ok(definition.text.length <= 450, 'ElevenLabs sound prompts must not exceed 450 characters');
  }
  for (const soundId of ['coast-day', 'coast-night']) {
    const definition = OFFICE_SOUNDS[soundId];
    assert.match(definition.text, /seamless clean loop/i);
    assert.match(definition.text, /glass facade/i);
    assert.match(definition.text, /near-silent HVAC/i);
    assert.match(definition.text, /feather-light keyboard taps/i);
    assert.match(definition.text, /coastal electric city/i);
    assert.match(definition.text, /no music, speech, notifications/i);
    assert.match(definition.text, /no[\s\S]*sudden events/i);
  }
  assert.match(OFFICE_SOUNDS['coast-day'].text, /clear daylight/i);
  assert.match(OFFICE_SOUNDS['coast-day'].text, /bright, focused/i);
  assert.match(OFFICE_SOUNDS['coast-night'].text, /at night/i);
  assert.match(OFFICE_SOUNDS['coast-night'].text, /elegant modern/i);
  for (const soundId of ['work-start', 'work-complete', 'approval-ready', 'attention']) {
    assert.equal(OFFICE_SOUNDS[soundId].loop, false);
    assert.match(OFFICE_SOUNDS[soundId].text, /no voice/i);
  }
});
