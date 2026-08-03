'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  audioDurationBounds,
  audioSizeBounds,
  ffprobeAudio,
  validateOfficeSound,
} = require('../scripts/prewarm-office-soundscapes');

function fakeStat(size, isFile = true) {
  return {
    size,
    isFile: () => isFile,
  };
}

function validProbe(duration = 30.04) {
  return {
    streams: [{ codec_name: 'mp3', codec_type: 'audio' }],
    format: { duration: String(duration), size: '480000' },
  };
}

const daySound = {
  soundId: 'coast-day',
  audioPath: '/tmp/office-city-day-v4.mp3',
};

test('strict office prewarm accepts an MP3 with reasonable duration and size', async () => {
  const validation = await validateOfficeSound(daySound, {
    statImpl: async () => fakeStat(480_000),
    probeImpl: async () => validProbe(),
  });

  assert.deepEqual(validation, {
    codec: 'mp3',
    durationSeconds: 30.04,
    sizeBytes: 480_000,
  });
});

test('strict office prewarm rejects non-MP3 audio even when the file is non-empty', async () => {
  await assert.rejects(
    validateOfficeSound(daySound, {
      statImpl: async () => fakeStat(480_000),
      probeImpl: async () => ({
        streams: [{ codec_name: 'aac', codec_type: 'audio' }],
        format: { duration: '30' },
      }),
    }),
    (error) => {
      assert.equal(error.code, 'OFFICE_SOUND_VALIDATION_FAILED');
      assert.match(error.message, /expected mp3 codec/i);
      return true;
    },
  );
});

test('strict office prewarm rejects unreasonable duration', async () => {
  const { minSeconds, maxSeconds } = audioDurationBounds(30);
  for (const invalidDuration of [minSeconds - 0.01, maxSeconds + 0.01]) {
    await assert.rejects(
      validateOfficeSound(daySound, {
        statImpl: async () => fakeStat(480_000),
        probeImpl: async () => validProbe(invalidDuration),
      }),
      /duration .* is outside/i,
    );
  }
});

test('strict office prewarm rejects implausible file size before probing', async () => {
  const { minBytes, maxBytes } = audioSizeBounds(30);
  let probed = false;
  for (const invalidSize of [minBytes - 1, maxBytes + 1]) {
    await assert.rejects(
      validateOfficeSound(daySound, {
        statImpl: async () => fakeStat(invalidSize),
        probeImpl: async () => {
          probed = true;
          return validProbe();
        },
      }),
      /size .* is outside/i,
    );
  }
  assert.equal(probed, false);
});

test('ffprobe helper uses argv execution and parses JSON without invoking a real binary', async () => {
  let invocation;
  const result = await ffprobeAudio('/tmp/sound with spaces.mp3', {
    execFileImpl: async (...args) => {
      invocation = args;
      return { stdout: JSON.stringify(validProbe()) };
    },
  });

  assert.equal(invocation[0], 'ffprobe');
  assert.equal(invocation[1].at(-1), '/tmp/sound with spaces.mp3');
  assert.equal(invocation[2].timeout, 15_000);
  assert.equal(result.streams[0].codec_name, 'mp3');
});
