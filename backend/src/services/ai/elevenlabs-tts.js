/**
 * elevenlabs-tts
 *
 * Small shared helper that turns text into an MP3 file on disk using the
 * ElevenLabs SDK and returns metadata the caller can surface as a chat
 * artifact. Extracted so both the standalone `/api/elevenlabs/text-to-speech`
 * route and the deterministic chat speech endpoint (`/api/ai/generate-speech`)
 * share ONE code path — no duplicated voice/model defaults or file-naming.
 *
 * The file is written to the same `uploads/audio` directory the elevenlabs
 * route serves from (`GET /api/elevenlabs/audio/:filename`), so the returned
 * `audioUrl` is immediately playable.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { throwIfAborted } = require('../../utils/abort-signal');

// ElevenLabs "Rachel" multilingual voice — the historical default of the
// generate_speech agent tool. Always available on the project account and
// safe for any language. Overridable per deployment.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
// Multilingual model: verified to accept Spanish (and everything else) without
// a language flag, unlike eleven_monolingual_v1.
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_DEFAULT_MODEL_ID || 'eleven_multilingual_v2';

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

// Mirror the elevenlabs route's audio directory resolution so generated files
// land where `GET /api/elevenlabs/audio/:filename` can serve them.
const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isElevenLabsConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

function generatedAudioFilename(prefix = 'tts', extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

function clampVoiceSettings(settings) {
  const out = { ...DEFAULT_VOICE_SETTINGS };
  if (settings && typeof settings === 'object') {
    if (Number.isFinite(settings.stability)) out.stability = Math.min(1, Math.max(0, settings.stability));
    if (Number.isFinite(settings.similarity_boost)) out.similarity_boost = Math.min(1, Math.max(0, settings.similarity_boost));
    if (Number.isFinite(settings.style)) out.style = Math.min(1, Math.max(0, settings.style));
    if (typeof settings.use_speaker_boost === 'boolean') out.use_speaker_boost = settings.use_speaker_boost;
  }
  return out;
}

let cachedClient = null;
function getClient(ElevenLabsClientCtor) {
  if (!isElevenLabsConfigured()) return null;
  if (ElevenLabsClientCtor) {
    // Injectable for tests — never cache an injected client.
    return new ElevenLabsClientCtor({ apiKey: process.env.ELEVENLABS_API_KEY });
  }
  if (!cachedClient) {
    const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
    cachedClient = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  }
  return cachedClient;
}

/**
 * Convert text to an MP3 file via ElevenLabs and persist it to the served
 * audio directory.
 *
 * @param {object} opts
 * @param {string} opts.text          required narration text
 * @param {string} [opts.voiceId]     ElevenLabs voice id (defaults to Rachel)
 * @param {string} [opts.modelId]     ElevenLabs model id (defaults multilingual)
 * @param {object} [opts.voiceSettings] stability/similarity_boost/style/use_speaker_boost
 * @param {Function} [opts.ElevenLabsClientCtor] injectable client ctor (tests)
 * @param {AbortSignal} [opts.signal] user/request cancellation signal
 * @returns {Promise<{filename,audioPath,audioUrl,sizeBytes,mime,voiceId,modelId,characters}>}
 */
async function generateSpeechFile({ text, voiceId, modelId, voiceSettings, ElevenLabsClientCtor, signal } = {}) {
  const narration = String(text || '').trim();
  if (!narration) {
    const err = new Error('Text is required for speech generation');
    err.code = 'TEXT_REQUIRED';
    throw err;
  }
  if (!isElevenLabsConfigured()) {
    const err = new Error('ElevenLabs API key not configured');
    err.code = 'ELEVENLABS_NOT_CONFIGURED';
    throw err;
  }

  const client = getClient(ElevenLabsClientCtor);
  const resolvedVoiceId = String(voiceId || '').trim() || DEFAULT_VOICE_ID;
  const resolvedModelId = String(modelId || '').trim() || DEFAULT_MODEL_ID;
  const settings = clampVoiceSettings(voiceSettings);
  throwIfAborted(signal);

  const audioStream = await client.textToSpeech.convert(resolvedVoiceId, {
    text: narration,
    model_id: resolvedModelId,
    voice_settings: settings,
  }, {
    abortSignal: signal,
    maxRetries: 0,
    timeoutInSeconds: Math.max(1, Math.ceil((Number(process.env.ELEVENLABS_TIMEOUT_MS) || 120000) / 1000)),
  });

  const chunks = [];
  for await (const chunk of audioStream) {
    throwIfAborted(signal);
    chunks.push(chunk);
  }
  throwIfAborted(signal);
  const audioBuffer = Buffer.concat(chunks);
  if (!audioBuffer || audioBuffer.length === 0) {
    const err = new Error('ElevenLabs returned no audio');
    err.code = 'EMPTY_AUDIO';
    throw err;
  }

  ensureDir(audioDir);
  const filename = generatedAudioFilename('tts');
  const audioPath = path.join(audioDir, filename);
  throwIfAborted(signal);
  fs.writeFileSync(audioPath, audioBuffer);

  return {
    filename,
    audioPath,
    // Served by GET /api/elevenlabs/audio/:filename. The leading /api is kept
    // so the frontend artifact-href resolver (which strips a trailing /api
    // from the API base before appending) produces the correct absolute URL.
    audioUrl: `/api/elevenlabs/audio/${filename}`,
    sizeBytes: audioBuffer.length,
    mime: 'audio/mpeg',
    voiceId: resolvedVoiceId,
    modelId: resolvedModelId,
    characters: narration.length,
  };
}

module.exports = {
  generateSpeechFile,
  isElevenLabsConfigured,
  DEFAULT_VOICE_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_VOICE_SETTINGS,
  audioDir,
};
