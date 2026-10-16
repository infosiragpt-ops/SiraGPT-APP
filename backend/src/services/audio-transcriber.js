'use strict';

/**
 * Audio transcriber — speech-to-text for audio/video, from WhatsApp PTT
 * (ogg/opus/m4a) to multi-hour lectures.
 *
 * Ladder:
 *   1. OpenAI Whisper — optional faster path when a key is present AND the
 *      request succeeds.
 *   2. Groq (OpenAI-compatible `/openai/v1/audio/transcriptions`,
 *      whisper-large-v3-turbo) — GROQ_API_KEY.
 *   3. xAI Grok STT; Meta only when SIRAGPT_META_TRANSCRIPTION=1 (its API
 *      has no STT endpoint: prod answered 404 on every audio).
 *   4. VoiceStudio (opt-in, listed in TRANSCRIBE_PROVIDERS).
 *   5. Local Whisper (whisper.cpp or faster-whisper) — no API key.
 *   6. Sanitized Spanish placeholder — never includes provider error text
 *      or API keys.
 * A provider that rejects its key (401/403) or has no credits (402 / billing
 * 429) is skipped for TRANSCRIBE_PROVIDER_COOLDOWN_MS (30 min) so the next
 * audio job does not re-hit it. A RATE LIMIT (429 «try again in 2m3s») is not
 * «no credits»: it never starts that cooldown.
 *
 * Short clips (within the provider byte cap and one segment long) go to each
 * rung as ONE request, exactly as before. Anything longer is a segmented job:
 *   - the file is cut ONCE (FLAC 16 kHz mono, cuts snapped to silences) into
 *     the caller's checkpoint dir when it has one (`<dir>/audio` + a manifest
 *     reused across restarts and deploys), otherwise into a temp dir;
 *   - each segment climbs the ladder on its own. A rate limit waits
 *     (Retry-After / «try again in», ≤ 5 min) and retries the SAME provider;
 *     a transient 5xx/timeout gets 2 retries; a dead key or empty balance
 *     drops the rung for the job; anything else demotes only that segment;
 *   - cloud segments run TRANSCRIBE_CLOUD_PARALLEL (3) at a time, local ones
 *     TRANSCRIBE_LOCAL_PARALLEL (1); results are stitched back by index;
 *   - a segment that fails on every rung becomes a gap: the result is partial
 *     («[01:20:00–01:30:00: no se pudo transcribir este tramo]» in the text)
 *     unless coverage drops under TRANSCRIBE_MIN_COVERAGE (0.8);
 *   - the language is detected on the first segment and locked for the rest;
 *   - every finished segment is checkpointed with its provider, model,
 *     language and cut plan, and the result reports chunks per engine.
 *
 * Config:
 *   WHISPER_MODEL = whisper-1 (OpenAI only; gpt-4o*-transcribe models get
 *     json / diarized_json and 300 s segments)
 *   WHISPER_LANGUAGE = hint for SHORT clips (≤ TRANSCRIBE_AUTO_LANGUAGE_MIN_SECONDS,
 *     60 s, or unknown length); longer media is auto-detected. Defaults to es.
 *   WHISPER_PROMPT = optional guiding prompt; options.keyterms are appended
 *   AUDIO_MAX_FILE_BYTES = 25 MB
 *   WHISPER_CPP_BIN / WHISPER_CPP_MODEL / LOCAL_WHISPER_MODEL
 * Segmented jobs:
 *   TRANSCRIBE_CLOUD_PARALLEL (3) / TRANSCRIBE_LOCAL_PARALLEL (1)
 *   TRANSCRIBE_MIN_COVERAGE (0.8) — below it a partial job is a failure
 *   TRANSCRIBE_RATE_LIMIT_MAX_WAIT_MS (300000) / TRANSCRIBE_RATE_LIMIT_RETRIES (5)
 *   TRANSCRIBE_SEGMENT_RETRIES (2, cloud 5xx/timeouts) / TRANSCRIBE_LOCAL_RETRIES (0)
 *   TRANSCRIBE_CLOUD_TIMEOUT_MS (max(120 s, 0.4 s per audio second))
 *   TRANSCRIBE_SILENCE_SNAP (on; 0 cuts on fixed times)
 */

const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { redactString } = require('../utils/secret-redactor');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildUntrustedChildEnv } = require('../utils/untrusted-child-env');
const execFileAsync = promisify(execFile);
const localWhisper = require('./local-whisper-engine');
const keyHealth = require('../utils/provider-key-health');
const voiceStudioClient = (options = {}) => options.voiceStudio || require('./ai/voicestudio-client');

const DEFAULT_AUDIO_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_OPENAI_MODEL = 'whisper-1';
const DEFAULT_LANGUAGE = 'es';

const AUDIO_MIME_MAP = {
  'audio/flac': { ext: 'flac', label: 'Audio FLAC' },
  'audio/x-flac': { ext: 'flac', label: 'Audio FLAC' },
  'audio/aac': { ext: 'aac', label: 'Audio AAC' },
  'audio/x-aac': { ext: 'aac', label: 'Audio AAC' },
  'audio/aiff': { ext: 'aiff', label: 'Audio AIFF' },
  'audio/x-aiff': { ext: 'aiff', label: 'Audio AIFF' },
  'audio/x-caf': { ext: 'caf', label: 'Audio CAF' },
  'audio/amr': { ext: 'amr', label: 'Audio AMR' },
  'audio/3gpp': { ext: '3gp', label: 'Audio 3GP' },
  'audio/x-ms-wma': { ext: 'wma', label: 'Audio WMA' },
  'audio/mpeg': { ext: 'mp3', label: 'Audio MP3' },
  'audio/mp3': { ext: 'mp3', label: 'Audio MP3' },
  'audio/wav': { ext: 'wav', label: 'Audio WAV' },
  'audio/x-wav': { ext: 'wav', label: 'Audio WAV' },
  'audio/ogg': { ext: 'ogg', label: 'Audio OGG' },
  'audio/opus': { ext: 'opus', label: 'Audio Opus' },
  'application/ogg': { ext: 'ogg', label: 'Audio OGG' },
  'audio/webm': { ext: 'webm', label: 'Audio WebM' },
  'audio/mp4': { ext: 'm4a', label: 'Audio M4A' },
  'audio/m4a': { ext: 'm4a', label: 'Audio M4A' },
  'audio/x-m4a': { ext: 'm4a', label: 'Audio M4A' },
  'video/mp4': { ext: 'mp4', label: 'Video MP4' },
  'video/mpeg': { ext: 'mpeg', label: 'Video MPEG' },
  'video/quicktime': { ext: 'mov', label: 'Video QuickTime' },
  'video/webm': { ext: 'webm', label: 'Video WebM' },
};

const EXT_MIME_FALLBACK = {
  '.flac': 'audio/flac',
  '.mpga': 'audio/mpeg',
  '.mp2': 'audio/mpeg',
  '.wave': 'audio/wav',
  '.awb': 'audio/amr-wb',
  '.au': 'audio/basic',
  '.weba': 'audio/webm',
  '.m4b': 'audio/mp4',
  '.caf': 'audio/x-caf',
  '.aifc': 'audio/aiff',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
  '.3g2': 'video/3gpp2',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.amr': 'audio/amr',
  '.3gp': 'audio/3gpp',
  '.wma': 'audio/x-ms-wma',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'audio/webm',
};

// Upload-friendly MIME for a segment file sent to a cloud rung.
const SEGMENT_MIME_BY_EXT = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
};

const SUCCESS_METHODS = new Set(['whisper', 'local-whisper']);
// Cloud transcription ladder. OpenAI Whisper first when its key works, then
// xAI Grok STT (`/v1/stt`, see xai-audio.js), then Meta's transcription model
// (OpenAI-compatible `audio/transcriptions`), then the local whisper.cpp
// engine which has no size limit. An invalid key on one rung never blocks
// the next: every rung is tried in order.
const DEFAULT_PROVIDER_ORDER = ['openai', 'groq', 'xai', 'meta', 'local'];
const DEFAULT_XAI_STT_MODEL = 'grok-stt';
const DEFAULT_GROQ_TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_META_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
const DEFAULT_META_BASE_URL = 'https://api.meta.ai/v1';
// A rejected key / empty balance is remembered this long (provider-key-health).
const DEFAULT_PROVIDER_COOLDOWN_MS = 30 * 60 * 1000;
const COOLDOWN_NAMESPACE = 'transcribe:';
const COOLDOWN_PROVIDERS = ['openai', 'groq', 'xai', 'meta'];
// Cloud providers cap request bodies (25 MB on Whisper). Longer recordings
// are cut into ≤ 10-minute FLAC 16 kHz mono segments (≈ 10 MB each).
const DEFAULT_SEGMENT_SECONDS = 600;
const SEGMENT_SAMPLE_RATE = '16000';
// A final piece shorter than this is merged into the previous one: a 0.1 s
// request is wasted money at best and a hallucinated «Gracias.» at worst.
const MIN_TAIL_SECONDS = 2;
// Cuts snap to the latest silence within this window BEFORE each target, so
// no segment ever exceeds the segment length a provider accepts.
const MAX_SNAP_WINDOW_SECONDS = 45;
const SILENCE_FILTER = 'silencedetect=noise=-35dB:d=0.4';
// Parallelism, retries and coverage (env-tunable).
const DEFAULT_CLOUD_PARALLEL = 3;
const DEFAULT_LOCAL_PARALLEL = 1;
const DEFAULT_MIN_COVERAGE = 0.8;
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_RETRIES = 5;
const DEFAULT_SEGMENT_RETRIES = 2;
const DEFAULT_LOCAL_RETRIES = 0;
const DEFAULT_AUTO_LANGUAGE_MIN_SECONDS = 60;
const RATE_LIMIT_BASE_WAIT_MS = 15_000;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
// After this many consecutive segments failed on a rung, the rest of the job
// stops trying it (a provider that is down must not cost 3 calls per segment).
const RUNG_MAX_CONSECUTIVE_FAILURES = 3;
// Language detection runs on the first segments, one at a time, until the
// detections decide a language (decideLanguage); the rest of the job uses it.
const LANGUAGE_DETECT_MAX_SEGMENTS = 3;
// Whisper detects the language on the first 30 s of what it is given.
const LANGUAGE_DETECT_WINDOW_SECONDS = 30;
const MAX_PROMPT_CHARS = 1000;
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 80;
const MANIFEST_VERSION = 1;
const KEYISH_RE = /\bsk-[A-Za-z0-9._-]{3,}\b|\bBearer\s+\S+|OPENAI_API_KEY/i;
const RATE_LIMIT_TEXT_RE = /rate.?limit|too many requests|try again in|per (?:second|minute|hour|day)|requests per|tokens per|\((?:RPM|RPD|TPM|TPD|ASH|ASD)\)/i;

