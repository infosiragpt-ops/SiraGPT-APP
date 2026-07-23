'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout } = require('../../utils/abort-signal');

const OFFICE_SOUNDS = Object.freeze({
  'coast-day': Object.freeze({
    filename: 'office-coast-day-v1.mp3',
    text: 'Seamless daytime ambience from a modern glass office terrace beside the Pacific Ocean: gentle distant waves, light sea breeze, subtle quiet city atmosphere, no voices, no music, no sudden loud sounds',
    durationSeconds: 18,
    loop: true,
    promptInfluence: 0.62,
  }),
  'coast-night': Object.freeze({
    filename: 'office-coast-night-v1.mp3',
    text: 'Seamless calm night ambience from a modern glass office terrace beside the Pacific Ocean: soft distant waves, mild evening sea breeze, very subtle city lights atmosphere, no voices, no music, no sudden loud sounds',
    durationSeconds: 18,
    loop: true,
    promptInfluence: 0.62,
  }),
  'terrace-steps': Object.freeze({
    filename: 'office-terrace-steps-v1.mp3',
    text: 'Two soft professional office footsteps on a clean stone terrace floor, close and natural, no voices, no ambience, no music',
    durationSeconds: 1.5,
    loop: false,
    promptInfluence: 0.78,
  }),
});

const inFlight = new Map();

function officeSoundDefinition(soundId) {
  return OFFICE_SOUNDS[soundId] || null;
}

function resolveAudioDir(outputDir) {
  if (outputDir) return path.resolve(outputDir);
  const uploadRoot = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.resolve(__dirname, '../../../uploads');
  return path.join(uploadRoot, 'audio');
}

function providerError(status, detail) {
  const error = new Error(`ElevenLabs sound generation failed (${status})`);
  error.status = status;
  error.code = status === 402 || /quota|credit/i.test(detail || '')
    ? 'INSUFFICIENT_CREDITS'
    : status === 401 || status === 403
      ? 'ELEVENLABS_AUTH_FAILED'
      : 'ELEVENLABS_SOUND_FAILED';
  return error;
}

async function generateOfficeSoundscape({
  soundId,
  outputDir,
  fetchImpl = global.fetch,
  signal,
} = {}) {
  const definition = officeSoundDefinition(soundId);
  if (!definition) {
    const error = new Error('Unknown office sound');
    error.code = 'OFFICE_SOUND_NOT_FOUND';
    throw error;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    const error = new Error('ElevenLabs API key not configured');
    error.code = 'ELEVENLABS_NOT_CONFIGURED';
    throw error;
  }

  const audioDir = resolveAudioDir(outputDir);
  const audioPath = path.join(audioDir, definition.filename);
  const existing = await fs.promises.stat(audioPath).catch(() => null);
  if (existing?.isFile() && existing.size > 0) {
    return {
      soundId,
      filename: definition.filename,
      audioPath,
      audioUrl: `/elevenlabs/audio/${definition.filename}`,
      cached: true,
      generated: false,
      loop: definition.loop,
      durationSeconds: definition.durationSeconds,
    };
  }

  const flightKey = `${audioDir}:${soundId}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);

  const generation = (async () => {
    await fs.promises.mkdir(audioDir, { recursive: true });
    const temporaryPath = `${audioPath}.${randomUUID()}.part`;
    try {
      const response = await fetchImpl(
        'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128',
        {
          method: 'POST',
          signal: signalWithTimeout(
            signal,
            Number(process.env.ELEVENLABS_SOUND_TIMEOUT_MS) || 90000,
          ),
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: definition.text,
            loop: definition.loop,
            duration_seconds: definition.durationSeconds,
            prompt_influence: definition.promptInfluence,
            model_id: 'eleven_text_to_sound_v2',
          }),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw providerError(response.status, detail);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        const error = new Error('ElevenLabs returned an empty sound file');
        error.code = 'ELEVENLABS_EMPTY_SOUND';
        throw error;
      }

      await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
      await fs.promises.rename(temporaryPath, audioPath);
      return {
        soundId,
        filename: definition.filename,
        audioPath,
        audioUrl: `/elevenlabs/audio/${definition.filename}`,
        cached: false,
        generated: true,
        loop: definition.loop,
        durationSeconds: definition.durationSeconds,
      };
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  })().finally(() => {
    inFlight.delete(flightKey);
  });

  inFlight.set(flightKey, generation);
  return generation;
}

module.exports = {
  OFFICE_SOUNDS,
  generateOfficeSoundscape,
  officeSoundDefinition,
  resolveAudioDir,
};
