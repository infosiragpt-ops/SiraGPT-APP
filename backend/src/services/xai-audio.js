'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_XAI_CHAT_MODEL = 'grok-4.3';
const DEFAULT_XAI_STT_MODEL = 'grok-stt';
const DEFAULT_XAI_TTS_VOICE = 'eve';
const DEFAULT_XAI_TTS_LANGUAGE = 'es';
const DEFAULT_XAI_TTS_FORMAT = 'mp3';
const DEFAULT_XAI_TIMEOUT_MS = 45_000;
const XAI_TTS_VOICES = new Set(['eve', 'ara', 'rex', 'sal', 'leo', 'una']);
const XAI_TTS_FORMATS = new Set(['mp3', 'wav', 'pcm', 'mulaw', 'alaw']);

function normalizeOptionalString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeXaiBaseUrl(value) {
  return (normalizeOptionalString(value) || DEFAULT_XAI_BASE_URL).replace(/\/+$/, '');
}

function normalizeXaiVoice(value) {
  const voice = (normalizeOptionalString(value) || DEFAULT_XAI_TTS_VOICE).toLowerCase();
  if (!XAI_TTS_VOICES.has(voice)) {
    const error = new Error(`Unsupported xAI voice: ${voice}`);
    error.code = 'xai_voice_unsupported';
    throw error;
  }
  return voice;
}

function normalizeXaiAudioFormat(value) {
  const format = (normalizeOptionalString(value) || DEFAULT_XAI_TTS_FORMAT).toLowerCase();
  if (!XAI_TTS_FORMATS.has(format)) {
    const error = new Error(`Unsupported xAI audio format: ${format}`);
    error.code = 'xai_audio_format_unsupported';
    throw error;
  }
  return format;
}