/** Clamp to a finite, non-negative millisecond timestamp. */
function clampTimestampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** 3723.5 → "01:02:03,500" (SRT) or "01:02:03.500" (VTT). */
function formatTimestamp(seconds, separator) {
  const totalMs = Math.max(0, Math.round(clampTimestampSeconds(seconds) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}${separator}${String(ms).padStart(3, '0')}`;
}

/** 4800.4 → "01:20:00" (whole seconds, for gap markers). */
function formatClock(seconds) {
  const total = Math.floor(clampTimestampSeconds(seconds));
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
}

/** Inline marker for a stretch no rung could transcribe. */
function gapMarker(start, end) {
  return `[${formatClock(start)}–${formatClock(end)}: no se pudo transcribir este tramo]`;
}

function cleanSegmentText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

// Whisper can successfully decode silence/music while emitting only a
// non-speech annotation. It is not a spoken transcript and must not become
// evidence for a subsequent analysis. Keep annotations when speech ALSO
// exists; never discard a short real utterance such as "Sí" or "No".
function hasSpeechText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !/^(?:(?:\[|\()\s*(?:blank[_ ]audio|no[_ ]speech|silence|silent|silencio|m[uú]sica|music|inaudible|aplausos|applause|ruido|noise|sonido)\s*(?:\]|\))\s*[.,!]?\s*|<\|nospeech\|>\s*)+$/i.test(text);
}

/** Per-segment confidence in 0..1: explicit, or exp(avg_logprob) from verbose_json. */
function segmentConfidence(raw) {
  const explicit = Number(raw?.confidence);
  if (raw?.confidence != null && Number.isFinite(explicit)) return round3(Math.min(1, Math.max(0, explicit)));
  const logprob = Number(raw?.avg_logprob);
  if (raw?.avg_logprob != null && Number.isFinite(logprob)) return round3(Math.min(1, Math.max(0, Math.exp(logprob))));
  return null;
}

/**
 * Normalize raw provider segments: drop empties, fix inverted ranges. Keeps
 * `speaker` (diarizing rungs) and `confidence` when the provider gave them.
 */
function normalizeSegments(segments) {
  const out = [];
  for (const raw of Array.isArray(segments) ? segments : []) {
    const text = cleanSegmentText(raw?.text);
    if (!text) continue;
    const start = clampTimestampSeconds(raw?.start);
    let end = clampTimestampSeconds(raw?.end);
    if (!(end > start)) end = start + 0.5;
    const segment = { start, end, text };
    const speaker = raw?.speaker == null ? '' : String(raw.speaker).trim();
    if (speaker) segment.speaker = speaker.slice(0, 64);
    const confidence = segmentConfidence(raw);
    if (confidence != null) segment.confidence = confidence;
    out.push(segment);
  }
  return out;
}

function sortSegments(segments) {
  return segments.slice().sort((a, b) => (a.start - b.start) || (a.end - b.end));
}

/** SubRip subtitles. Empty string when there are no usable segments. */
function buildSrt(segments) {
  const list = normalizeSegments(segments);
  return list.map((seg, index) => [
    String(index + 1),
    `${formatTimestamp(seg.start, ',')} --> ${formatTimestamp(seg.end, ',')}`,
    seg.text,
    '',
  ].join('\n')).join('\n').trim();
}

/** WebVTT subtitles. Empty string when there are no usable segments. */
function buildVtt(segments) {
  const list = normalizeSegments(segments);
  if (!list.length) return '';
  return ['WEBVTT', '', ...list.map((seg) => [
    `${formatTimestamp(seg.start, '.')} --> ${formatTimestamp(seg.end, '.')}`,
    seg.text,
    '',
  ].join('\n'))].join('\n').trim() + '\n';
}

/** Best-effort progress relay for long jobs; never breaks transcription. */
function emitProgress(options, event) {
  try {
    if (options && typeof options.onProgress === 'function') options.onProgress(event);
  } catch { /* progress is best-effort */ }
}

function envOf(options = {}) {
  return options.env || process.env;
}

function envNumber(options, name, fallback, { min = -Infinity, max = Infinity, integer = true } = {}) {
  const raw = envOf(options)[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = integer ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function audioMaxFileBytes(options = {}) {
  const raw = Number.parseInt(
    options.maxFileBytes || envOf(options).AUDIO_MAX_FILE_BYTES || '',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUDIO_MAX_FILE_BYTES;
}

function normalizeAudioMime(mimeType, fileName) {
  const declared = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (AUDIO_MIME_MAP[declared]) return declared;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return EXT_MIME_FALLBACK[ext] || declared;
}

function mimeInfo(mimeType, fileName) {
  const normalized = normalizeAudioMime(mimeType, fileName);
  return AUDIO_MIME_MAP[normalized] || { ext: 'bin', label: 'Archivo de audio' };
}

// ── Language ────────────────────────────────────────────────────────────────

const AUTO_LANGUAGE_RE = /^(?:auto|automatic|autom[aá]tico|detect|detectar|detecci[oó]n|any|cualquiera|none|ninguno)$/i;
// Spanish names users type, plus English names Whisper's verbose_json returns
// that voicestudio-client's LANGUAGE_CODES does not list.
const EXTRA_LANGUAGE_NAMES = Object.freeze({
  español: 'es', espanol: 'es', castellano: 'es', inglés: 'en', ingles: 'en', francés: 'fr', frances: 'fr',
  portugués: 'pt', portugues: 'pt', alemán: 'de', aleman: 'de', italiano: 'it', catalán: 'ca', catala: 'ca',
  japonés: 'ja', japones: 'ja', chino: 'zh', mandarín: 'zh', mandarin: 'zh', coreano: 'ko', ruso: 'ru',
  árabe: 'ar', arabe: 'ar', neerlandés: 'nl', neerlandes: 'nl', holandés: 'nl', holandes: 'nl', polaco: 'pl',
  turco: 'tr', ucraniano: 'uk', rumano: 'ro', sueco: 'sv', griego: 'el', hebreo: 'he', gallego: 'gl',
  euskera: 'eu', vasco: 'eu', galician: 'gl', basque: 'eu', tagalog: 'tl', malay: 'ms', persian: 'fa',
  urdu: 'ur', tamil: 'ta', welsh: 'cy', slovak: 'sk', slovenian: 'sl', croatian: 'hr', serbian: 'sr',
  bulgarian: 'bg', lithuanian: 'lt', latvian: 'lv', estonian: 'et', icelandic: 'is', swahili: 'sw', latin: 'la',
});
const ISO639_2_TO_1 = Object.freeze({
  spa: 'es', eng: 'en', por: 'pt', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', cat: 'ca',
  jpn: 'ja', zho: 'zh', chi: 'zh', kor: 'ko', rus: 'ru', ara: 'ar', que: 'qu', nld: 'nl', dut: 'nl',
  pol: 'pl', tur: 'tr', hin: 'hi', ukr: 'uk', ron: 'ro', rum: 'ro', swe: 'sv', nor: 'no', dan: 'da',
  fin: 'fi', ell: 'el', gre: 'el', heb: 'he', ces: 'cs', cze: 'cs', hun: 'hu', ind: 'id', tha: 'th',
  vie: 'vi', glg: 'gl', eus: 'eu', baq: 'eu',
});

let cachedLanguageCodes = null;
function languageCodesFromVoiceStudio() {
  if (cachedLanguageCodes) return cachedLanguageCodes;
  try {
    cachedLanguageCodes = require('./ai/voicestudio-client').LANGUAGE_CODES || {};
  } catch {
    cachedLanguageCodes = {};
  }
  return cachedLanguageCodes;
}

/**
 * ISO-639-1 code for a language name / tag / code, or undefined (detect).
 * 'auto', 'detect', '' → undefined; 'es-PE' → 'es'; 'spanish' / 'español' →
 * 'es'; 'spa' → 'es'. Providers reject anything that is not ISO-639-1.
 */
function normalizeLanguage(value) {
  if (value == null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (AUTO_LANGUAGE_RE.test(lower)) return undefined;
  const codes = languageCodesFromVoiceStudio();
  if (Object.prototype.hasOwnProperty.call(codes, lower)) return codes[lower] || undefined;
  if (Object.prototype.hasOwnProperty.call(EXTRA_LANGUAGE_NAMES, lower)) return EXTRA_LANGUAGE_NAMES[lower];
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]{1,8})*$/i.exec(raw);
  if (!tag) return undefined;
  const base = tag[1].toLowerCase();
  if (base.length === 2) return base;
  return ISO639_2_TO_1[base];
}

function autoLanguageMinSeconds(options = {}) {
  return envNumber(options, 'TRANSCRIBE_AUTO_LANGUAGE_MIN_SECONDS', DEFAULT_AUTO_LANGUAGE_MIN_SECONDS, { min: 0 });
}

function hasExplicitLanguage(options = {}) {
  return typeof options.language === 'string' && Boolean(options.language.trim());
}

/**
 * The language to REQUEST. An explicit option wins ('auto' → detect). Without
 * one, media longer than TRANSCRIBE_AUTO_LANGUAGE_MIN_SECONDS (60 s) is
 * auto-detected; short clips and unknown lengths keep the WHISPER_LANGUAGE
 * hint (default es — Peruvian WhatsApp notes). Undefined means «detect».
 */
function resolveLanguage(options = {}) {
  if (hasExplicitLanguage(options)) return normalizeLanguage(options.language);
  const duration = Number(options.durationSeconds) || 0;
  if (duration > autoLanguageMinSeconds(options)) return undefined;
  return languageHint(options);
}

/** The configured hint: WHISPER_LANGUAGE (an empty value means none), default es. */
function languageHint(options = {}) {
  const env = envOf(options);
  if (Object.prototype.hasOwnProperty.call(env, 'WHISPER_LANGUAGE')) {
    return normalizeLanguage(env.WHISPER_LANGUAGE);
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Lock a job's language from the languages detected on its pieces, in order.
 * Whisper detects ONCE, on the first 30 s of a piece, which in a class or
 * Zoom recording is often silence, room noise or music: a single detection
 * that disagrees with the hint is not trusted on its own. One that agrees
 * with the hint locks at once; one that disagrees needs a second detection
 * that agrees with it; two that disagree fall back to the hint.
 * Returns { language, candidate } (language undefined: not decided yet).
 */
function decideLanguage(detections, hint) {
  let candidate;
  for (const detected of detections) {
    if (!detected) continue;
    if (detected === hint || detected === candidate) return { language: detected, candidate };
    if (!candidate) candidate = detected;
    else return { language: hint || detected, candidate };
  }
  return { language: undefined, candidate };
}

// ── Prompt / vocabulary ─────────────────────────────────────────────────────

function oneLine(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKeyterms(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,;\n]/) : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const term = oneLine(item).slice(0, MAX_KEYTERM_CHARS);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

/**
 * Prompt sent to every rung: options.prompt (or WHISPER_PROMPT) followed by
 * the key terms as a plain comma list. Whisper reads the END of a prompt, so
 * the terms go last and the free text is the part that gets trimmed.
 */
function resolvePrompt(options = {}) {
  const env = envOf(options);
  let text = oneLine(typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt : env.WHISPER_PROMPT);
  const terms = normalizeKeyterms(options.keyterms);
  if (terms.length) {
    let list = `${terms.join(', ')}.`;
    if (list.length > MAX_PROMPT_CHARS) list = list.slice(list.length - MAX_PROMPT_CHARS).replace(/^[^,]*,\s*/, '');
    const room = MAX_PROMPT_CHARS - list.length - 1;
    text = [room > 0 ? text.slice(0, room).trim() : '', list].filter(Boolean).join(' ');
  }
  text = text.slice(0, MAX_PROMPT_CHARS).trim();
  return text || undefined;
}

// ── OpenAI-compatible model capabilities ────────────────────────────────────

/**
 * What an OpenAI-style transcription model accepts. whisper-1 / whisper-large
 * take verbose_json with segment timestamps (≤ 600 s segments); gpt-4o*
 * transcribe models only take json (≤ 300 s); the diarize model takes
 * diarized_json with chunking_strategy auto and no prompt.
 */
function transcriptionModelCaps(model) {
  const m = String(model || '').toLowerCase();
  if (/diariz/.test(m)) {
    return { responseFormat: 'diarized_json', timestamps: true, prompt: false, chunkingStrategy: 'auto', diarize: true, maxSegmentSeconds: 300 };
  }
  if (!m || /whisper/.test(m)) {
    return { responseFormat: 'verbose_json', timestamps: true, prompt: true, maxSegmentSeconds: DEFAULT_SEGMENT_SECONDS };
  }
  if (/^gpt-|transcribe/.test(m)) {
    return { responseFormat: 'json', timestamps: false, prompt: true, maxSegmentSeconds: 300 };
  }
  return { responseFormat: 'verbose_json', timestamps: true, prompt: true, maxSegmentSeconds: DEFAULT_SEGMENT_SECONDS };
}

const PLAIN_JSON_CAPS = Object.freeze({ responseFormat: 'json', timestamps: false, prompt: true, maxSegmentSeconds: DEFAULT_SEGMENT_SECONDS });

function hasOpenAiKey(options = {}) {
  if (options.openai) return true;
  return Boolean(String(envOf(options).OPENAI_API_KEY || '').trim());
}

// ── Provider errors ─────────────────────────────────────────────────────────

function statusOf(err) {
  return Number(err?.status || err?.statusCode || err?.response?.status || 0);
}

function messageOf(err) {
  return String(err?.message || err?.error?.message || '');
}

function isAbortError(err, signal) {
  if (signal?.aborted) return true;
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  return name === 'AbortError'
    || code === 'ABORT_ERR'
    || code === 'LOCAL_WHISPER_ABORTED'
    || /abort(ed)? by user|aborted|The operation was aborted/i.test(message);
}

function isInvalidKeyError(err) {
  const status = statusOf(err);
  const code = String(err?.code || err?.error?.code || '');
  const message = messageOf(err);
  return status === 401
    || status === 403
    || code === 'invalid_api_key'
    || /invalid_api_key|incorrect api key|invalid api key/i.test(message);
}

/**
 * No credits / unpaid plan: 402, insufficient_quota, or a 429 whose text talks
 * about quota or billing. A rate limit is NOT billing even when its text
 * links to a billing page (Groq: «Rate limit reached … try again in 2m3s …
 * Upgrade … /settings/billing»): that used to park Groq for 30 min for every
 * user mid-file.
 */
function isBillingError(err) {
  const status = statusOf(err);
  const code = String(err?.code || err?.error?.code || '').toLowerCase();
  const message = messageOf(err);
  if (status === 402 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return true;
  if (status !== 429) return false;
  if (RATE_LIMIT_TEXT_RE.test(message)) return false;
  return /credit|billing|quota|insufficient|balance|payment|no funds|plan/i.test(message);
}

/** A temporary throttle: wait and retry the same provider; never a cooldown. */
function isRateLimitError(err) {
  if (isBillingError(err)) return false;
  const status = statusOf(err);
  if (status === 429) return true;
  if (status) return false;
  return /rate.?limit|too many requests/i.test(messageOf(err));
}

function isTransientProviderError(err) {
  const status = statusOf(err);
  if (status === 408 || status === 409 || status === 425 || (status >= 500 && status <= 599)) return true;
  if (status) return false;
  const code = String(err?.code || '');
  if (/^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)$/.test(code)) return true;
  if (/APIConnection(?:Timeout)?Error|TimeoutError/.test(String(err?.name || ''))) return true;
  return /timed? ?out|timeout|socket hang up|fetch failed|network error|temporarily|service unavailable|overloaded/i.test(messageOf(err));
}

function readHeader(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name);
  } catch { /* fall through */ }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

/**
 * How long a rate-limited provider asked us to wait, in ms, or null.
 * Reads retry-after-ms, retry-after (seconds or HTTP date) and the
 * «try again in 2m3s / 1.2s / 450ms / 1h2m» text Groq and OpenAI send.
 */
function parseRetryAfterMs(err, now = Date.now()) {
  const headers = err?.headers || err?.response?.headers || null;
  const ms = Number(readHeader(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0 && readHeader(headers, 'retry-after-ms') != null) return Math.ceil(ms);
  const after = readHeader(headers, 'retry-after');
  if (after != null && String(after).trim()) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const at = Date.parse(String(after));
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const match = /try again in\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i.exec(messageOf(err));
  if (!match) return null;
  let total = 0;
  for (const part of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const value = Number(part[1]);
    const unit = part[2].toLowerCase();
    total += unit === 'h' ? value * 3_600_000 : unit === 'm' ? value * 60_000 : unit === 's' ? value * 1000 : value;
  }
  return Math.ceil(total);
}

function providerCooldownMs(options = {}) {
  const raw = Number.parseInt(envOf(options).TRANSCRIBE_PROVIDER_COOLDOWN_MS || '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_PROVIDER_COOLDOWN_MS;
}

/** Remember a dead key / empty balance so the next audio job skips the rung. */
function rememberProviderRejection(provider, err, options = {}) {
  if (!provider || !provider.key) return;
  keyHealth.markRejected(`${COOLDOWN_NAMESPACE}${provider.name}`, provider.key, err, {
    SIRAGPT_KEY_REJECT_MEMO_MS: String(providerCooldownMs(options)),
  });
}

function providerInCooldown(provider) {
  return Boolean(provider && provider.key && keyHealth.isRejected(`${COOLDOWN_NAMESPACE}${provider.name}`, provider.key));
}

function clearTranscriptionCooldowns() {
  for (const name of COOLDOWN_PROVIDERS) keyHealth.clear(`${COOLDOWN_NAMESPACE}${name}`);
}

/** Short ladder token for the summary log line: «openai(429 billing)». */
function describeProviderError(err) {
  const status = statusOf(err);
  if (isBillingError(err)) return `${status || 402} billing`;
  if (isInvalidKeyError(err)) return `${status || 401} key`;
  if (isRateLimitError(err)) return `${status || 429} rate`;
  if (status) return String(status);
  const code = String(err?.code || '').trim();
  if (code) return code;
  return String(err?.message || 'error').replace(/\s+/g, ' ').slice(0, 40);
}

function sanitizeProviderError(err) {
  const raw = String(err?.message || err || '');
  const redacted = redactString(raw);
  if (KEYISH_RE.test(raw) || KEYISH_RE.test(redacted) || isInvalidKeyError(err)) {
    return 'error de proveedor';
  }
  return redacted.slice(0, 180);
}

function generatePlaceholder(fileName, label, mimeType, reasonCode) {
  const publicReason = reasonCode === 'file_too_large'
    ? 'El archivo supera el tamaño máximo.'
    : reasonCode === 'no_speech'
      ? 'No se detectó voz.'
      : 'Transcripción no disponible.';
  return [
    `${label} — ${fileName}`,
    `Tipo: ${mimeType || 'desconocido'}`,
    `Estado: ${publicReason}`,
  ].join('\n');
}

function placeholderResult(fileName, label, mimeType, reasonCode) {
  return {
    ok: false,
    status: reasonCode === 'no_speech' ? 'no_speech' : 'failed',
    text: generatePlaceholder(fileName, label, mimeType, reasonCode),
    method: 'placeholder',
    reasonCode,
    // Same shape as a success (a segmented job overrides these with its numbers).
    language: null,
    segments: [],
    durationSec: null,
    segmentCount: 0,
    partial: false,
    gaps: [],
    coverage: 0,
    providers: {},
    engine: null,
  };
}

function formatSuccess({
  text, method, model, language, segments,
  durationSec = null, segmentCount = 1, partial = false, gaps = [], coverage = 1, providers = {}, engine = null,
}) {
  const transcript = String(text || '').trim();
  const lang = normalizeLanguage(language) || null;
  const header = `${method === 'local-whisper' ? 'Transcripción local' : 'Transcripción'}${partial ? ' parcial' : ''} — ${transcript.length} caracteres` +
    (model ? `, modelo: ${model}` : '') +
    (lang ? `, idioma: ${lang}` : '') +
    (partial ? `, tramos sin transcribir: ${gaps.length} de ${segmentCount}` : '') +
    '\n---\n';
  return {
    ok: true,
    status: 'ready',
    text: header + transcript,
    transcript,
    method,
    model: model || null,
    language: lang,
    segments: sortSegments(normalizeSegments(segments)),
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? round3(durationSec) : null,
    segmentCount,
    partial: Boolean(partial),
    gaps: Array.isArray(gaps) ? gaps : [],
    coverage,
    providers: providers || {},
    engine,
  };
}

function logSafe(message) {
  console.warn(`[audio-transcriber] ${redactString(String(message || ''))}`);
}

function logInfo(message) {
  try { console.log(`[audio-transcriber] ${redactString(String(message || ''))}`); } catch { /* logging is best-effort */ }
}

// ── Providers ───────────────────────────────────────────────────────────────

function providerOrder(options = {}) {
  const raw = options.providers || envOf(options).TRANSCRIBE_PROVIDERS;
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',') : DEFAULT_PROVIDER_ORDER);
  const cleaned = list.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  return cleaned.length ? cleaned : DEFAULT_PROVIDER_ORDER;
}

function metaApiKey(options = {}) {
  const env = envOf(options);
  return String(env.MODEL_API_KEY || env.META_API_KEY || env.LLAMA_API_KEY || '').trim();
}

function xaiApiKey(options = {}) {
  return String(envOf(options).XAI_API_KEY || '').trim();
}

function groqApiKey(options = {}) {
  return String(envOf(options).GROQ_API_KEY || '').trim();
}

/**
 * Meta's API has no speech-to-text endpoint (prod: 404 on every audio), so
 * the rung is opt-in: SIRAGPT_META_TRANSCRIPTION=1, or an operator listing
 * it explicitly in TRANSCRIBE_PROVIDERS / options.providers.
 */
function metaTranscriptionEnabled(options = {}) {
  const env = envOf(options);
  if (String(env.SIRAGPT_META_TRANSCRIPTION || '') === '1') return true;
  const explicit = options.providers || env.TRANSCRIBE_PROVIDERS;
  return Boolean(explicit) && providerOrder(options).includes('meta');
}

let metaSkipLogged = false;
function logMetaSkipOnce() {
  if (metaSkipLogged) return;
  metaSkipLogged = true;
  try {
    console.debug('[audio-transcriber] meta transcription skipped: no STT endpoint (set SIRAGPT_META_TRANSCRIPTION=1 to enable)');
  } catch { /* debug logging is best-effort */ }
}

/** Cloud providers in ladder order, only those with a usable key. */
function cloudProviders(options = {}) {
  const env = envOf(options);
  const out = [];
  for (const name of providerOrder(options)) {
    if (name === 'openai' && hasOpenAiKey(options)) {
      const model = options.model || env.WHISPER_MODEL || DEFAULT_OPENAI_MODEL;
      const caps = transcriptionModelCaps(model);
      out.push({
        name: 'openai',
        kind: 'cloud',
        method: 'whisper',
        model,
        caps,
        verbose: caps.responseFormat === 'verbose_json',
        key: String(env.OPENAI_API_KEY || '').trim() || 'injected',
        client: () => options.openai || (() => {
          const OpenAI = require('openai');
          return new OpenAI({ apiKey: env.OPENAI_API_KEY });
        })(),
      });
    } else if (name === 'groq' && (options.groqClient || groqApiKey(options)) && String(env.TRANSCRIBE_GROQ_DISABLED || '') !== '1') {
      // Groq speaks the OpenAI audio surface (verbose_json + segments).
      const model = env.GROQ_TRANSCRIBE_MODEL || DEFAULT_GROQ_TRANSCRIBE_MODEL;
      const caps = transcriptionModelCaps(model);
      out.push({
        name: 'groq',
        kind: 'cloud',
        method: 'whisper',
        model,
        caps,
        verbose: caps.responseFormat === 'verbose_json',
        key: groqApiKey(options) || 'injected',
        client: () => options.groqClient || (() => {
          const OpenAI = require('openai');
          return new OpenAI({ apiKey: groqApiKey(options), baseURL: env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL });
        })(),
      });
    } else if (name === 'xai' && xaiApiKey(options) && String(env.TRANSCRIBE_XAI_DISABLED || '') !== '1') {
      out.push({
        name: 'xai',
        kind: 'cloud',
        method: 'whisper',
        model: env.XAI_STT_MODEL || DEFAULT_XAI_STT_MODEL,
        caps: PLAIN_JSON_CAPS,
        verbose: false,
        key: xaiApiKey(options),
        // xAI STT is a multipart POST to /v1/stt, not the OpenAI SDK surface.
        transcribeFile: options.xaiTranscribe || ((filePath, mimeType, fileName, language, _prompt, extra = {}) => require('./xai-audio').transcribeXaiAudioFile({
          filePath,
          originalName: fileName,
          mimeType,
          model: env.XAI_STT_MODEL || undefined,
          language,
          detectLanguage: !language,
          timeoutMs: extra.timeoutMs,
          signal: extra.signal || options.signal,
          env,
        })),
      });
    } else if (name === 'meta' && metaApiKey(options) && String(env.TRANSCRIBE_META_DISABLED || '') !== '1') {
      if (!metaTranscriptionEnabled(options)) {
        logMetaSkipOnce();
        continue;
      }
      out.push({
        name: 'meta',
        kind: 'cloud',
        method: 'whisper',
        model: env.META_TRANSCRIBE_MODEL || DEFAULT_META_TRANSCRIBE_MODEL,
        caps: PLAIN_JSON_CAPS,
        verbose: false,
        key: metaApiKey(options),
        client: () => options.metaClient || (() => {
          const OpenAI = require('openai');
          return new OpenAI({ apiKey: metaApiKey(options), baseURL: env.META_BASE_URL || DEFAULT_META_BASE_URL });
        })(),
      });
    }
  }
  return out;
}

/** Opt-in VoiceStudio rung for segmented jobs (on-host WhisperX). */
function voiceStudioRung(options = {}) {
  if (!providerOrder(options).includes('voicestudio')) return null;
  const vsClient = voiceStudioClient(options);
  if (!vsClient || typeof vsClient.isConfigured !== 'function' || !vsClient.isConfigured(options)) return null;
  return {
    name: 'voicestudio',
    kind: 'local',
    method: 'local-whisper',
    model: 'voicestudio-whisperx',
    key: null,
    transcribeFile: (filePath, mimeType, fileName, language, prompt, extra = {}) => vsClient.transcribe({
      filePath, filename: fileName, mime: mimeType, language, prompt, signal: extra.signal || options.signal,
    }, options),
  };
}

const LOCAL_RUNG = Object.freeze({ name: 'local', kind: 'local', method: 'local-whisper', model: null, key: null });

function localEnabled(options = {}) {
  return providerOrder(options).includes('local');
}

function abortError() {
  return Object.assign(new Error('aborted by user'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function mediaChildEnv() {
  return buildUntrustedChildEnv({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG });
}

function isAudioMedia(mimeType, fileName) {
  const mime = normalizeAudioMime(mimeType, fileName);
  return /^(audio|video)\//.test(mime) || mime === 'application/ogg';
}

function segmentDuration(options = {}) {
  const n = Number(options.segmentSeconds || envOf(options).TRANSCRIBE_SEGMENT_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.max(30, Math.min(DEFAULT_SEGMENT_SECONDS, n)) : DEFAULT_SEGMENT_SECONDS;
}

/** Segment length every cloud rung accepts (gpt-4o transcribe models: 300 s). */
function effectiveSegmentSeconds(options = {}, providers = []) {
  let seconds = segmentDuration(options);
  for (const provider of providers || []) {
    const cap = Number(provider?.caps?.maxSegmentSeconds);
    if (Number.isFinite(cap) && cap >= 30) seconds = Math.min(seconds, cap);
  }
  return seconds;
}

function cloudParallel(options = {}) {
  const explicit = Number.parseInt(options.parallel, 10);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.min(8, explicit);
  return envNumber(options, 'TRANSCRIBE_CLOUD_PARALLEL', DEFAULT_CLOUD_PARALLEL, { min: 1, max: 8 });
}

function localParallel(options = {}) {
  return envNumber(options, 'TRANSCRIBE_LOCAL_PARALLEL', DEFAULT_LOCAL_PARALLEL, { min: 1, max: 4 });
}

function minCoverage(options = {}) {
  const explicit = Number(options.minCoverage);
  if (options.minCoverage != null && Number.isFinite(explicit)) return Math.min(1, Math.max(0, explicit));
  return envNumber(options, 'TRANSCRIBE_MIN_COVERAGE', DEFAULT_MIN_COVERAGE, { min: 0, max: 1, integer: false });
}

function ladderLimits(options = {}) {
  return {
    rateLimitMaxWaitMs: envNumber(options, 'TRANSCRIBE_RATE_LIMIT_MAX_WAIT_MS', DEFAULT_RATE_LIMIT_MAX_WAIT_MS, { min: 1000, max: 30 * 60 * 1000 }),
    rateLimitRetries: envNumber(options, 'TRANSCRIBE_RATE_LIMIT_RETRIES', DEFAULT_RATE_LIMIT_RETRIES, { min: 0, max: 20 }),
    segmentRetries: envNumber(options, 'TRANSCRIBE_SEGMENT_RETRIES', DEFAULT_SEGMENT_RETRIES, { min: 0, max: 5 }),
    localRetries: envNumber(options, 'TRANSCRIBE_LOCAL_RETRIES', DEFAULT_LOCAL_RETRIES, { min: 0, max: 3 }),
  };
}

/** Request timeout for one cloud segment (a 10-min FLAC upload + inference). */
function cloudSegmentTimeoutMs(rung, seconds, options = {}) {
  const env = envOf(options);
  if (typeof rung.transcribeFile === 'function') {
    const floor = Number(env.XAI_AUDIO_TIMEOUT_MS || env.GROK_VOICE_TIMEOUT_MS) || 45_000;
    return Math.max(floor, Math.ceil(60_000 + 200 * seconds));
  }
  const explicit = Number(env.TRANSCRIBE_CLOUD_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit >= 1000) return explicit;
  return Math.max(120_000, Math.ceil(400 * seconds));
}

// ── ffmpeg / ffprobe ────────────────────────────────────────────────────────

function execImpl(options = {}) {
  return typeof options.execFileImpl === 'function' ? options.execFileImpl : execFileAsync;
}

function ffmpegBin(options = {}) {
  return options.ffmpegPath || envOf(options).FFMPEG_PATH || 'ffmpeg';
}

function ffprobeBin(options = {}) {
  const ffmpeg = options.ffmpegPath || envOf(options).FFMPEG_PATH;
  return options.ffprobePath || (ffmpeg && path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), 'ffprobe') : 'ffprobe');
}

function firstPositiveNumber(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const n = Number(line.trim());
    if (line.trim() && Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Last position reported by `ffmpeg -progress pipe:1`, in seconds (0 if none). */
function parseProgressDuration(text) {
  const raw = String(text || '');
  const us = [...raw.matchAll(/out_time_us=(\d+)/g)].pop();
  if (us) return Number(us[1]) / 1e6;
  const ms = [...raw.matchAll(/out_time_ms=(\d+)/g)].pop(); // ffmpeg reports µs here too
  if (ms) return Number(ms[1]) / 1e6;
  const clock = [...raw.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return 0;
}

/**
 * Media duration in seconds, or 0 when unknown. Tries the container header,
 * then the audio stream header, then decodes the audio once and reads
 * ffmpeg's clock — browser recordings (MediaRecorder webm) carry no duration
 * header at all, and an unknown length used to send a 5-hour file to one
 * whisper process.
 */
async function probeAudioDuration(filePath, options = {}) {
  throwIfAborted(options.signal);
  if (Number.isFinite(options.durationSeconds) && options.durationSeconds >= 0) return options.durationSeconds;
  if (typeof options.probeAudioDuration === 'function') return options.probeAudioDuration(filePath, options);
  const run = execImpl(options);
  const probe = ffprobeBin(options);
  const headerProbes = [
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
  ];
  for (const args of headerProbes) {
    try {
      const { stdout } = await run(probe, args, {
        timeout: 15_000, maxBuffer: 64 * 1024, signal: options.signal, env: mediaChildEnv(),
      });
      const duration = firstPositiveNumber(stdout);
      if (duration > 0) return duration;
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      // A missing probe must not turn an otherwise supported short clip into
      // a failure. The decode pass and the provider/local decoder remain.
    }
  }
  try {
    const { stdout } = await run(ffmpegBin(options), [
      '-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-vn', '-sn', '-dn',
      '-f', 'null', '-progress', 'pipe:1', '-nostats', '-',
    ], { timeout: segmentationTimeoutMs({ ...options, durationSeconds: 0 }), maxBuffer: 16 * 1024 * 1024, signal: options.signal, env: mediaChildEnv() });
    const duration = parseProgressDuration(stdout);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    return 0;
  }
}

// Cutting a 10-hour recording decodes every second of audio once; give the
// pass a budget that scales with the duration (6 min per audio hour, never
// under 10 min) instead of a flat ceiling that long lectures would hit.
function segmentationTimeoutMs(options = {}) {
  const explicit = Number(options.segmentTimeoutMs || envOf(options).TRANSCRIBE_SEGMENT_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const seconds = Number(options.durationSeconds) || 0;
  return Math.max(10 * 60 * 1000, Math.ceil(seconds * 100));
}

/**
 * Durable per-segment results. `options.checkpoint` ({ load, save, dir? })
 * lets the caller persist each finished segment so a restart (deploy, crash,
 * retry) resumes a 10-hour transcription where it stopped instead of from
 * zero. Failures to read or write a checkpoint never fail the transcription.
 */
async function loadSegmentCheckpoint(options, index, meta) {
  if (!options.checkpoint || typeof options.checkpoint.load !== 'function') return null;
  try {
    const saved = await options.checkpoint.load(index, meta);
    return saved && typeof saved === 'object' ? saved : null;
  } catch { return null; }
}

async function saveSegmentCheckpoint(options, index, meta, part) {
  if (!options.checkpoint || typeof options.checkpoint.save !== 'function') return;
  try {
    await options.checkpoint.save(index, meta, {
      text: String(part?.text || part?.transcript || ''),
      segments: normalizeSegments(part?.segments),
      model: part?.model || null,
      language: normalizeLanguage(part?.language) || null,
      provider: part?.provider || null,
      method: part?.method || null,
      cutPlan: part?.cutPlan || meta?.cutPlan || null,
    });
  } catch { /* a missing checkpoint only costs a re-run of this segment */ }
}

function progressEvent(options, stage, extra = {}) {
  emitProgress(options, { stage, durationSeconds: Number(options.durationSeconds) || 0, ...extra });
}

function runFfmpeg(args, options = {}) {
  const spawnImpl = options.spawnImpl || require('child_process').spawn;
  const bin = ffmpegBin(options);
  const limitMs = segmentationTimeoutMs(options);
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError());
    let child;
    let timer;
    let settled = false;
    let stderr = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve();
    };
    const onAbort = () => {
      try { child?.kill('SIGKILL'); } catch (_) { /* already exited */ }
      finish(abortError());
    };
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: mediaChildEnv() });
    } catch (err) {
      finish(err);
      return;
    }
    child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`), { code: 'SEGMENT_FAILED' })));
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
      finish(Object.assign(new Error('ffmpeg segmentation timed out'), { code: 'SEGMENT_TIMEOUT' }));
    }, limitMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

