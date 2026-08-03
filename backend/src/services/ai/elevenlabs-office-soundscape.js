'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout } = require('../../utils/abort-signal');

const OFFICE_SOUNDS = Object.freeze({
  'coast-day': Object.freeze({
    filename: 'office-city-day-v3.mp3',
    legacyFilename: 'office-coast-day-v2.mp3',
    legacyVersion: 2,
    version: 3,
    text: 'Seamless premium daytime ambience for a modern autonomous-company headquarters above a coastal smart city. Inside: soft mechanical keyboards, restrained chair movement and quiet HVAC. Beyond insulated glass: distant electric traffic, light ocean breeze and subtle city air. Wide natural stereo, calm and productive, stable loudness; no speech, music, notifications, horns, sirens, prominent birds or sudden events.',
    durationSeconds: 30,
    loop: true,
    promptInfluence: 0.76,
  }),
  'coast-night': Object.freeze({
    filename: 'office-city-night-v3.mp3',
    legacyFilename: 'office-coast-night-v2.mp3',
    legacyVersion: 2,
    version: 3,
    text: 'Seamless premium night ambience for a modern autonomous-company headquarters above a coastal smart city. Inside: sparse quiet keyboards, soft ventilation and restrained chair movement. Beyond insulated glass: distant electric traffic on wet avenues, gentle ocean breeze and a subtle city hum. Spacious realistic stereo, calm and low-distraction, stable loudness; no speech, music, notifications, horns, sirens, thunder or sudden events.',
    durationSeconds: 30,
    loop: true,
    promptInfluence: 0.76,
  }),
  'terrace-steps': Object.freeze({
    filename: 'office-terrace-steps-v3.mp3',
    legacyFilename: 'office-terrace-steps-v2.mp3',
    legacyVersion: 2,
    version: 3,
    text: 'Three restrained professional footsteps in soft leather shoes across a premium stone-and-wood office floor, close and realistic with a short architectural room reflection, clean one-shot recording, no voices, no music, no impact boom, no background ambience',
    durationSeconds: 2.4,
    loop: false,
    promptInfluence: 0.86,
  }),
  'work-start': Object.freeze({
    filename: 'office-work-start-v1.mp3',
    version: 1,
    text: 'A refined two-note spatial interface cue for an autonomous agent beginning work: soft glass and warm wood resonance, subtle upward motion, confident and restrained, one-shot, under two seconds, no voice, no music bed, no bass impact, no alarm',
    durationSeconds: 1.5,
    loop: false,
    promptInfluence: 0.9,
  }),
  'work-complete': Object.freeze({
    filename: 'office-work-complete-v1.mp3',
    version: 1,
    text: 'A refined professional completion cue for an autonomous agent finishing work: one warm glass tone followed by a very soft clean confirmation shimmer, calm and premium, one-shot, under two seconds, no voice, no music bed, no bass impact, no applause',
    durationSeconds: 1.6,
    loop: false,
    promptInfluence: 0.9,
  }),
  'approval-ready': Object.freeze({
    filename: 'office-approval-ready-v1.mp3',
    version: 1,
    text: 'A subtle executive review-ready notification: two precise soft ceramic clicks with a light airy tail, neutral and professional, one-shot, under two seconds, no voice, no music, no alarm, no bass impact',
    durationSeconds: 1.4,
    loop: false,
    promptInfluence: 0.9,
  }),
  attention: Object.freeze({
    filename: 'office-attention-v1.mp3',
    version: 1,
    text: 'A restrained professional attention cue for an operations dashboard: one soft low wooden tick and one clear muted glass tone, noticeable without urgency, one-shot, under two seconds, no voice, no siren, no alarm, no music, no bass impact',
    durationSeconds: 1.4,
    loop: false,
    promptInfluence: 0.9,
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
      ? [{
          filename: definition.legacyFilename,
          version: Number(definition.legacyVersion) || 1,
          fallback: true,
        }]
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