function mimeTypeForFormat(format) {
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'pcm': return 'audio/L16';
    case 'mulaw': return 'audio/basic';
    case 'alaw': return 'audio/alaw';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

function resolveXaiAudioConfig(env = process.env) {
  const apiKey = normalizeOptionalString(env.XAI_API_KEY);
  return {
    configured: Boolean(apiKey),
    apiKey,
    baseUrl: normalizeXaiBaseUrl(env.XAI_API_BASE_URL || env.XAI_BASE_URL),
    chatModel: normalizeOptionalString(env.GROK_VOICE_MODEL || env.XAI_GROK_MODEL) || DEFAULT_XAI_CHAT_MODEL,
    sttModel: normalizeOptionalString(env.GROK_VOICE_STT_MODEL || env.XAI_STT_MODEL) || DEFAULT_XAI_STT_MODEL,
    ttsVoice: normalizeXaiVoice(env.GROK_VOICE_TTS_VOICE || env.XAI_TTS_VOICE),
    ttsLanguage: normalizeOptionalString(env.GROK_VOICE_TTS_LANGUAGE || env.XAI_TTS_LANGUAGE) || DEFAULT_XAI_TTS_LANGUAGE,
    ttsFormat: normalizeXaiAudioFormat(env.GROK_VOICE_TTS_FORMAT || env.XAI_TTS_FORMAT),
    timeoutMs: Number(env.XAI_AUDIO_TIMEOUT_MS || env.GROK_VOICE_TIMEOUT_MS || DEFAULT_XAI_TIMEOUT_MS),
  };
}

function requireXaiApiKey(config) {
  if (config.apiKey) return config.apiKey;
  const error = new Error('XAI_API_KEY is required for Grok voice STT/TTS.');
  error.code = 'xai_api_key_missing';
  throw error;
}

function xaiHeaders(config, extra = {}) {
  return {
    Authorization: `Bearer ${requireXaiApiKey(config)}`,
    'User-Agent': 'SiraGPT-GrokVoice/1.0',
    ...extra,
  };
}

function transcriptionTextFromPayload(payload) {
  if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text.trim();
  if (typeof payload?.transcript === 'string' && payload.transcript.trim()) return payload.transcript.trim();
  if (Array.isArray(payload?.segments)) {
    const joined = payload.segments
      .map((segment) => segment?.text || segment?.transcript || '')
      .join(' ')
      .trim();
    if (joined) return joined;
  }
  const error = new Error('xAI STT response did not include transcript text.');
  error.code = 'xai_stt_empty_transcript';
  throw error;
}

/**
 * A word's probability in (0, 1], from `logprob` (ElevenLabs, OpenAI-style)
 * or `confidence` / `probability` / `p`; null when the payload has none.
 */
function wordProbability(word) {
  const logprob = Number(word?.logprob ?? word?.log_prob);
  if ((word?.logprob != null || word?.log_prob != null) && Number.isFinite(logprob)) return Math.min(1, Math.max(1e-6, Math.exp(Math.min(0, logprob))));
  for (const key of ['confidence', 'probability', 'p']) {
    const value = Number(word?.[key]);
    if (word?.[key] != null && Number.isFinite(value)) return Math.min(1, Math.max(1e-6, value));
  }
  return null;
}

/** Geometric mean of the collected word probabilities (same scale as exp(avg_logprob)). */
function closeConfidence(segment) {
  if (!segment) return segment;
  const { logSum, logCount, ...rest } = segment;
  if (logCount > 0) rest.confidence = Math.round(Math.exp(logSum / logCount) * 1000) / 1000;
  return rest;
}

/**
 * Timed segments from an STT payload: `segments[{start,end,text}]` as is, or
 * `words[{start,end,text|word}]` grouped on pauses (≥ 1 s), sentence ends and
 * a 12 s ceiling. [] when the payload carries no timing. Word types other
 * than spoken words (`spacing`, `audio_event` such as «(risas)») are not
 * text. A segment carries `confidence` when its words or the segment itself
 * report a probability (only ever compared with the same engine's output).
 */
function segmentsFromPayload(payload) {
  const timed = (item) => Number.isFinite(Number(item?.start)) && Number.isFinite(Number(item?.end));
  if (Array.isArray(payload?.segments) && payload.segments.some(timed)) {
    return payload.segments.filter(timed).map((segment) => {
      const out = {
        start: Number(segment.start),
        end: Number(segment.end),
        text: String(segment.text || segment.transcript || '').trim(),
        ...(segment.speaker != null ? { speaker: String(segment.speaker) } : {}),
      };
      if (segment.avg_logprob != null && Number.isFinite(Number(segment.avg_logprob))) out.avg_logprob = Number(segment.avg_logprob);
      else {
        const p = wordProbability(segment);
        if (p != null) out.confidence = Math.round(p * 1000) / 1000;
      }
      return out;
    }).filter((segment) => segment.text);
  }
  if (!Array.isArray(payload?.words)) return [];
  const out = [];
  let current = null;
  for (const word of payload.words.filter(timed)) {
    const type = String(word.type || 'word').toLowerCase();
    if (type !== 'word') continue;
    const text = String(word.text ?? word.word ?? '').trim();
    if (!text) continue;
    const start = Number(word.start);
    const end = Number(word.end);
    const rawSpeaker = word.speaker ?? word.speakerId ?? word.speaker_id;
    const speaker = rawSpeaker != null ? String(rawSpeaker) : undefined;
    if (current && (start - current.end >= 1 || end - current.start > 12 || speaker !== current.speaker || /[.!?…]$/.test(current.text))) {
      out.push(closeConfidence(current));
      current = null;
    }
    if (!current) current = { start, end, text, ...(speaker !== undefined ? { speaker } : {}), logSum: 0, logCount: 0 };
    else { current.end = end; current.text = `${current.text} ${text}`; }
    const p = wordProbability(word);
    if (p != null) { current.logSum += Math.log(p); current.logCount++; }
  }
  if (current) out.push(closeConfidence(current));
  return out;
}

async function transcribeXaiAudioFile({
  filePath,
  originalName,
  mimeType,
  model,
  language,
  detectLanguage = false,
  timeoutMs,
  signal,
  env = process.env,
  axiosImpl = axios,
} = {}) {
  if (!filePath) {
    const error = new Error('Audio file path is required for xAI STT.');
    error.code = 'xai_audio_file_required';
    throw error;
  }

  const config = resolveXaiAudioConfig(env);
  const form = new FormData();
  // Text fields BEFORE the file: a multipart parser that streams the file
  // part only knows the fields it has already read.
  form.append('model', normalizeOptionalString(model) || config.sttModel);
  // A transcription job that wants detection must not inherit the TTS voice
  // language (es) as a forced STT language.
  const normalizedLanguage = normalizeOptionalString(language) || (detectLanguage ? null : normalizeOptionalString(config.ttsLanguage));
  if (normalizedLanguage) form.append('language', normalizedLanguage);
  const audioStream = fs.createReadStream(filePath);
  form.append('file', audioStream, {
    filename: originalName || path.basename(filePath) || 'voice.webm',
    contentType: mimeType || 'application/octet-stream',
  });
  const explicitTimeout = Number(timeoutMs);

  try {
    const response = await axiosImpl.post(`${config.baseUrl}/stt`, form, {
      headers: xaiHeaders(config, form.getHeaders()),
      timeout: Number.isFinite(explicitTimeout) && explicitTimeout > 0 ? explicitTimeout : config.timeoutMs,
      signal,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return {
      provider: 'xai',
      model: normalizeOptionalString(model) || config.sttModel,
      text: transcriptionTextFromPayload(response.data),
      language: normalizeOptionalString(response.data?.language),
      segments: segmentsFromPayload(response.data),
      raw: response.data,
    };
  } finally {
    audioStream.destroy();
  }
}

async function synthesizeXaiSpeech({
  text,
  voice,
  language,
  format,
  env = process.env,
  axiosImpl = axios,
} = {}) {
  const content = normalizeOptionalString(text);
  if (!content) {
    const error = new Error('Text is required for xAI TTS.');
    error.code = 'xai_tts_text_required';
    throw error;
  }

  const config = resolveXaiAudioConfig(env);
  const outputFormat = normalizeXaiAudioFormat(format || config.ttsFormat);
  const voiceId = normalizeXaiVoice(voice || config.ttsVoice);
  const response = await axiosImpl.post(`${config.baseUrl}/tts`, {
    text: content,
    voice_id: voiceId,
    language: normalizeOptionalString(language || config.ttsLanguage) || DEFAULT_XAI_TTS_LANGUAGE,
    output_format: { codec: outputFormat },
  }, {
    headers: xaiHeaders(config, { 'Content-Type': 'application/json' }),
    responseType: 'arraybuffer',
    timeout: config.timeoutMs,
    maxContentLength: 16 * 1024 * 1024,
  });

  return {
    provider: 'xai',
    voice: voiceId,
    language: normalizeOptionalString(language || config.ttsLanguage) || DEFAULT_XAI_TTS_LANGUAGE,
    format: outputFormat,
    mimeType: mimeTypeForFormat(outputFormat),
    buffer: Buffer.from(response.data),
  };
}

function serializeAudioForJson(audio) {
  if (!audio?.buffer) return null;
  return {
    provider: audio.provider || 'xai',
    voice: audio.voice,
    language: audio.language,
    format: audio.format,
    mimeType: audio.mimeType || mimeTypeForFormat(audio.format),
    base64: Buffer.from(audio.buffer).toString('base64'),
  };
}

module.exports = {
  DEFAULT_XAI_BASE_URL,
  DEFAULT_XAI_CHAT_MODEL,
  DEFAULT_XAI_STT_MODEL,
  DEFAULT_XAI_TTS_VOICE,
  DEFAULT_XAI_TTS_LANGUAGE,
  DEFAULT_XAI_TTS_FORMAT,
  resolveXaiAudioConfig,
  segmentsFromPayload,
  wordProbability,
  transcribeXaiAudioFile,
  synthesizeXaiSpeech,
  serializeAudioForJson,
  normalizeXaiBaseUrl,
};
