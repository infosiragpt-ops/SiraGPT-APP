#!/usr/bin/env node
'use strict';

const { loadEnvFiles } = require('../src/config/load-env');
const {
  prewarmOfficeSoundscapes,
  resolveAudioDir,
} = require('../src/services/ai/elevenlabs-office-soundscape');

async function main() {
  loadEnvFiles();
  const outputDir = resolveAudioDir();
  const sounds = await prewarmOfficeSoundscapes();
  const summary = sounds.map((sound) => ({
    soundId: sound.soundId,
    filename: sound.filename,
    version: sound.version,
    cached: sound.cached,
    generated: sound.generated,
    fallback: sound.fallback,
  }));
  const current = summary.every((sound) => !sound.fallback);
  process.stdout.write(`${JSON.stringify({ ok: current, outputDir, sounds: summary }, null, 2)}\n`);
  if (!current) process.exitCode = 2;
}

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
