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

async function transcribeXaiAudioFile({
  filePath,
  originalName,
  mimeType,
  model,
  language,
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
  form.append('file', fs.createReadStream(filePath), {
    filename: originalName || path.basename(filePath) || 'voice.webm',
    contentType: mimeType || 'application/octet-stream',
  });
  form.append('model', normalizeOptionalString(model) || config.sttModel);
  const normalizedLanguage = normalizeOptionalString(language || config.ttsLanguage);
  if (normalizedLanguage) form.append('language', normalizedLanguage);

  const response = await axiosImpl.post(`${config.baseUrl}/stt`, form, {
    headers: xaiHeaders(config, form.getHeaders()),
    timeout: config.timeoutMs,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return {
    provider: 'xai',
    model: normalizeOptionalString(model) || config.sttModel,
    text: transcriptionTextFromPayload(response.data),
    raw: response.data,
  };
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
  transcribeXaiAudioFile,
  synthesizeXaiSpeech,
  serializeAudioForJson,
  normalizeXaiBaseUrl,
};