// ── Cut plan ────────────────────────────────────────────────────────────────

function silenceSnapEnabled(options = {}) {
  if (options.silenceSnap === false) return false;
  return !/^(?:0|false|off|no)$/i.test(String(envOf(options).TRANSCRIBE_SILENCE_SNAP || '').trim());
}

/** [{ start, end }] from ffmpeg silencedetect output. */
function parseSilences(text) {
  const out = [];
  let start = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const begin = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (begin) { start = Math.max(0, Number(begin[1])); continue; }
    const finish = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (finish && start != null) {
      const end = Number(finish[1]);
      if (end > start) out.push({ start, end });
      start = null;
    }
  }
  return out;
}

/** One decode pass listing pauses; [] on any failure (cuts fall back to fixed times). */
async function detectSilences(filePath, options = {}) {
  if (typeof options.detectSilences === 'function') return options.detectSilences(filePath, options);
  try {
    const { stderr } = await execImpl(options)(ffmpegBin(options), [
      '-hide_banner', '-nostats', '-nostdin', '-i', filePath, '-vn', '-sn', '-dn', '-ac', '1',
      '-af', SILENCE_FILTER, '-f', 'null', '-',
    ], { timeout: segmentationTimeoutMs(options), maxBuffer: 32 * 1024 * 1024, signal: options.signal, env: mediaChildEnv() });
    return parseSilences(stderr);
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    return [];
  }
}

