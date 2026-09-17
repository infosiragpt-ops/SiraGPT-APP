#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadEnvFiles } = require('../src/config/load-env');
const {
  OFFICE_SOUNDS,
  prewarmOfficeSoundscapes,
  resolveAudioDir,
} = require('../src/services/ai/elevenlabs-office-soundscape');

const execFileAsync = promisify(execFile);
const FFPROBE_TIMEOUT_MS = 15_000;
const FFPROBE_MAX_BUFFER_BYTES = 256 * 1024;

function validationError(soundId, detail) {
  const error = new Error(
    `Office sound validation failed for ${soundId}: ${detail}`,
  );
  error.code = 'OFFICE_SOUND_VALIDATION_FAILED';
  return error;
}

function audioSizeBounds(durationSeconds) {
  // ElevenLabs is requested at 128 kbps. Keep enough tolerance for short-file
  // container metadata and provider variance while rejecting truncated files
  // and unexpectedly large payloads before they reach browser decoders.
  return {
    minBytes: Math.max(2_048, Math.floor(durationSeconds * 4_000)),
    maxBytes: Math.max(96_000, Math.ceil(durationSeconds * 48_000 + 65_536)),
  };
}

function audioDurationBounds(durationSeconds) {
  return {
    minSeconds: Math.max(0.45, durationSeconds * 0.7),
    maxSeconds: Math.max(durationSeconds + 0.5, durationSeconds * 1.35),
  };
}

async function ffprobeAudio(audioPath, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'format=duration,size:stream=codec_name,codec_type,duration',
      '-of',
      'json',
      audioPath,
    ],
    {
      encoding: 'utf8',
      maxBuffer: FFPROBE_MAX_BUFFER_BYTES,
      timeout: FFPROBE_TIMEOUT_MS,
      windowsHide: true,
    },
  );

  try {
    return JSON.parse(stdout);
  } catch {
    const error = new Error('ffprobe returned invalid JSON');
    error.code = 'OFFICE_SOUND_PROBE_FAILED';
    throw error;
  }
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function validateOfficeSound(
  sound,
  {
    statImpl = fs.promises.stat,
    probeImpl = ffprobeAudio,
  } = {},
) {
  const definition = OFFICE_SOUNDS[sound?.soundId];
  if (!definition) {
    throw validationError(sound?.soundId || 'unknown', 'missing curated definition');
  }
  if (!sound.audioPath) {
    throw validationError(sound.soundId, 'missing audio path');
  }

  let stat;
  try {
    stat = await statImpl(sound.audioPath);
  } catch {
    throw validationError(sound.soundId, 'audio file is not readable');
  }
  if (!stat?.isFile?.()) {
    throw validationError(sound.soundId, 'audio path is not a regular file');
  }

  const expectedDuration = Number(definition.durationSeconds);
  const { minBytes, maxBytes } = audioSizeBounds(expectedDuration);
  if (stat.size < minBytes || stat.size > maxBytes) {
    throw validationError(
      sound.soundId,
      `size ${stat.size} bytes is outside ${minBytes}-${maxBytes}`,
    );
  }

  let probe;
  try {
    probe = await probeImpl(sound.audioPath);
  } catch {
    throw validationError(sound.soundId, 'ffprobe could not decode the audio');
  }

  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const audioStream =
    streams.find((stream) => stream?.codec_type === 'audio') || streams[0];
  const codec = String(audioStream?.codec_name || '').toLowerCase();
  if (codec !== 'mp3') {
    throw validationError(
      sound.soundId,
      `expected mp3 codec, received ${codec || 'unknown'}`,
    );
  }

  const duration =
    finitePositiveNumber(probe?.format?.duration) ||
    finitePositiveNumber(audioStream?.duration);
  if (duration === null) {
    throw validationError(sound.soundId, 'ffprobe did not report a finite duration');
  }
  const { minSeconds, maxSeconds } = audioDurationBounds(expectedDuration);
  if (duration < minSeconds || duration > maxSeconds) {
    throw validationError(
      sound.soundId,
      `duration ${duration.toFixed(3)}s is outside ${minSeconds.toFixed(3)}-${maxSeconds.toFixed(3)}s`,
    );
  }

  return {
    codec,
    durationSeconds: Number(duration.toFixed(3)),
    sizeBytes: stat.size,
  };
}

async function main() {
  loadEnvFiles();
  const outputDir = resolveAudioDir();
  const sounds = await prewarmOfficeSoundscapes();
  const validatedSounds = await Promise.all(
    sounds.map(async (sound) => ({
      sound,
      validation: await validateOfficeSound(sound),
    })),
  );
  const summary = validatedSounds.map(({ sound, validation }) => ({
    soundId: sound.soundId,
    filename: sound.filename,
    version: sound.version,
    cached: sound.cached,
    generated: sound.generated,
    fallback: sound.fallback,
    validation,
  }));
  const current = summary.every(
    (sound) => !sound.fallback && sound.validation.codec === 'mp3',
  );
  process.stdout.write(`${JSON.stringify({ ok: current, outputDir, sounds: summary }, null, 2)}\n`);
  if (!current) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        code: error?.code || 'OFFICE_SOUND_PREWARM_FAILED',
        message: error?.message || 'Office sound prewarm failed',
      })}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  audioDurationBounds,
  audioSizeBounds,
  ffprobeAudio,
  validateOfficeSound,
};
