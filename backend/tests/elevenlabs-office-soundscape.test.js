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
    assert.equal(captured.body.duration_seconds, 18);
    assert.equal(first.generated, true);
    assert.equal(first.audioUrl, '/elevenlabs/audio/office-coast-day-v1.mp3');
    assert.equal(fs.readFileSync(first.audioPath, 'utf8'), 'ID3-office-sound');
    assert.deepEqual(fs.readdirSync(outputDir), ['office-coast-day-v1.mp3']);

    const second = await generateOfficeSoundscape({
      soundId: 'coast-day',
      outputDir,
      fetchImpl: async () => {
        throw new Error('cache miss');
      },
    });
    assert.equal(second.cached, true);
    assert.equal(second.generated, false);
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

test.after(() => {
  if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalApiKey;
});