/**
 * Cut points for a recording of known length. Each cut lands on the latest
 * silence midpoint inside [target − window, target] (target = previous cut +
 * segment length), else on the target itself, so no segment exceeds the
 * segment length a provider accepts and few words are split. A final piece
 * shorter than MIN_TAIL_SECONDS is folded into the previous segment.
 */
function planCutTimes(durationSeconds, segmentSeconds, silences = [], { windowSeconds, minTailSeconds = MIN_TAIL_SECONDS } = {}) {
  const duration = Number(durationSeconds) || 0;
  const S = Number(segmentSeconds) || DEFAULT_SEGMENT_SECONDS;
  if (!(duration > S)) return [];
  const window = Number.isFinite(windowSeconds) ? Math.max(0, Math.min(windowSeconds, S * 0.5)) : Math.min(MAX_SNAP_WINDOW_SECONDS, S * 0.15);
  const mids = (Array.isArray(silences) ? silences : [])
    .map((s) => (Number(s.start) + Number(s.end)) / 2)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const cuts = [];
  let prev = 0;
  while (prev + S < duration) {
    const target = prev + S;
    let cut = target;
    for (const mid of mids) {
      if (mid > target) break;
      if (mid >= target - window && mid > prev) cut = mid;
    }
    cuts.push(round3(cut));
    prev = cut;
  }
  if (cuts.length && duration - cuts[cuts.length - 1] < minTailSeconds) cuts.pop();
  return cuts;
}

/**
 * Fold a final piece shorter than `minTailSeconds` into the previous one.
 * Pure: returns the new list and which files to concatenate (or null).
 */
function mergeShortTail(segments, minTailSeconds = MIN_TAIL_SECONDS) {
  const list = Array.isArray(segments) ? segments.slice() : [];
  if (list.length < 2) return { segments: list, merge: null };
  const tail = list[list.length - 1];
  const previous = list[list.length - 2];
  const tailSeconds = typeof tail?.durationSeconds === 'number' ? tail.durationSeconds : NaN;
  if (!(tailSeconds > 0 && tailSeconds < minTailSeconds)) return { segments: list, merge: null };
  const prevSeconds = Number(previous?.durationSeconds);
  const merged = { ...previous, durationSeconds: Number.isFinite(prevSeconds) ? round3(prevSeconds + tailSeconds) : previous.durationSeconds };
  return { segments: [...list.slice(0, -2), merged], merge: { into: previous, from: tail } };
}

async function probeFileDuration(filePath, options = {}) {
  try {
    const { stdout } = await execImpl(options)(ffprobeBin(options), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { timeout: 15_000, maxBuffer: 64 * 1024, signal: options.signal, env: mediaChildEnv() });
    const n = firstPositiveNumber(stdout);
    return n > 0 ? round3(n) : null;
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    return null;
  }
}

/**
 * ffmpeg's segment muxer cannot seek back into a finished FLAC piece, so its
 * STREAMINFO says «unknown length» (or the WHOLE file's length on the last
 * piece). A lossless re-encode writes a correct header — and an exact length.
 */
async function finalizeFlacSegment(segmentPath, options = {}) {
  const tmp = `${segmentPath}.fix.flac`;
  try {
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', segmentPath, '-map', '0:a:0', '-c:a', 'flac', tmp], options);
    await fsPromises.rename(tmp, segmentPath);
  } catch (err) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    if (isAbortError(err, options.signal)) throw err;
    // Keep the raw piece: decoders read it fine, only its header is vague.
  }
}

