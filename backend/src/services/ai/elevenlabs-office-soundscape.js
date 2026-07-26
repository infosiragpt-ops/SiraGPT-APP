'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout } = require('../../utils/abort-signal');

const OFFICE_SOUNDS = Object.freeze({
  'coast-day': Object.freeze({
    filename: 'office-coast-day-v2.mp3',
    legacyFilename: 'office-coast-day-v1.mp3',
    version: 2,
    text: 'Seamless premium daytime ambience inside a modern software engineering office on a glass rooftop: subtle real mechanical keyboards at varied distance, quiet HVAC, occasional soft chair movement, and a faint coastal city breeze beyond closed windows. Professional low-distraction stereo mix, stable volume, no speech, no music, no alerts, no prominent footsteps, no sudden sounds',
    durationSeconds: 28,
    loop: true,
    promptInfluence: 0.72,
  }),
  'coast-night': Object.freeze({
    filename: 'office-coast-night-v2.mp3',
    legacyFilename: 'office-coast-night-v1.mp3',
    version: 2,
    text: 'Seamless premium night ambience inside a modern software engineering office on a glass rooftop: sparse quiet mechanical keyboard work at varied distance, soft HVAC, occasional restrained chair movement, and a faint evening coastal city breeze beyond closed windows. Calm low-distraction stereo mix, stable volume, no speech, no music, no alerts, no prominent footsteps, no sudden sounds',
    durationSeconds: 28,
    loop: true,
    promptInfluence: 0.72,
  }),
  'terrace-steps': Object.freeze({
    filename: 'office-terrace-steps-v2.mp3',
    legacyFilename: 'office-terrace-steps-v1.mp3',
    version: 2,
    text: 'Three restrained professional office footsteps on a polished stone floor, natural soft leather shoes, close but quiet, clean one-shot recording, no voices, no room ambience, no music, no impact boom',
    durationSeconds: 2.4,
    loop: false,
    promptInfluence: 0.82,
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

async function existingSound(audioDir, soundId, definition) {
  const candidates = [
    { filename: definition.filename, version: definition.version, fallback: false },
    ...(definition.legacyFilename
      ? [{ filename: definition.legacyFilename, version: 1, fallback: true }]
      : []),
  ];

  for (const candidate of candidates) {
    const audioPath = path.join(audioDir, candidate.filename);
    const existing = await fs.promises.stat(audioPath).catch(() => null);
    if (!existing?.isFile() || existing.size <= 0) continue;
    return {
      soundId,
      filename: candidate.filename,
      audioPath,
      audioUrl: `/elevenlabs/audio/${candidate.filename}`,
      cached: true,
      generated: false,
      loop: definition.loop,
      durationSeconds: definition.durationSeconds,
      version: candidate.version,
      fallback: candidate.fallback,
    };
  }
  return null;
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

  const audioDir = resolveAudioDir(outputDir);
  const audioPath = path.join(audioDir, definition.filename);
  const cached = await existingSound(audioDir, soundId, definition);
  if (cached && !cached.fallback) return cached;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    if (cached) return cached;
    const error = new Error('ElevenLabs API key not configured');
    error.code = 'ELEVENLABS_NOT_CONFIGURED';
    throw error;
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
        version: definition.version,
        fallback: false,
      };
    } catch (error) {
      const legacy = await existingSound(audioDir, soundId, definition);
      if (legacy) return legacy;
      throw error;
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  })().finally(() => {
    inFlight.delete(flightKey);
  });

  inFlight.set(flightKey, generation);
  return generation;
}

async function prewarmOfficeSoundscapes(options = {}) {
  const results = [];
  for (const soundId of Object.keys(OFFICE_SOUNDS)) {
    results.push(await generateOfficeSoundscape({ ...options, soundId }));
  }
  return results;
}

module.exports = {
  OFFICE_SOUNDS,
  generateOfficeSoundscape,
  officeSoundDefinition,
  prewarmOfficeSoundscapes,
  resolveAudioDir,
};
