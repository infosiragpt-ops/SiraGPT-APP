/**
 * Gemini text-to-speech fallback for the deterministic Voice composer.
 * Gemini returns raw 24 kHz mono PCM, so this service wraps it in a WAV
 * container before exposing it through the existing authenticated audio route.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout, throwIfAborted } = require('../../utils/abort-signal');

const DEFAULT_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE || 'Kore';
const DEFAULT_SAMPLE_RATE = 24000;
const TTS_TIMEOUT_MS = Math.max(1000, Number(process.env.GEMINI_TTS_TIMEOUT_MS) || 120000);

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getGeminiApiKey(env = process.env) {
  return String(
    env.GEMINI_API_KEY
    || env.GOOGLE_GENERATIVE_AI_API_KEY
    || env.GOOGLE_AI_API_KEY
    || '',
  ).trim();
}

function isGeminiTtsConfigured(env = process.env) {
  return Boolean(getGeminiApiKey(env));
}

function parseSampleRate(mimeType) {
  const match = String(mimeType || '').match(/(?:^|;)\s*rate=(\d+)/i);
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_RATE;
}

function pcm16ToWav(pcmBuffer, { sampleRate = DEFAULT_SAMPLE_RATE, channels = 1 } = {}) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function buildSpeechPrompt(text, { language, accent, effect, stability } = {}) {
  const languageLabel = String(language || 'Spanish').trim();
  const accentLabel = String(accent || 'Latino').trim();
  const effectLabel = String(effect || 'Studio Clean').trim();
  const stabilityValue = Number(stability);
  const delivery = Number.isFinite(stabilityValue) && stabilityValue < 60
    ? 'expressive and dynamic'
    : 'steady, natural and professional';

  return [
    'Read the TRANSCRIPT exactly as written. Do not add, remove, translate, or explain any words.',
    `Use ${languageLabel} with a ${accentLabel} accent and a ${delivery} delivery.`,
    effectLabel && effectLabel !== 'None' ? `Audio direction: ${effectLabel}.` : '',
    '',
    'TRANSCRIPT:',
    String(text || '').trim(),
  ].filter((line) => line !== '').join('\n');
}

function classifyGeminiError(status, body) {
  const detail = body?.error?.message || `Gemini TTS failed with HTTP ${status}`;
  const error = new Error(detail);
  error.status = status;
  error.statusCode = status;
  error.code = status === 429
    ? 'RATE_LIMITED'
    : status === 401 || status === 403
      ? 'GEMINI_TTS_AUTH_ERROR'
      : status === 400
        ? 'GEMINI_TTS_INVALID_REQUEST'
        : 'GEMINI_TTS_ERROR';
  return error;
}

async function generateGeminiSpeechFile({
  text,
  language,
  accent,
  effect,
  stability,
  modelId,
  voiceId,
  signal,
  fetchImpl,
} = {}) {
  const narration = String(text || '').trim();
  if (!narration) {
    const error = new Error('Text is required for speech generation');
    error.code = 'TEXT_REQUIRED';
    throw error;
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    const error = new Error('Gemini TTS API key not configured');
    error.code = 'GEMINI_TTS_NOT_CONFIGURED';
    throw error;
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    const error = new Error('fetch is not available in this runtime');
    error.code = 'FETCH_UNAVAILABLE';
    throw error;
  }

  const resolvedModel = String(modelId || '').trim() || DEFAULT_MODEL;
  const resolvedVoice = String(voiceId || '').trim() || DEFAULT_VOICE;
  const requestSignal = signalWithTimeout(signal, TTS_TIMEOUT_MS);
  throwIfAborted(signal);

  const response = await doFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent`,
    {
      method: 'POST',
      signal: requestSignal,
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: buildSpeechPrompt(narration, { language, accent, effect, stability }),
          }],
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: resolvedVoice },
            },
          },
        },
      }),
    },
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw classifyGeminiError(response.status, body);
  throwIfAborted(signal);

  const part = body?.candidates?.[0]?.content?.parts?.find((entry) => entry?.inlineData?.data);
  const pcmBuffer = part?.inlineData?.data
    ? Buffer.from(part.inlineData.data, 'base64')
    : Buffer.alloc(0);
  if (!pcmBuffer.length) {
    const error = new Error('Gemini returned no audio');
    error.code = 'EMPTY_AUDIO';
    throw error;
  }

  const sampleRate = parseSampleRate(part?.inlineData?.mimeType);
  const audioBuffer = pcm16ToWav(pcmBuffer, { sampleRate });
  throwIfAborted(signal);

  ensureDir(audioDir);
  const filename = `gemini_tts_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.wav`;
  const audioPath = path.join(audioDir, filename);
  fs.writeFileSync(audioPath, audioBuffer);

  return {
    filename,
    audioPath,
    audioUrl: `/api/elevenlabs/audio/${filename}`,
    sizeBytes: audioBuffer.length,
    mime: 'audio/wav',
    format: 'wav',
    voiceId: resolvedVoice,
    modelId: resolvedModel,
    characters: narration.length,
    durationSeconds: pcmBuffer.length / (sampleRate * 2),
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VOICE,
  audioDir,
  buildSpeechPrompt,
  generateGeminiSpeechFile,
  getGeminiApiKey,
  isGeminiTtsConfigured,
  parseSampleRate,
  pcm16ToWav,
};