async function concatSegmentsInto(intoPath, fromPath, options = {}) {
  if (typeof options.concatAudio === 'function') return options.concatAudio(intoPath, fromPath, options);
  const tmp = `${intoPath}.merged.flac`;
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', intoPath, '-i', fromPath,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-c:a', 'flac', tmp,
    ], options);
    await fsPromises.rename(tmp, intoPath);
    await fsPromises.rm(fromPath, { force: true }).catch(() => {});
  } catch (err) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function assignOffsets(segments, cutTimes, segmentSeconds) {
  const allKnown = segments.length > 0 && segments.every((s) => Number.isFinite(s.durationSeconds) && s.durationSeconds > 0);
  let acc = 0;
  segments.forEach((segment, i) => {
    if (allKnown) {
      segment.offsetSeconds = round3(acc);
      acc += segment.durationSeconds;
    } else if (Array.isArray(cutTimes) && cutTimes.length === segments.length - 1) {
      segment.offsetSeconds = i === 0 ? 0 : cutTimes[i - 1];
    } else {
      segment.offsetSeconds = i * segmentSeconds;
    }
  });
  return segments;
}

/**
 * Cut `filePath` into FLAC 16 kHz mono pieces inside `dir` and measure them.
 * Returns [{ path, index, offsetSeconds, durationSeconds }].
 */
async function cutAndMeasure(filePath, dir, ctx = {}, options = {}) {
  const S = ctx.segmentSeconds || segmentDuration(options);
  const duration = Number(ctx.durationSeconds) > 0 ? Number(ctx.durationSeconds) : 0;
  const scoped = { ...options, durationSeconds: duration };
  let cutTimes = null;
  if (duration > S) {
    const silences = silenceSnapEnabled(options) && duration > S * 1.2 ? await detectSilences(filePath, scoped) : [];
    cutTimes = planCutTimes(duration, S, silences);
  }
  const pattern = path.join(dir, 'seg-%04d.flac');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', filePath,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', SEGMENT_SAMPLE_RATE, '-c:a', 'flac',
    '-f', 'segment',
    ...(cutTimes && cutTimes.length ? ['-segment_times', cutTimes.join(',')] : ['-segment_time', String(S)]),
    '-reset_timestamps', '1',
    pattern,
  ], scoped);
  const names = (await fsPromises.readdir(dir)).filter((n) => /^seg-\d+\.flac$/.test(n)).sort();
  if (!names.length) throw Object.assign(new Error('ffmpeg produced no segments'), { code: 'SEGMENT_EMPTY' });
  let segments = names.map((name, index) => ({ path: path.join(dir, name), index, offsetSeconds: 0, durationSeconds: null }));
  for (const segment of segments) {
    throwIfAborted(options.signal);
    await finalizeFlacSegment(segment.path, scoped);
    segment.durationSeconds = await probeFileDuration(segment.path, scoped);
  }
  const tail = mergeShortTail(segments);
  if (tail.merge) {
    try {
      await concatSegmentsInto(tail.merge.into.path, tail.merge.from.path, scoped);
      segments = tail.segments;
      const last = segments[segments.length - 1];
      last.durationSeconds = (await probeFileDuration(last.path, scoped)) || last.durationSeconds;
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      // Keep the tiny tail as its own segment rather than lose audio.
    }
  }
  return assignOffsets(segments, cutTimes, S);
}

/**
 * Cut a long recording into cloud-sized pieces in a temp dir. Returns
 * { dir, segments: [{ path, index, offsetSeconds, durationSeconds }] }.
 * Injectable through options.segmentAudio for tests.
 */
