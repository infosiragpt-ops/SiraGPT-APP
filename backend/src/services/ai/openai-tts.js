/**
 * OpenAI text-to-speech for the deterministic Voice composer.
 *
 * Third first-class speech provider alongside ElevenLabs and Gemini, so the
 * Voice mode works with ANY configured LLM/TTS provider — and the
 * `/api/ai/generate-speech` route can chain all three automatically.
 *
 * Conventions mirror `gemini-tts.js`: the MP3 is persisted to the same
 * served `uploads/audio` directory and exposed through
 * `GET /api/elevenlabs/audio/:filename`, so the returned `audioUrl` is
 * immediately playable with zero frontend changes.
 *
 * OpenAI API facts (baked in):
 * - Models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` — max input 4096 chars.
 * - `instructions` ONLY works on `gpt-4o-mini-tts` (tts-1/hd ignore it).
 * - `speed` 0.25–4.0, default 1.0. There is no stability knob; the
 *   voice-director maps stability/effect → speed + instructions.
 * - 13 built-in voices; tts-1/hd support a 9-voice subset. Unknown names
 *   fall back to the configured default instead of failing.
 *
 * Env (shared with the agentic `generate_speech` tool in audio-media-tools):
 *   OPENAI_API_KEY (required), OPENAI_TTS_API_BASE, OPENAI_TTS_MODEL,
 *   OPENAI_TTS_VOICE, OPENAI_TTS_TIMEOUT_MS
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout, throwIfAborted } = require('../../utils/abort-signal');

const DEFAULT_MODEL = process.env.OPENAI_TTS_MODEL || 'tts-1';
const DEFAULT_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const API_BASE = (process.env.OPENAI_TTS_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
const TTS_TIMEOUT_MS = Math.max(1000, Number(process.env.OPENAI_TTS_TIMEOUT_MS) || 120000);

// Built-in voices per OpenAI docs. tts-1/tts-1-hd only support the subset.
const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
];
const TTS_1_VOICE_SUBSET = new Set([
  'alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer',
]);

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getOpenAiApiKey(env = process.env) {
  return String(env.OPENAI_API_KEY || '').trim();
}

function isOpenAiTtsConfigured(env = process.env) {
  return Boolean(getOpenAiApiKey(env));
}

function normalizeVoice(voice, modelId) {
  const wanted = String(voice || '').trim().toLowerCase();
  if (wanted && OPENAI_TTS_VOICES.includes(wanted)) {
    // tts-1/tts-1-hd reject the 4 newest voices — fall back instead of 400ing.
    if ((modelId === 'tts-1' || modelId === 'tts-1-hd') && !TTS_1_VOICE_SUBSET.has(wanted)) {
      return DEFAULT_VOICE;
    }
    return wanted;
  }
  return DEFAULT_VOICE;
}

function supportsInstructions(modelId) {
  return String(modelId || '').startsWith('gpt-4o-mini-tts');
}

function classifyOpenAiError(status, bodyText) {
  const detail = String(bodyText || '').slice(0, 240);
  const error = new Error(detail || `OpenAI TTS failed with HTTP ${status}`);
  error.status = status;
  error.statusCode = status;
  error.code = status === 429
    ? 'RATE_LIMITED'
    : status === 401 || status === 403
      ? 'OPENAI_TTS_AUTH_ERROR'
      : status === 400
        ? 'OPENAI_TTS_INVALID_REQUEST'
        : 'OPENAI_TTS_ERROR';
  return error;
}

async function generateOpenAiSpeechFile({
  text,
  voiceId,
  modelId,
  speed,
  instructions,
  signal,
  fetchImpl,
} = {}) {
  const narration = String(text || '').trim();
  if (!narration) {
    const error = new Error('Text is required for speech generation');
    error.code = 'TEXT_REQUIRED';
    throw error;
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    const error = new Error('OpenAI TTS API key not configured');
    error.code = 'OPENAI_TTS_NOT_CONFIGURED';
    throw error;
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    const error = new Error('fetch is not available in this runtime');
    error.code = 'FETCH_UNAVAILABLE';
    throw error;
  }

  const resolvedModel = String(modelId || '').trim() || DEFAULT_MODEL;
  const resolvedVoice = normalizeVoice(voiceId || DEFAULT_VOICE, resolvedModel);
  const resolvedSpeed = Number.isFinite(Number(speed))
    ? Math.min(4.0, Math.max(0.25, Number(speed)))
    : 1.0;
  const requestSignal = signalWithTimeout(signal, TTS_TIMEOUT_MS);
  throwIfAborted(signal);

  const payload = {
    model: resolvedModel,
    input: narration,
    voice: resolvedVoice,
    response_format: 'mp3',
    speed: resolvedSpeed,
  };
  // tts-1/tts-1-hd silently ignore `instructions` per OpenAI docs — only
  // send it where it acts, so behaviour never depends on ignored fields.
  if (supportsInstructions(resolvedModel) && String(instructions || '').trim()) {
    payload.instructions = String(instructions).trim().slice(0, 1000);
  }

  const response = await doFetch(`${API_BASE}/audio/speech`, {
    method: 'POST',
    signal: requestSignal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = typeof response.text === 'function'
      ? await response.text().catch(() => '')
      : '';
    throw classifyOpenAiError(response.status, bodyText);
  }
  throwIfAborted(signal);

  const arrayBuffer = typeof response.arrayBuffer === 'function'
    ? await response.arrayBuffer().catch(() => null)
    : null;
  const audioBuffer = arrayBuffer ? Buffer.from(arrayBuffer) : Buffer.alloc(0);
  if (!audioBuffer.length) {
    const error = new Error('OpenAI returned no audio');
    error.code = 'EMPTY_AUDIO';
    throw error;
  }
  throwIfAborted(signal);

  ensureDir(audioDir);
  const filename = `openai_tts_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.mp3`;
  const audioPath = path.join(audioDir, filename);
  fs.writeFileSync(audioPath, audioBuffer);

  return {
    filename,
    audioPath,
    audioUrl: `/api/elevenlabs/audio/${filename}`,
    sizeBytes: audioBuffer.length,
    mime: 'audio/mpeg',
    format: 'mp3',
    voiceId: resolvedVoice,
    modelId: resolvedModel,
    characters: narration.length,
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  OPENAI_TTS_VOICES,
  audioDir,
  generateOpenAiSpeechFile,
  getOpenAiApiKey,
  isOpenAiTtsConfigured,
  normalizeVoice,
  supportsInstructions,
};