async function segmentForCloud(filePath, options = {}) {
  if (typeof options.segmentAudio === 'function') return options.segmentAudio(filePath, options);
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-seg-'));
  try {
    const segments = await cutAndMeasure(filePath, dir, { segmentSeconds: segmentDuration(options), durationSeconds: options.durationSeconds }, options);
    return { dir, segments };
  } catch (err) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Identity of a cut: offsets + segment length. Parts are reused only within one plan. */
function planOf(segments, segmentSeconds) {
  const offsets = segments.map((s) => Math.round((Number(s.offsetSeconds) || 0) * 1000));
  const fixed = segments.every((s, i) => Math.abs((Number(s.offsetSeconds) || 0) - i * segmentSeconds) <= 0.5);
  const hash = crypto.createHash('sha1').update(JSON.stringify({ v: MANIFEST_VERSION, s: segmentSeconds, o: offsets })).digest('hex').slice(0, 16);
  return { kind: fixed ? 'fixed' : 'snapped', hash };
}

function checkpointDirOf(options = {}) {
  const dir = options.checkpoint && options.checkpoint.dir;
  return typeof dir === 'string' && dir.trim() ? path.resolve(dir) : null;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function loadManifest(manifestPath, { segmentSeconds, sourceSize }) {
  let manifest;
  try {
    manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.format !== 'flac') return null;
  if (manifest.segmentSeconds !== segmentSeconds || manifest.sourceSize !== sourceSize) return null;
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const offsets = Array.isArray(manifest.offsets) ? manifest.offsets : [];
  if (!files.length || files.length !== offsets.length || manifest.total !== files.length) return null;
  const dir = path.dirname(manifestPath);
  const segments = [];
  for (let i = 0; i < files.length; i++) {
    const name = String(files[i] || '');
    if (!/^seg-\d+\.flac$/.test(name)) return null;
    const full = path.join(dir, name);
    const stat = await fsPromises.stat(full).catch(() => null);
    if (!stat || !stat.size) return null;
    const durationSeconds = Number(manifest.durations?.[i]);
    segments.push({ path: full, index: i, offsetSeconds: Number(offsets[i]) || 0, durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null });
  }
  const plan = planOf(segments, segmentSeconds);
  if (manifest.plan?.hash && manifest.plan.hash !== plan.hash) return null;
  return { manifest, segments, plan };
}

async function writeManifest(manifestPath, manifest) {
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(manifest));
  await fsPromises.rename(tmp, manifestPath);
}

/**
 * Cut the job's audio ONCE. With a checkpoint dir the pieces live in
 * `<dir>/audio` with a manifest, so a restart or deploy reuses them instead
 * of re-decoding a 5-hour file; without one they go to a temp dir.
 * Returns { dir, persistent, segments, plan, manifest, manifestPath }.
 */
async function prepareSegments(filePath, options = {}, ctx = {}) {
  const S = ctx.segmentSeconds || segmentDuration(options);
  const checkpointDir = checkpointDirOf(options);
  if (typeof options.segmentAudio === 'function') {
    const out = await options.segmentAudio(filePath, options);
    const segments = (Array.isArray(out?.segments) ? out.segments : []).map((s, i) => ({
      path: s.path,
      index: Number.isInteger(s.index) ? s.index : i,
      offsetSeconds: Number(s.offsetSeconds) || 0,
      durationSeconds: Number.isFinite(Number(s.durationSeconds)) && Number(s.durationSeconds) > 0 ? Number(s.durationSeconds) : null,
    }));
    if (!segments.length) throw Object.assign(new Error('no segments'), { code: 'SEGMENT_EMPTY' });
    const dir = out?.dir || null;
    return { dir, persistent: Boolean(dir && checkpointDir && isInside(dir, checkpointDir)), segments, plan: planOf(segments, S), manifest: null, manifestPath: null };
  }
  if (checkpointDir) {
    const dir = path.join(checkpointDir, 'audio');
    const manifestPath = path.join(dir, 'manifest.json');
    const reused = await loadManifest(manifestPath, { segmentSeconds: S, sourceSize: ctx.fileSize });
    if (reused) return { dir, persistent: true, segments: reused.segments, plan: reused.plan, manifest: reused.manifest, manifestPath, reused: true };
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.mkdir(dir, { recursive: true });
    try {
      const segments = await cutAndMeasure(filePath, dir, { segmentSeconds: S, durationSeconds: ctx.durationSeconds }, options);
      const plan = planOf(segments, S);
      const stat = await fsPromises.stat(filePath).catch(() => null);
      const manifest = {
        version: MANIFEST_VERSION,
        format: 'flac',
        segmentSeconds: S,
        // The source is often re-downloaded to a fresh temp path on every
        // attempt, so its mtime changes; the size (and the checkpoint dir,
        // keyed by file id + size) identifies it.
        sourceSize: ctx.fileSize,
        sourceMtimeMs: stat ? Math.round(stat.mtimeMs) : null,
        durationSeconds: Number(ctx.durationSeconds) > 0 ? Number(ctx.durationSeconds) : null,
        total: segments.length,
        files: segments.map((s) => path.basename(s.path)),
        offsets: segments.map((s) => s.offsetSeconds),
        durations: segments.map((s) => s.durationSeconds),
        plan,
        language: null,
        createdAt: new Date().toISOString(),
      };
      await writeManifest(manifestPath, manifest);
      return { dir, persistent: true, segments, plan, manifest, manifestPath };
    } catch (err) {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-seg-'));
  try {
    const segments = await cutAndMeasure(filePath, dir, { segmentSeconds: S, durationSeconds: ctx.durationSeconds }, options);
    return { dir, persistent: false, segments, plan: planOf(segments, S), manifest: null, manifestPath: null };
  } catch (err) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function rememberManifestLanguage(prepared, language) {
  if (!prepared?.manifestPath || !prepared.manifest) return;
  try {
    prepared.manifest = { ...prepared.manifest, language };
    await writeManifest(prepared.manifestPath, prepared.manifest);
  } catch { /* the language is re-detected after a restart */ }
}

// ── Cloud requests ──────────────────────────────────────────────────────────

/**
 * One request to a cloud rung. `call` (segmented jobs) carries the job
 * signal, a per-request timeout, SDK retries (0: the ladder retries) and the
 * ordered-dispatch lock that keeps request start order = segment order.
 */
async function transcribeCloudFile(provider, filePath, mimeType, fileName, options, language, prompt, call = {}) {
  const signal = call.signal || options.signal;
  if (typeof provider.transcribeFile === 'function') {
    const start = () => ({ p: provider.transcribeFile(filePath, mimeType, fileName, language, prompt, { signal, timeoutMs: call.timeoutMs, durationSeconds: call.durationSeconds }) });
    const handle = call.dispatch ? await call.dispatch(start) : start();
    const out = await handle.p;
    return {
      text: String(out?.text || ''),
      segments: Array.isArray(out?.segments) ? out.segments : [],
      model: out?.model || provider.model,
      language: normalizeLanguage(language) || normalizeLanguage(out?.language) || null,
    };
  }
  const client = provider.client();
  const caps = provider.caps || (provider.verbose ? transcriptionModelCaps('whisper-1') : PLAIN_JSON_CAPS);
  const startRequest = async () => {
    const fileBuffer = await fsPromises.readFile(filePath);
    const blob = typeof options.createFile === 'function'
      ? options.createFile(fileBuffer, fileName, mimeType || 'audio/mpeg')
      : new File([fileBuffer], fileName, { type: mimeType || 'audio/mpeg' });
    const request = { model: provider.model, file: blob, response_format: caps.responseFormat };
    if (caps.responseFormat === 'verbose_json') request.timestamp_granularities = ['segment'];
    if (caps.chunkingStrategy) request.chunking_strategy = caps.chunkingStrategy;
    if (language) request.language = language;
    if (prompt && caps.prompt !== false) request.prompt = prompt;
    const requestOptions = {
      timeout: call.timeoutMs || 120_000,
      maxRetries: Number.isInteger(call.maxRetries) ? call.maxRetries : 2,
      ...(signal ? { signal } : {}),
    };
    return { p: client.audio.transcriptions.create(request, requestOptions) };
  };
  const handle = call.dispatch ? await call.dispatch(startRequest) : await startRequest();
  const transcription = await handle.p;
  const text = typeof transcription === 'string' ? transcription : (transcription?.text || '');
  const rawSegments = transcription && Array.isArray(transcription.segments) ? transcription.segments : [];
  return {
    text,
    segments: rawSegments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
      ...(s.speaker != null ? { speaker: s.speaker } : {}),
      ...(s.avg_logprob != null ? { avg_logprob: s.avg_logprob } : {}),
    })),
    model: provider.model,
    language: normalizeLanguage(language) || normalizeLanguage(transcription && transcription.language) || null,
  };
}

/**
 * Whole file when it fits the provider cap; otherwise a segmented job on this
 * one rung (kept for callers that drive a single provider). Throws when a
 * segment could not be transcribed.
 */
async function transcribeCloud(provider, filePath, mimeType, fileName, fileSize, maxBytes, options, language, prompt) {
  const seconds = effectiveSegmentSeconds(options, [provider]);
  if (fileSize <= maxBytes && !(options.durationSeconds > seconds)) {
    return transcribeCloudFile(provider, filePath, mimeType, fileName, options, language, prompt);
  }
  const assembled = await runSegmentedJob(filePath, {
    options,
    fileName,
    rungs: [{ kind: 'cloud', ...provider }],
    language: normalizeLanguage(language),
    languageSource: language ? 'explicit' : 'auto',
    prompt,
    durationSeconds: Number(options.durationSeconds) || 0,
    fileSize,
    segmentSeconds: seconds,
    tried: [],
  });
  if (assembled.gaps.length) {
    throw assembled.lastError || Object.assign(new Error('segment transcription failed'), { code: 'SEGMENT_TRANSCRIBE_FAILED' });
  }
  return { text: assembled.transcript, segments: assembled.segments, model: assembled.model, language: assembled.language, segmentCount: assembled.segmentCount };
}

// ── Segmented job: once-per-job cut, per-segment ladder, bounded pool ───────

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return {
    async acquire(signal) {
      throwIfAborted(signal);
      if (active < limit) { active++; return; }
      await new Promise((resolve, reject) => {
        const waiter = { resolve: () => { signal?.removeEventListener?.('abort', onAbort); resolve(); } };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(abortError());
        };
        waiters.push(waiter);
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
    release() {
      const next = waiters.shift();
      if (next) next.resolve(); else active = Math.max(0, active - 1);
    },
  };
}

/** Serializes request STARTS (not their completion): start order = segment order. */
function createDispatchLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * transcribeLocal reports LOCAL_WHISPER_UNAVAILABLE whenever whisper.cpp AND
 * the Python fallback failed (production has no faster-whisper, so that
 * fallback always fails). Only a missing engine (ffmpeg, binary, model,
 * spawn) is unavailable for the whole job; a whisper.cpp run that started and
 * failed on THIS segment (timeout, crash, invalid or empty output) is a
 * per-segment failure, carried in `err.cppError`. A spawn failure counts as
 * missing only when the OS says the program cannot run (no cause: binary or
 * model missing); EAGAIN, EMFILE, ENFILE or ENOMEM is load, not a missing
 * engine, and fails only that segment.
 */
const PERMANENT_SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']);

function localEngineMissing(err) {
  if (err?.code !== 'LOCAL_WHISPER_UNAVAILABLE') return false;
  const cpp = err.cppError;
  if (!cpp) return true;
  if (cpp.code !== 'LOCAL_WHISPER_UNAVAILABLE' && cpp.code !== 'LOCAL_WHISPER_SPAWN') return false;
  const cause = cpp.cause?.code;
  return !cause || PERMANENT_SPAWN_ERRORS.has(cause);
}

/** The whisper.cpp failure behind a local error, when whisper.cpp actually ran. */
function localRunError(err) {
  return err?.code === 'LOCAL_WHISPER_UNAVAILABLE' && !localEngineMissing(err) ? err.cppError : err;
}

/** 'dead' (drop the rung for this job), 'rate_limit', 'transient' or 'segment'. */
function classifyRungError(rung, err) {
  if (rung.name === 'local') {
    if (localEngineMissing(err)) return 'dead';
    if (err?.code === 'AUDIO_DECODE_FAILED') return 'segment';
    // Timeout, crash, invalid/empty output: retried (TRANSCRIBE_LOCAL_RETRIES),
    // then only this segment is demoted and the 3-in-a-row streak guard applies.
    return 'transient';
  }
  if (isInvalidKeyError(err) || isBillingError(err)) return 'dead';
  if (isRateLimitError(err)) return 'rate_limit';
  if (rung.kind === 'local') return 'transient';
  if (isTransientProviderError(err)) return 'transient';
  return 'segment';
}

function describeRungError(rung, err) {
  if (rung.name === 'local') return String(err?.reason || err?.code || err?.message || 'failed').replace(/\s+/g, ' ').slice(0, 120);
  return describeProviderError(err);
}

function gapReasonFor(error) {
  if (!error) return 'no_provider';
  const err = localRunError(error) || error;
  if (err.code === 'AUDIO_DECODE_FAILED') return 'audio_decode_failed';
  if (err.code === 'LOCAL_WHISPER_UNAVAILABLE') return 'local_unavailable';
  if (isRateLimitError(err)) return 'rate_limited';
  if (isInvalidKeyError(err) || isBillingError(err)) return 'provider_unavailable';
  if (err.code === 'LOCAL_WHISPER_TIMEOUT' || /timed? ?out|timeout/i.test(String(err.message || ''))) return 'timeout';
  return 'provider_error';
}

function noteOutcome(jc, rung, token) {
  if (!jc.outcomes.has(rung.name)) jc.outcomes.set(rung.name, new Map());
  const tokens = jc.outcomes.get(rung.name);
  tokens.set(token, (tokens.get(token) || 0) + 1);
}

function logOncePerJob(jc, key, message) {
  if (jc.logged.has(key)) return;
  jc.logged.add(key);
  logSafe(message);
}

function partFromOutput(out, rung, language) {
  return {
    text: String(out?.text || out?.transcript || ''),
    segments: Array.isArray(out?.segments) ? out.segments : [],
    model: out?.model || rung.model || null,
    language: normalizeLanguage(language) || normalizeLanguage(out?.language) || null,
  };
}

async function callRung(rung, segment, jc, language) {
  const { options, signal } = jc;
  const seconds = Number(segment.durationSeconds) || jc.segmentSeconds;
  if (rung.kind === 'local') {
    await jc.localPermits.acquire(signal);
    try {
      throwIfAborted(signal);
      if (rung.name === 'local') {
        const impl = options.localTranscribe || localWhisper.transcribeLocal;
        const out = await impl(segment.path, {
          ...options,
          signal,
          language,
          prompt: jc.prompt,
          durationSeconds: jc.mediaDurationSeconds,
          mediaDurationSeconds: jc.mediaDurationSeconds,
          segmentDurationSeconds: segment.durationSeconds || null,
        });
        return partFromOutput(out, rung, language);
      }
      const out = await rung.transcribeFile(segment.path, segment.mime, segment.name, language, jc.prompt, { signal, durationSeconds: seconds });
      return partFromOutput(out, rung, language);
    } finally {
      jc.localPermits.release();
    }
  }
  let out;
  try {
    out = await transcribeCloudFile(rung, segment.path, segment.mime, segment.name, options, language, jc.prompt, {
      signal,
      timeoutMs: cloudSegmentTimeoutMs(rung, seconds, options),
      maxRetries: 0,
      dispatch: jc.dispatch,
      durationSeconds: seconds,
    });
  } catch (err) {
    // xAI answers 200 with no text for a silent piece (waiting room, break)
    // and its client throws. That is a no-speech result, as on every other
    // rung, not a failure that demotes the segment and counts toward the streak.
    if (err?.code !== 'xai_stt_empty_transcript') throw err;
    out = { text: '', segments: [], model: rung.model };
  }
  return partFromOutput(out, rung, language);
}

/**
 * One segment, every rung in order until one succeeds. Returns
 * { part } or { part: null, reason, error } (a gap).
 */
async function transcribeSegmentWithLadder(segment, jc, language) {
  let lastError = null;
  for (const rung of jc.rungs) {
    const state = jc.state.get(rung.name);
    if (state.dead) continue;
    if (rung.kind === 'cloud' && providerInCooldown(rung)) {
      state.dead = 'cooldown';
      noteOutcome(jc, rung, 'cooldown');
      continue;
    }
    let transientRetries = 0;
    let rateLimitWaits = 0;
    for (;;) {
      throwIfAborted(jc.signal);
      const pause = state.pausedUntil - jc.now();
      if (pause > 0) await jc.sleep(pause, jc.signal);
      try {
        const part = await callRung(rung, segment, jc, language);
        state.consecutiveFailures = 0;
        return { part: { ...part, provider: rung.name, method: rung.method, kind: rung.kind } };
      } catch (err) {
        // Only the job's own signal cancels the job: a dropped socket reports
        // «Error: aborted» (ECONNRESET) and must stay a transient failure.
        if (jc.signal.aborted) throw err;
        lastError = err;
        const verdict = classifyRungError(rung, err);
        const token = describeRungError(rung, err);
        if (verdict === 'dead') {
          state.dead = token;
          noteOutcome(jc, rung, token);
          if (rung.kind === 'cloud') {
            rememberProviderRejection(rung, err, jc.options);
            const what = isBillingError(err) ? 'has no credits' : 'rejected the key';
            logOncePerJob(jc, `dead:${rung.name}`, `${rung.name} transcription ${what} (${sanitizeProviderError(err)}); skipping it for ${Math.round(providerCooldownMs(jc.options) / 60000)} min; trying the next provider`);
          } else {
            logOncePerJob(jc, `dead:${rung.name}`, `${rung.name} transcription unavailable (${token}); the rest of this job skips it`);
          }
          break;
        }
        if (verdict === 'rate_limit') {
          const hinted = parseRetryAfterMs(err, jc.now());
          if (hinted != null && hinted > jc.limits.rateLimitMaxWaitMs) {
            // «try again in 5h»: a quota for the day, not a throttle. Stop
            // using the rung in this job, never start the «no credits» cooldown.
            state.dead = `${token} ${Math.round(hinted / 60000)}min`;
            noteOutcome(jc, rung, token);
            logOncePerJob(jc, `rate-dead:${rung.name}`, `${rung.name} transcription rate-limited for ${Math.round(hinted / 60000)} min; the rest of this job uses the next provider`);
            break;
          }
          if (rateLimitWaits < jc.limits.rateLimitRetries) {
            rateLimitWaits++;
            const wait = Math.min(jc.limits.rateLimitMaxWaitMs, hinted != null ? hinted : RATE_LIMIT_BASE_WAIT_MS * 2 ** (rateLimitWaits - 1));
            state.pausedUntil = Math.max(state.pausedUntil, jc.now() + wait);
            noteOutcome(jc, rung, token);
            logOncePerJob(jc, `rate:${rung.name}`, `${rung.name} transcription rate-limited; waiting ${Math.round(wait / 1000)} s and retrying the same provider`);
            continue;
          }
        } else if (verdict === 'transient') {
          const allowed = rung.kind === 'cloud' ? jc.limits.segmentRetries : jc.limits.localRetries;
          if (transientRetries < allowed) {
            transientRetries++;
            await jc.sleep(TRANSIENT_BACKOFF_BASE_MS * 3 ** (transientRetries - 1), jc.signal);
            continue;
          }
        }
        // Demote THIS segment to the next rung; the rung stays for the others.
        noteOutcome(jc, rung, token);
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= RUNG_MAX_CONSECUTIVE_FAILURES) {
          state.dead = `${token}×${state.consecutiveFailures}`;
          logOncePerJob(jc, `streak:${rung.name}`, `${rung.name} transcription failed on ${state.consecutiveFailures} segments in a row (${sanitizeProviderError(err)}); the rest of this job skips it`);
        }
        break;
      }
    }
  }
  return { part: null, reason: gapReasonFor(lastError), error: lastError };
}

function inferProvider(part) {
  if (part?.provider) return part.provider;
  if (part?.method === 'local-whisper') return 'local';
  const model = String(part?.model || '').toLowerCase();
  if (/ggml|^base$|^small$|^tiny$|faster|whisper\.cpp/.test(model)) return 'local';
  if (/whisperx|voicestudio/.test(model)) return 'voicestudio';
  if (/grok/.test(model)) return 'xai';
  if (/muse|llama/.test(model)) return 'meta';
  if (/large-v3/.test(model)) return 'groq';
  if (/whisper-1|gpt-/.test(model)) return 'openai';
  return 'unknown';
}

function kindOfProvider(name) {
  return name === 'local' || name === 'voicestudio' ? 'local' : 'cloud';
}

/** A checkpointed part is reused only within the same cut plan and language. */
function partUsable(part, plan, language) {
  if (!part || typeof part !== 'object') return false;
  if (part.cutPlan) {
    if (part.cutPlan !== plan.hash) return false;
  } else if (plan.kind !== 'fixed') {
    return false; // a legacy part cut on fixed 10-min boundaries cannot fill a snapped plan
  }
  const partLanguage = normalizeLanguage(part.language);
  if (language && partLanguage && partLanguage !== language) return false;
  return true;
}

function segmentSpans(segments, mediaDuration, segmentSeconds) {
  return segments.map((segment, i) => {
    const start = Number(segment.offsetSeconds) || 0;
    const next = segments[i + 1];
    let end;
    if (next) end = Number(next.offsetSeconds) || start;
    else if (Number.isFinite(segment.durationSeconds) && segment.durationSeconds > 0) end = start + segment.durationSeconds;
    else if (mediaDuration > start) end = mediaDuration;
    else end = start + segmentSeconds;
    return { start: round3(start), end: round3(Math.max(start, end)) };
  });
}

function segmentLabel(segment) {
  const ext = path.extname(String(segment.path || '')).toLowerCase() || '.mp3';
  return { name: `segment-${(Number(segment.index) || 0) + 1}${ext}`, mime: SEGMENT_MIME_BY_EXT[ext] || 'audio/mpeg' };
}

function formatOutcomes(outcomes) {
  const tokens = [];
  for (const [name, map] of outcomes) {
    const parts = [...map].map(([token, count]) => (count > 1 ? `${token}×${count}` : token));
    tokens.push(`${name}(${parts.join(' ')})`);
  }
  return tokens.join(' ');
}

/**
 * Run a segmented job and return the stitched (unformatted) outcome:
 * { transcript, coveredText, segments, gaps, coverage, providers, engine,
 *   method, model, language, durationSec, segmentCount, coveredCount, ... }.
 * Throws on abort, and with `segmentationFailed` when the cut itself failed.
 */
async function runSegmentedJob(filePath, job) {
  const { options } = job;
  const outer = options.signal;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function' ? options.sleep : abortableSleep;
  progressEvent(options, 'preparing');
  let prepared;
  try {
    prepared = await prepareSegments(filePath, options, { durationSeconds: job.durationSeconds, segmentSeconds: job.segmentSeconds, fileSize: job.fileSize });
  } catch (err) {
    if (isAbortError(err, outer)) throw err;
    const wrapped = err instanceof Error ? err : new Error(String(err));
    wrapped.segmentationFailed = true;
    throw wrapped;
  }
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort(outer.reason);
  if (outer) {
    if (outer.aborted) inner.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const segments = prepared.segments.map((segment) => ({ ...segment, ...segmentLabel(segment) }));
    const total = segments.length;
    const allMeasured = segments.every((s) => Number.isFinite(s.durationSeconds) && s.durationSeconds > 0);
    const lastSegment = segments[total - 1];
    const measured = allMeasured ? round3((Number(lastSegment.offsetSeconds) || 0) + lastSegment.durationSeconds) : null;
    const mediaDuration = job.durationSeconds > 0 ? job.durationSeconds : (measured || 0);
    const eventDuration = mediaDuration || Number(options.durationSeconds) || 0;
    const emit = (stage, extra = {}) => emitProgress(options, { stage, durationSeconds: eventDuration, ...extra });
    let language = job.language;
    // An unknown length kept the short-clip hint; a long measured length detects.
    if (job.languageSource === 'hint' && !(job.durationSeconds > 0) && measured > autoLanguageMinSeconds(options)) language = undefined;
    const spans = segmentSpans(segments, mediaDuration, job.segmentSeconds);
    const meta = { segmentSeconds: job.segmentSeconds, total, cutPlan: prepared.plan.hash };
    emit('segments', { completed: 0, total, gaps: 0 });

    const loaded = [];
    for (const segment of segments) loaded.push(await loadSegmentCheckpoint(options, segment.index, meta));
    // Explicit «auto» asks for detection without the configured hint.
    const hint = job.languageSource === 'explicit' ? undefined : languageHint(options);
    const detections = [];
    let detecting = false;
    if (!language) {
      language = normalizeLanguage(prepared.manifest?.language);
      if (!language) {
        detecting = true;
        // A restart before the language was decided: checkpointed pieces with
        // speech count as detections, under the same rule as the probes below.
        for (const part of loaded) {
          const detected = partUsable(part, prepared.plan, undefined) && hasSpeechText(part.text) ? normalizeLanguage(part.language) : undefined;
          if (detected) detections.push(detected);
        }
        language = decideLanguage(detections, hint).language;
      }
    }
    const results = new Array(total).fill(null);
    let resumed = 0;
    loaded.forEach((part, i) => {
      if (partUsable(part, prepared.plan, language)) {
        results[i] = { part, resumed: true };
        resumed++;
      }
    });
    if (resumed) emit('resuming', { completed: resumed, total, gaps: 0 });

    const jc = {
      options,
      signal: inner.signal,
      rungs: job.rungs,
      state: new Map(job.rungs.map((rung) => [rung.name, { dead: null, pausedUntil: 0, consecutiveFailures: 0 }])),
      prompt: job.prompt,
      mediaDurationSeconds: mediaDuration || null,
      segmentSeconds: job.segmentSeconds,
      sleep,
      now,
      limits: ladderLimits(options),
      localPermits: createSemaphore(localParallel(options)),
      dispatch: createDispatchLock(),
      outcomes: new Map(),
      logged: new Set(),
    };
    for (const token of job.tried || []) {
      const match = /^([^(]+)\((.*)\)$/.exec(token);
      if (match) noteOutcome(jc, { name: match[1] }, match[2]);
    }

    let completed = resumed;
    let gapCount = 0;
    let processed = 0;
    let firstError = null;
    const startedAt = now();
    // Pieces already counted as completed that are read again in the locked language.
    const redo = new Set();
    const runIndex = async (i, lang) => {
      const outcome = await transcribeSegmentWithLadder(segments[i], jc, lang);
      if (outcome.part) {
        const part = { ...outcome.part, cutPlan: prepared.plan.hash };
        results[i] = { part };
        await saveSegmentCheckpoint(options, segments[i].index, meta, part);
      } else {
        results[i] = { gap: { reason: outcome.reason }, error: outcome.error };
        gapCount++;
      }
      if (!redo.delete(i)) completed++;
      processed++;
      const remaining = total - completed;
      const elapsed = now() - startedAt;
      const etaSeconds = remaining > 0 && elapsed > 0 ? Math.round(((elapsed / processed) * remaining) / 1000) : null;
      emit('transcribe', { completed, total, gaps: gapCount, ...(etaSeconds != null ? { etaSeconds } : {}) });
      return outcome;
    };

    const pending = [];
    for (let i = 0; i < total; i++) if (!results[i]) pending.push(i);
    if (!language && pending.length) {
      let probes = 0;
      while (pending.length && !language && probes < LANGUAGE_DETECT_MAX_SEGMENTS) {
        const i = pending.shift();
        probes++;
        const outcome = await runIndex(i, undefined);
        const detected = outcome.part && hasSpeechText(outcome.part.text) ? normalizeLanguage(outcome.part.language) : undefined;
        if (detected) {
          detections.push(detected);
          language = decideLanguage(detections, hint).language;
        }
      }
    }
    // One unconfirmed detection. Out of probes with pieces left: the hint wins.
    // Every piece already read (a one-piece video over the size cap): nothing
    // can confirm it, so it is trusted like the whole-file path trusts its one
    // detection, unless that piece's speech starts after Whisper's 30 s
    // detection window (it detected on silence or music).
    if (!language && detections.length) {
      const { candidate } = decideLanguage(detections, hint);
      const probed = results.find((r) => normalizeLanguage(r?.part?.language) === candidate && hasSpeechText(r.part.text))?.part;
      const firstSpeech = normalizeSegments(probed?.segments).find((s) => hasSpeechText(s.text));
      const silentOpening = Boolean(firstSpeech && firstSpeech.start >= LANGUAGE_DETECT_WINDOW_SECONDS);
      language = !pending.length && !silentOpening ? candidate : (hint || candidate);
    }
    if (detecting && language) {
      await rememberManifestLanguage(prepared, language);
      // A piece read (or resumed) under another detected language is read
      // again in the locked one: Whisper forced to the wrong language
      // translates the speech instead of transcribing it.
      for (let i = 0; i < total; i++) {
        const part = results[i]?.part;
        const partLanguage = normalizeLanguage(part?.language);
        if (part && partLanguage && partLanguage !== language && hasSpeechText(part.text)) {
          results[i] = null;
          redo.add(i);
          pending.push(i);
        }
      }
      if (redo.size) pending.sort((a, b) => a - b);
    }
    if (pending.length) {
      const cloudLive = jc.rungs.some((rung) => rung.kind === 'cloud' && !jc.state.get(rung.name).dead && !providerInCooldown(rung));
      const width = Math.max(1, Math.min(pending.length, cloudLive ? cloudParallel(options) : localParallel(options)));
      let cursor = 0;
      await Promise.all(Array.from({ length: width }, async () => {
        while (!firstError && cursor < pending.length) {
          const i = pending[cursor++];
          try {
            await runIndex(i, language);
          } catch (err) {
            if (!firstError) firstError = err;
            inner.abort(err);
          }
        }
      }));
      if (firstError) throw (outer?.aborted ? abortError() : firstError);
    }
    emit('done', { completed: total, total, gaps: gapCount });

    // Stitch by index. Timestamps become absolute; a gap leaves an inline marker.
    const texts = [];
    const covered = [];
    const stitched = [];
    const gaps = [];
    const providers = {};
    const models = new Map();
    const languages = new Map();
    const kinds = new Set();
    let coveredSeconds = 0;
    let totalSeconds = 0;
    let coveredCount = 0;
    let lastError = null;
    for (let i = 0; i < total; i++) {
      const span = spans[i];
      const length = Math.max(0, span.end - span.start);
      totalSeconds += length;
      const entry = results[i];
      if (entry && entry.part) {
        const part = entry.part;
        coveredCount++;
        coveredSeconds += length;
        const name = inferProvider(part);
        providers[name] = (providers[name] || 0) + 1;
        kinds.add(part.kind || kindOfProvider(name));
        if (part.model) models.set(part.model, (models.get(part.model) || 0) + 1);
        const lang = normalizeLanguage(part.language);
        if (lang) languages.set(lang, (languages.get(lang) || 0) + 1);
        const text = String(part.text || part.transcript || '').trim();
        if (text) { texts.push(text); covered.push(text); }
        const local = normalizeSegments(part.segments);
        if (local.length) {
          for (const s of local) stitched.push({ ...s, start: round3(s.start + span.start), end: round3(s.end + span.start) });
        } else if (text) {
          // No timestamps from this rung: one coarse segment keeps the text on the timeline.
          stitched.push({ start: span.start, end: Math.max(span.end, span.start + 0.5), text });
        }
      } else {
        lastError = entry?.error || lastError;
        gaps.push({ start: span.start, end: span.end, reason: entry?.gap?.reason || 'provider_error' });
        texts.push(gapMarker(span.start, span.end));
      }
    }
    const top = (map) => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const engine = kinds.size > 1 ? 'mixed' : (kinds.has('local') ? 'local' : (kinds.has('cloud') ? 'cloud' : null));
    const coverage = totalSeconds > 0 ? Math.round((coveredSeconds / totalSeconds) * 10000) / 10000 : Math.round((coveredCount / total) * 10000) / 10000;
    return {
      transcript: texts.join('\n\n'),
      coveredText: covered.join('\n\n'),
      segments: sortSegments(stitched),
      gaps,
      coverage,
      providers,
      engine,
      method: engine === 'local' ? 'local-whisper' : 'whisper',
      model: top(models),
      language: language || top(languages) || null,
      durationSec: mediaDuration > 0 ? round3(mediaDuration) : null,
      segmentCount: total,
      coveredCount,
      resumed,
      lastError,
      ladder: formatOutcomes(jc.outcomes),
    };
  } finally {
    if (outer) outer.removeEventListener('abort', onOuterAbort);
    if (!prepared.persistent && prepared.dir) await fsPromises.rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Success, partial success or placeholder for a finished segmented job. */
function finalizeSegmentedResult(assembled, job) {
  const { options, fileName, label, normalizedMime } = job;
  const extra = {
    durationSec: assembled.durationSec,
    segmentCount: assembled.segmentCount,
    partial: assembled.gaps.length > 0,
    gaps: assembled.gaps,
    coverage: assembled.coverage,
    providers: assembled.providers,
    engine: assembled.engine,
  };
  const speech = hasSpeechText(assembled.coveredText);
  const covered = `${assembled.coveredCount}/${assembled.segmentCount} segments (coverage ${Math.round(assembled.coverage * 1000) / 10}%)`;
  if (!assembled.gaps.length) {
    if (!speech) return { ...placeholderResult(fileName, label, normalizedMime, 'no_speech'), ...extra, language: assembled.language, segments: [] };
    logInfo(`segmented transcription of ${fileName}: ${covered}; providers: ${formatProviders(assembled.providers)}`);
    return formatSuccess({
      text: assembled.transcript,
      method: assembled.method,
      model: assembled.model || (assembled.engine === 'local' ? 'base' : null),
      language: assembled.language,
      segments: assembled.segments,
      ...extra,
    });
  }
  if (!assembled.coveredCount || assembled.coverage < minCoverage(options) || !speech) {
    const allDecode = assembled.gaps.every((gap) => gap.reason === 'audio_decode_failed');
    const reasonCode = !assembled.coveredCount ? (allDecode ? 'audio_decode_failed' : 'local_unavailable') : 'low_coverage';
    logSafe(`transcription unavailable for ${fileName} (${reasonCode}, ${covered}); providers tried: ${assembled.ladder || 'none'}`);
    return {
      ...placeholderResult(fileName, label, normalizedMime, reasonCode),
      ...extra,
      language: assembled.language,
      segments: assembled.segments,
    };
  }
  logSafe(`partial transcription of ${fileName}: ${covered}; providers tried: ${assembled.ladder || 'none'}`);
  return formatSuccess({
    text: assembled.transcript,
    method: assembled.method,
    model: assembled.model || (assembled.engine === 'local' ? 'base' : null),
    language: assembled.language,
    segments: assembled.segments,
    ...extra,
  });
}

function formatProviders(providers) {
  return Object.entries(providers || {}).map(([name, count]) => `${name}×${count}`).join(' ') || 'none';
}

/** Single-request fields for the result contract. */
function singleRequestFields(durationSeconds, provider, engine) {
  return {
    durationSec: durationSeconds > 0 ? durationSeconds : null,
    segmentCount: 1,
    partial: false,
    gaps: [],
    coverage: 1,
    providers: { [provider]: 1 },
    engine,
  };
}

async function transcribeLocalWholeFile(filePath, job, tried) {
  const { options, fileName, label, normalizedMime, language, prompt } = job;
  const impl = options.localTranscribe || localWhisper.transcribeLocal;
  try {
    const local = await impl(filePath, { ...options, language, prompt, mediaDurationSeconds: job.durationSeconds || null });
    const text = String(local?.text || local?.transcript || '').trim();
    if (!hasSpeechText(text)) {
      return placeholderResult(fileName, label, normalizedMime, 'no_speech');
    }
    return formatSuccess({
      text,
      method: 'local-whisper',
      model: local.model || 'base',
      language: local.language || language || null,
      segments: local.segments,
      ...singleRequestFields(job.durationSeconds, 'local', 'local'),
    });
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    const localReason = String(err?.reason || err?.code || err?.message || 'failed').replace(/\s+/g, ' ').slice(0, 120);
    tried.push(`local(${localReason})`);
    logSafe(`Local Whisper failed: ${sanitizeProviderError(err)}`);
    logSafe(`transcription unavailable for ${fileName}; providers tried: ${tried.join(' ')}`);
    return placeholderResult(fileName, label, normalizedMime, err?.code === 'AUDIO_DECODE_FAILED' ? 'audio_decode_failed' : 'local_unavailable');
  }
}

/**
 * Transcribe an audio or video file.
 * Returns { ok, status, text, transcript, method, model, language, segments,
 * durationSec, segmentCount, partial, gaps, coverage, providers, engine }.
 */
async function transcribeUnqueued(filePath, mimeType, originalName, options = {}) {
  throwIfAborted(options.signal);
  options = { ...options, durationSeconds: await probeAudioDuration(filePath, options) };
  const fileName = originalName || path.basename(filePath);
  const normalizedMime = normalizeAudioMime(mimeType, fileName);
  const info = mimeInfo(normalizedMime, fileName);
  const label = info.label;
  const language = resolveLanguage(options);
  const languageSource = hasExplicitLanguage(options) ? 'explicit' : (language ? 'hint' : 'auto');
  const prompt = resolvePrompt(options);
  const maxBytes = audioMaxFileBytes(options);

  let fileSize = 0;
  try {
    fileSize = (await fsPromises.stat(filePath)).size;
  } catch {
    return placeholderResult(fileName, label, normalizedMime, 'file_unavailable');
  }
  if (!fileSize) return placeholderResult(fileName, label, normalizedMime, 'file_empty');

  const cloud = cloudProviders(options);
  const segmentSeconds = effectiveSegmentSeconds(options, cloud);
  const duration = Number(options.durationSeconds) || 0;
  const job = { options, fileName, normalizedMime, label, language, languageSource, prompt, durationSeconds: duration, fileSize, segmentSeconds };
  const tried = [];

  // Long media (or a file above the provider cap): one cut, a per-segment
  // ladder, partial results instead of all-or-nothing.
  if (fileSize > maxBytes || duration > segmentSeconds) {
    const vs = voiceStudioRung(options);
    const rungs = [...cloud, ...(vs ? [vs] : []), ...(localEnabled(options) ? [LOCAL_RUNG] : [])];
    if (!rungs.length) {
      logSafe(`transcription unavailable for ${fileName}; providers tried: none local(disabled)`);
      return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
    }
    try {
      return finalizeSegmentedResult(await runSegmentedJob(filePath, { ...job, rungs, tried }), job);
    } catch (err) {
      if (isAbortError(err, options.signal) || !err?.segmentationFailed) throw err;
      logSafe(`could not cut ${fileName} into segments (${sanitizeProviderError(err)})`);
      // Unknown length and ffmpeg cannot cut it: let the local decoder decide
      // (it reports a decode failure honestly). A known long file is retried.
      if (duration > 0 || !localEnabled(options)) {
        logSafe(`transcription unavailable for ${fileName}; providers tried: segmentation(${err?.code || 'failed'})`);
        return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
      }
      return transcribeLocalWholeFile(filePath, job, tried);
    }
  }

  // Short clip: ONE request per rung, exactly as before. Cloud ladder
  // (OpenAI → Groq → xAI → Meta); `tried` feeds the final summary line
  // («providers tried: …»).
  for (const provider of cloud) {
    if (providerInCooldown(provider)) {
      tried.push(`${provider.name}(cooldown)`);
      continue;
    }
    try {
      const result = await transcribeCloudFile(provider, filePath, normalizedMime, fileName, options, language, prompt);
      const text = String(result.text || '').trim();
      if (!hasSpeechText(text)) {
        return placeholderResult(fileName, label, normalizedMime, 'no_speech');
      }
      return formatSuccess({
        text,
        method: 'whisper',
        model: result.model,
        language: result.language,
        segments: result.segments,
        ...singleRequestFields(duration, provider.name, 'cloud'),
      });
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      const safe = sanitizeProviderError(err);
      tried.push(`${provider.name}(${describeProviderError(err)})`);
      if (isInvalidKeyError(err)) {
        rememberProviderRejection(provider, err, options);
        logSafe(`${provider.name} transcription rejected the key (${safe}); skipping it for ${Math.round(providerCooldownMs(options) / 60000)} min; trying the next provider`);
      } else if (isBillingError(err)) {
        rememberProviderRejection(provider, err, options);
        logSafe(`${provider.name} transcription has no credits (${safe}); skipping it for ${Math.round(providerCooldownMs(options) / 60000)} min; trying the next provider`);
      } else {
        logSafe(`${provider.name} transcription failed (${safe}); trying the next provider`);
      }
    }
  }

  // Opt-in: Sira Voz / VoiceStudio (WhisperX large-v3, on this host). List
  // 'voicestudio' in TRANSCRIBE_PROVIDERS to use it before the bundled
  // whisper.cpp base model — better accuracy, slower on CPU, still free.
  if (providerOrder(options).includes('voicestudio')) {
    const vsClient = voiceStudioClient(options);
    if (vsClient.isConfigured(options)) {
      try {
        const vs = await vsClient.transcribe({ filePath, filename: fileName, mime: normalizedMime, language, prompt, signal: options.signal }, options);
        const text = String(vs?.text || '').trim();
        if (hasSpeechText(text)) {
          return formatSuccess({
            text,
            method: 'local-whisper',
            model: 'voicestudio-whisperx',
            language: vs.language || language || null,
            segments: vs.segments,
            ...singleRequestFields(duration, 'voicestudio', 'local'),
          });
        }
        tried.push('voicestudio(no_speech)');
        logSafe('VoiceStudio transcription returned no speech; trying the next provider');
      } catch (err) {
        if (isAbortError(err, options.signal)) throw err;
        tried.push(`voicestudio(${describeProviderError(err)})`);
        logSafe(`VoiceStudio transcription failed (${sanitizeProviderError(err)}); trying the next provider`);
      }
    }
  }

  if (!localEnabled(options)) {
    logSafe(`transcription unavailable for ${fileName}; providers tried: ${tried.join(' ') || 'none'} local(disabled)`);
    return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
  }

  // Unknown length: never hand a possibly multi-hour file to ONE whisper
  // process (no checkpoints, ~2 GB of RAM). Cut it; if ffmpeg cannot, the
  // local decoder gets the whole file as before.
  if (!(duration > 0)) {
    try {
      return finalizeSegmentedResult(await runSegmentedJob(filePath, { ...job, rungs: [LOCAL_RUNG], tried }), job);
    } catch (err) {
      if (isAbortError(err, options.signal) || !err?.segmentationFailed) throw err;
    }
  }
  return transcribeLocalWholeFile(filePath, job, tried);
}

// Shared admission control also covers uploads and agent-task recovery calls.
// Do not fan out fifty whisper processes (or fifty paid requests) at once.
const TRANSCRIPTION_CONCURRENCY = 2;
let activeTranscriptions = 0;
const transcriptionQueue = [];
const inFlight = new Map();
const identityIds = new WeakMap();
let nextIdentityId = 1;
function identity(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return String(value || '');
  if (!identityIds.has(value)) identityIds.set(value, nextIdentityId++);
  return identityIds.get(value);
}

function drainTranscriptions() {
  while (activeTranscriptions < TRANSCRIPTION_CONCURRENCY && transcriptionQueue.length) {
    const job = transcriptionQueue.shift();
    job.signal.removeEventListener('abort', job.onAbort);
    if (job.signal.aborted) { job.reject(abortError()); continue; }
    activeTranscriptions++;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      activeTranscriptions--;
      drainTranscriptions();
    });
  }
}

function enqueueTranscription(run, signal) {
  return new Promise((resolve, reject) => {
    const job = { run, signal, resolve, reject };
    job.onAbort = () => {
      const index = transcriptionQueue.indexOf(job);
      if (index >= 0) transcriptionQueue.splice(index, 1);
      reject(abortError());
    };
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', job.onAbort, { once: true });
    transcriptionQueue.push(job);
    drainTranscriptions();
  });
}

async function transcribe(filePath, mimeType, originalName, options = {}) {
  throwIfAborted(options.signal);
  // Explicitly cancellable jobs own their signal and durable claim. Do not
  // couple independently cancelled jobs through single-flight; unsignalled
  // legacy upload calls still share work below.
  if (options.signal) return enqueueTranscription(() => transcribeUnqueued(filePath, mimeType, originalName, options), options.signal);
  const stat = await fsPromises.stat(filePath).catch(() => null);
  throwIfAborted(options.signal);
  // Include configuration identity as well as file revision. Never share a
  // result across explicitly different injected clients/settings. No permanent
  // cache: persistence and access checks are owned by the File/job layer.
  const key = JSON.stringify([path.resolve(filePath), stat?.size, stat?.mtimeMs,
    normalizeAudioMime(mimeType, originalName), originalName, resolveLanguage(options), options.prompt || envOf(options).WHISPER_PROMPT,
    normalizeKeyterms(options.keyterms), options.parallel, options.minCoverage,
    providerOrder(options), options.model, options.maxFileBytes, options.durationSeconds, options.segmentSeconds,
    options.ffmpegPath, options.ffprobePath, options.whisperBin, options.modelPath, options.pythonPath, options.threads, options.timeoutMs,
    ...['env', 'openai', 'groqClient', 'metaClient', 'localTranscribe', 'xaiTranscribe', 'voiceStudio', 'segmentAudio', 'probeAudioDuration', 'spawnImpl', 'createFile',
      'execFileImpl', 'detectSilences', 'concatAudio', 'sleep', 'checkpoint'].map((k) => identity(options[k])),
  ]);
  let entry = inFlight.get(key);
  if (entry?.controller.signal.aborted) entry = null;
  if (!entry) {
    entry = { controller: new AbortController(), subscribers: new Set() };
    inFlight.set(key, entry);
    const current = entry;
    entry.promise = enqueueTranscription(() => transcribeUnqueued(filePath, mimeType, originalName, {
      ...options, signal: current.controller.signal,
      onProgress: (event) => { for (const subscriber of current.subscribers) emitProgress(subscriber.options, event); },
    }), entry.controller.signal);
    const cleanup = () => { if (inFlight.get(key) === current) inFlight.delete(key); };
    entry.promise.then(cleanup, cleanup);
  }
  const subscriber = { options };
  entry.subscribers.add(subscriber);
  try {
    return await entry.promise;
  } finally {
    entry.subscribers.delete(subscriber);
  }
}

module.exports = {
  isAudioMedia,
  probeAudioDuration,
  parseProgressDuration,
  TRANSCRIPTION_CONCURRENCY,
  cloudProviders,
  providerOrder,
  segmentForCloud,
  prepareSegments,
  planCutTimes,
  mergeShortTail,
  parseSilences,
  segmentationTimeoutMs,
  effectiveSegmentSeconds,
  transcriptionModelCaps,
  transcribeCloud,
  transcribeSegmentWithLadder,
  buildSrt,
  buildVtt,
  formatTimestamp,
  normalizeSegments,
  DEFAULT_META_TRANSCRIBE_MODEL,
  DEFAULT_GROQ_TRANSCRIBE_MODEL,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_PROVIDER_COOLDOWN_MS,
  DEFAULT_SEGMENT_SECONDS,
  isBillingError,
  isRateLimitError,
  parseRetryAfterMs,
  metaTranscriptionEnabled,
  providerInCooldown,
  clearTranscriptionCooldowns,
  groqApiKey,
  transcribe,
  generatePlaceholder,
  sanitizeProviderError,
  normalizeAudioMime,
  normalizeLanguage,
  resolveLanguage,
  resolvePrompt,
  isAbortError,
  isInvalidKeyError,
  hasOpenAiKey,
  xaiApiKey,
  DEFAULT_XAI_STT_MODEL,
  AUDIO_MIME_MAP,
  SUCCESS_METHODS,
  get AUDIO_MAX_FILE_BYTES() {
    return audioMaxFileBytes();
  },
};
