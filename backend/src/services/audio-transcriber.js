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
 * Intake (every job, before any rung):
 *   - ONE ffprobe (media-probe.probeMediaStreams) lists the streams. A file
 *     with no audio stream ends at once as `no_audio_track` (non-transient);
 *     the audio track comes from media-probe.chooseAudioStream (language,
 *     disposition, never commentary/music/description titles; never loudness)
 *     unless options.audioStreamOrdinal names one, and every decode maps it
 *     (`-map 0:a:N`: segment cut, short-clip master, local whisper.cpp)
 *     under media-probe's own 100M discovery window — an ordinal only names
 *     the same track under the same window (a late-audio VOB lists its tracks
 *     in another order, or not at all, in ffmpeg's default 5 MB / 5 s one).
 *   - Protected MP4 audio (FairPlay `drms`, CENC `enca`, Audible `aavd`
 *     sample entries; ffmpeg decodes them to noise) is `drm_protected` before
 *     any decode.
 *   - A short clip is transcoded ONCE to a mono 16 kHz FLAC master with a
 *     clean name (`audio.flac`) and THAT is what every rung receives: no more
 *     400s for .opus/.amr/.3gp/.mov/.mkv, no video container ever uploaded.
 *     A decode ffmpeg rejects goes down one ladder (decodeLadder): tolerant
 *     (`-err_detect ignore_err -fflags +discardcorrupt+genpts`, wide window)
 *     with the track, then without it. A missing moov atom is
 *     `truncated_container`; «no audio stream» is conclusive only once a
 *     tolerant pass agrees. Without ffmpeg the clip goes as uploaded
 *     (degraded); a host-side failure uploads the containers providers accept.
 *   - New cut plans snap to silences under an ADAPTIVE threshold: the noise
 *     floor is estimated from a few short `-ss/-t` windows (never a second
 *     full decode) and only ever raises the -35 dB default for noisy rooms.
 *     Existing manifests and their plans are reused untouched.
 *   - Language: auto-detected unless options.language names one; a language
 *     Whisper does not support (quechua, aimara…) is detected automatically
 *     with a note instead of failing every rung.
 *   - options.hints.terms join options.keyterms in the prompt (deduped,
 *     capped, device identifiers such as «WA0012» or «GMT20261003» dropped).
 *   The result carries `audioStream` ({ streamOrdinal, reason } | null; null
 *   too when the text did not come from the chosen track), `notes` (Spanish,
 *   for the delivery; the track and tolerant-read notes only on success) and
 *   `intake` (machine-readable: track, decode, decodeCause…).
 *
 * Quality loop (C4 quality half, audio-quality.js). The first answer no longer
 * wins by default:
 *   - every answer is scored with engine-agnostic signals (compression ratio,
 *     characters per voiced second, the hallucination lexicon and prompt
 *     echo, empty text over measured speech energy). A flagged piece gets up
 *     to TRANSCRIBE_ESCALATION_MAX_PER_PIECE (2) alternative hypotheses — the
 *     next live rung, an opt-in escalation rung, or the SAME rung on an
 *     enhanced copy (high-pass + dynaudnorm / loudnorm; never the default
 *     decode) — and the keeper is chosen by agreement between hypotheses,
 *     never by comparing logprobs of different engines. Bounded by a per-job
 *     budget (TRANSCRIBE_ESCALATION_BUDGET_RATIO of the media, ≥ one piece).
 *   - `no_speech` needs a SECOND opinion (another rung, or the enhanced copy
 *     on the same rung) that agrees. A segmented piece answered empty over
 *     measured speech energy is re-asked; if every second opinion fails it is
 *     a gap, never «covered».
 *   - a dead rung revives: a cooldown or a 3-in-a-row streak pauses it
 *     (deadUntil: the cooldown, else 5 / 15 / 30 min), it is never latched
 *     for the rest of a 5-hour job. Only a missing local engine is permanent.
 *   - the last live rung is never killed by the streak: a transient local
 *     failure (timeout, crash, EAGAIN) backs off 30 s / 2 min / 10 min within
 *     the job's wait budget; a decode failure or a repeated OOM kill is
 *     deterministic and only fails that piece.
 *   - opt-in escalation rungs (TRANSCRIBE_ESCALATION_PROVIDERS: voicestudio,
 *     elevenlabs) are used only for flagged pieces, never for the first pass.
 *   - options.range + options.forceRetranscribe (refine): the pieces that
 *     overlap the range ignore their checkpoints and are reviewed (one more
 *     hypothesis at least); every other piece is reused from its checkpoint,
 *     and one without a usable part (none kept, another language) is skipped,
 *     never transcribed: it adds no text and no gap, stays out of the
 *     coverage, and the result says how many with `refineSkipped`.
 *     `refineSpans` ([[start, end], …], seconds on the file clock, one per
 *     piece re-read for the window, omitted when none) says exactly which
 *     stretches were read again: a caller splicing the window back cuts by
 *     them, never by guessing from the segments.
 *     options.refineSkipUnusable === false (a caller that cannot splice a
 *     window back into its transcript) transcribes those pieces instead: the
 *     window is still forced and the whole result comes back. So does a
 *     checkpoint whose entries were cut by another plan (the stored
 *     transcript's segments would not line up with the new pieces); an
 *     optional checkpoint.savedCutPlan(index) tells it for entries load
 *     ignores. Stitched segment starts stay inside their piece.
 *   The result carries `quality` ({ score, level, lowConfidence, escalations,
 *   enginesUsed, notes }); checkpointed parts carry an optional `review`.
 *
 * Config:
 *   WHISPER_MODEL = whisper-1 (OpenAI only; gpt-4o*-transcribe models get
 *     json / diarized_json and 300 s segments)
 *   WHISPER_LANGUAGE = prior used to LOCK the language of long, segmented
 *     jobs (decideLanguage). It is no longer forced on short clips: they are
 *     auto-detected unless options.language is given. Defaults to es.
 *   WHISPER_PROMPT = optional guiding prompt; options.keyterms are appended
 *   AUDIO_MAX_FILE_BYTES = 25 MB
 *   WHISPER_CPP_BIN / WHISPER_CPP_MODEL / LOCAL_WHISPER_MODEL
 *   TRANSCRIBE_ADAPTIVE_SILENCE (on; 0 keeps the fixed -35 dB threshold)
 * Segmented jobs:
 *   TRANSCRIBE_CLOUD_PARALLEL (3) / TRANSCRIBE_LOCAL_PARALLEL (1)
 *   TRANSCRIBE_MIN_COVERAGE (0.8) — below it a partial job is a failure
 *   TRANSCRIBE_RATE_LIMIT_MAX_WAIT_MS (300000) / TRANSCRIBE_RATE_LIMIT_RETRIES (5)
 *   TRANSCRIBE_SEGMENT_RETRIES (2, cloud 5xx/timeouts) / TRANSCRIBE_LOCAL_RETRIES (0)
 *   TRANSCRIBE_CLOUD_TIMEOUT_MS (max(120 s, 0.4 s per audio second))
 *   TRANSCRIBE_SILENCE_SNAP (on; 0 cuts on fixed times)
 * Quality loop:
 *   TRANSCRIBE_QUALITY_LOOP (on; 0 restores first-answer-wins)
 *   TRANSCRIBE_ESCALATION_PROVIDERS (none; «voicestudio,elevenlabs» opt-in, paid)
 *   TRANSCRIBE_ESCALATION_BUDGET_RATIO (0.3) / TRANSCRIBE_ESCALATION_MAX_PER_PIECE (2)
 *   TRANSCRIBE_LAST_RUNG_WAIT_BUDGET_MS (1200000)
 *   ELEVENLABS_API_KEY + ELEVENLABS_STT_MODEL (scribe_v1) for the elevenlabs rung
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
const quality = require('./audio-quality');
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
  // Labels only: these containers never travel to a cloud rung as uploaded
  // (the short-clip master is FLAC), but the placeholder names them honestly.
  'video/x-matroska': { ext: 'mkv', label: 'Video MKV' },
  'video/x-msvideo': { ext: 'avi', label: 'Video AVI' },
  'video/x-ms-wmv': { ext: 'wmv', label: 'Video WMV' },
  'video/x-flv': { ext: 'flv', label: 'Video FLV' },
  'video/3gpp': { ext: '3gp', label: 'Video 3GP' },
  'video/3gpp2': { ext: '3g2', label: 'Video 3G2' },
  'video/mp2t': { ext: 'ts', label: 'Video MPEG-TS' },
  'video/ogg': { ext: 'ogv', label: 'Video OGG' },
  'audio/amr-wb': { ext: 'awb', label: 'Audio AMR-WB' },
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
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.ogv': 'video/ogg',
};

// What OpenAI / Groq accept as an upload (their documented list). Only used
// when ffmpeg could not produce the FLAC master: an audio file in one of these
// containers still goes as uploaded (today's behaviour); anything else (and
// any video container) would only collect 400s, so the cloud rungs are skipped.
const CLOUD_SAFE_EXTENSIONS = new Set(['.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.oga', '.wav', '.webm']);
// Audio formats that hold exactly one audio stream: when the caller already
// measured the length, there is no track to choose and nothing to probe.
const SINGLE_TRACK_AUDIO_EXTENSIONS = new Set(['.wav', '.wave', '.mp3', '.mpga', '.mp2', '.flac', '.aac', '.amr', '.awb', '.opus', '.ogg', '.oga', '.aif', '.aiff', '.aifc', '.au', '.caf']);

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
const COOLDOWN_PROVIDERS = ['openai', 'groq', 'xai', 'meta', 'elevenlabs'];
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
// silencedetect compares EVERY sample with the threshold (one sample above it
// ends a pause), so the adaptive threshold is built from per-frame PEAKS: the
// quiet frames' peak (noise floor) + 8 dB, never closer than 6 dB to the loud
// frames' peak (speech), and only ever RAISED from the -35 dB default — a
// clean recording keeps exactly today's cut plan.
const DEFAULT_SILENCE_THRESHOLD_DB = -35;
const MAX_SILENCE_THRESHOLD_DB = -20;
const SILENCE_FLOOR_MARGIN_DB = 8;
const SILENCE_SPEECH_MARGIN_DB = 6;
const SILENCE_MIN_SECONDS = 0.4;
// Noise-floor sampling: a few short windows decoded with input seeking, so a
// 5-hour file costs seconds, never a second full decode.
const NOISE_SAMPLE_WINDOWS = 5;
const NOISE_SAMPLE_SECONDS = 12;
const NOISE_SAMPLE_TIMEOUT_MS = 20_000;
const NOISE_SAMPLE_BUDGET_MS = 60_000;
const NOISE_FRAME_SAMPLES = 800; // 50 ms at 16 kHz
const NOISE_MIN_FRAMES = 40; // 2 s of audio before the estimate is trusted
// The stream-discovery window media-probe uses. A track ordinal (`0:a:N`)
// only means the same track under the SAME window: in an MPEG-PS/VOB whose
// audio starts late, ffmpeg's default 5 MB / 5 s window lists the tracks in
// another order (`-map 0:a:1` silently decodes the other language) or not at
// all («matches no streams»). Every decode that maps an ordinal uses it.
const PROBE_WINDOW_ARGS = Object.freeze(['-probesize', '100M', '-analyzeduration', '100M']);
// Retried once when a strict decode fails: drop corrupt packets, keep going on
// decoder errors, regenerate timestamps, and look further for a late audio PID.
const TOLERANT_INPUT_ARGS = Object.freeze([
  '-err_detect', 'ignore_err', '-fflags', '+discardcorrupt+genpts', ...PROBE_WINDOW_ARGS,
]);
// Short-clip master: what every rung receives instead of the uploaded bytes.
const CLIP_MASTER_NAME = 'audio.flac';
const CLIP_MASTER_MIME = 'audio/flac';
// Intake outcomes that end the job at once (nothing a retry or a rung changes).
const INTAKE_FATAL_CODES = new Set(['no_audio_track', 'truncated_container', 'drm_protected']);
const DRM_EXTENSION_RE = /\.(?:m4p|aax|aaxc|aa)$/i;
// Protected MP4 audio sample entries: FairPlay (drms), CENC/CBCS (enca),
// Audible (aavd). ffmpeg decodes them to noise or decode errors (often exit
// 0), and ffprobe reports the ORIGINAL format (mp4a) from the frma box, so
// only the sample description itself tells. Also accepted as a probe tag.
const PROTECTED_AUDIO_ENTRIES = new Set(['drms', 'enca', 'aavd']);
const MP4_FAMILY_EXT_RE = /\.(?:mp4|m4a|m4b|m4p|m4v|mov|3gp|3g2|aax|aaxc|f4a|f4v|ismv|isma)$/i;
const MP4_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const MP4_MAX_BOXES = 512;
const MP4_MAX_STSD_BYTES = 64 * 1024;
const DRM_TEXT_RE = /activation[_ ]?bytes|\bdrm\b|\bfairplay\b|decrypt(?:ion)? key|encrypted (?:stream|track|content|file)/i;
const TRUNCATED_TEXT_RE = /moov atom not found/i;
const NO_STREAM_TEXT_RE = /does not contain any stream/i;
const STREAM_NOT_FOUND_TEXT_RE = /matches no streams/i;
const RESOURCE_TEXT_RE = /no space left on device|cannot allocate memory|resource temporarily unavailable|too many open files|input\/output error/i;
// ffprobe's text-art demuxers (a .txt is «ANSI video»): never evidence of «no audio».
const TEXT_ART_CODECS = new Set(['ansi', 'bintext', 'xbin', 'idf', 'tty']);
const MAX_INTAKE_NOTES = 8;
// Prompt vocabulary: user terms (options.hints.terms) + file-name key terms.
const MAX_HINT_TERMS = 30;
const MAX_PROMPT_TERMS = 40;
// Parallelism, retries and coverage (env-tunable).
const DEFAULT_CLOUD_PARALLEL = 3;
const DEFAULT_LOCAL_PARALLEL = 1;
const DEFAULT_MIN_COVERAGE = 0.8;
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_RETRIES = 5;
const DEFAULT_SEGMENT_RETRIES = 2;
const DEFAULT_LOCAL_RETRIES = 0;
const RATE_LIMIT_BASE_WAIT_MS = 15_000;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
// After this many consecutive segments failed on a rung, the job pauses it (a
// provider that is down must not cost 3 calls per segment). The pause ends:
// REVIVAL_DELAYS_MS (5, 15, 30 min, then every 30 min) — never for good.
const RUNG_MAX_CONSECUTIVE_FAILURES = 3;
const REVIVAL_DELAYS_MS = Object.freeze([5 * 60_000, 15 * 60_000, 30 * 60_000]);
// The last live rung for a piece is never paused by the streak: a transient
// failure backs off and retries, within the job's wait budget.
const LAST_RUNG_BACKOFF_MS = Object.freeze([30_000, 120_000, 600_000]);
const DEFAULT_WAIT_BUDGET_MS = 20 * 60_000;
// A SIGKILL we did not send (OOM) twice on the same piece: deterministic.
const OOM_REPEAT_LIMIT = 2;
// Quality loop (audio-quality.js): alternative hypotheses for flagged pieces.
const DEFAULT_ESCALATION_BUDGET_RATIO = 0.3;
const ESCALATION_MIN_BUDGET_SEC = 600;
const DEFAULT_ESCALATIONS_PER_PIECE = 2;
// Second opinions on empty pieces: this many agreeing «no speech» pieces in a
// job (and none where the second opinion found speech) and the job trusts the
// remaining empty answers (a 5-hour concert is not re-read piece by piece).
const SECOND_OPINION_TRUST_AFTER = 3;
// A cloud alternative hypothesis that fails transiently is tried once more
// (bounded by TRANSCRIBE_SEGMENT_RETRIES).
const REVIEW_TRANSIENT_RETRIES = 1;
const ENERGY_MEASURE_TIMEOUT_MS = 60_000;
const FILTER_LIST_TIMEOUT_MS = 10_000;
// A failed `ffmpeg -filters` (other than a missing binary) is read again after this.
const FILTER_LIST_RETRY_MS = 5 * 60_000;
// Enhanced copies, used ONLY as alternative hypotheses (never the default
// decode): enhancement can raise Whisper's WER on moderately noisy speech.
const VARIANT_FILTERS = Object.freeze({
  dynaudnorm: Object.freeze({ filter: 'highpass=f=80,dynaudnorm=f=150:g=15:p=0.9:m=20', needs: Object.freeze(['highpass', 'dynaudnorm']) }),
  loudnorm: Object.freeze({ filter: 'highpass=f=70,loudnorm=I=-20:TP=-2:LRA=11', needs: Object.freeze(['highpass', 'loudnorm']) }),
});
const ESCALATION_PROVIDER_NAMES = new Set(['voicestudio', 'elevenlabs']);
const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v1';
// Language detection runs on the first segments, one at a time, until the
// detections decide a language (decideLanguage); the rest of the job uses it.
const LANGUAGE_DETECT_MAX_SEGMENTS = 3;
// Whisper detects the language on the first 30 s of what it is given.
const LANGUAGE_DETECT_WINDOW_SECONDS = 30;
const MAX_PROMPT_CHARS = 1000;
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 80;
const MANIFEST_VERSION = 1;
const AUDIO_CLOCK = 'pts-v1';
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
// non-speech annotation («[Música]», «[Música de fondo]», «(upbeat music)»,
// «[♪]»). It is not a spoken transcript and must not become evidence for a
// subsequent analysis. Keep annotations when speech ALSO exists; never
// discard a short real utterance such as "Sí" or "No". Same rule as the
// quality loop (audio-quality.isNonSpeechText).
function hasSpeechText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !quality.isNonSpeechText(text);
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
  // Peruvian / Andean languages users ask for by name (Whisper has none of
  // them: they are mapped so the request is recognised and noted, see below).
  quechua: 'qu', runasimi: 'qu', aimara: 'ay', aymara: 'ay', guaraní: 'gn', guarani: 'gn',
});
const ISO639_2_TO_1 = Object.freeze({
  spa: 'es', eng: 'en', por: 'pt', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', cat: 'ca',
  jpn: 'ja', zho: 'zh', chi: 'zh', kor: 'ko', rus: 'ru', ara: 'ar', que: 'qu', nld: 'nl', dut: 'nl',
  pol: 'pl', tur: 'tr', hin: 'hi', ukr: 'uk', ron: 'ro', rum: 'ro', swe: 'sv', nor: 'no', dan: 'da',
  fin: 'fi', ell: 'el', gre: 'el', heb: 'he', ces: 'cs', cze: 'cs', hun: 'hu', ind: 'id', tha: 'th',
  vie: 'vi', glg: 'gl', eus: 'eu', baq: 'eu', aym: 'ay', grn: 'gn', quz: 'qu', quy: 'qu',
});

// The languages Whisper (whisper-1, large-v3, whisper.cpp) can be told to
// transcribe. Anything else makes OpenAI/Groq answer 400 and `whisper-cli -l`
// exit non-zero on EVERY segment, so it is detected automatically instead.
const WHISPER_LANGUAGES = new Set((
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la '
  + 'mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be '
  + 'tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'
).split(' '));
// Retired or regional ISO codes Whisper knows under another one.
const WHISPER_LANGUAGE_ALIASES = Object.freeze({ nb: 'no', iw: 'he', in: 'id', ji: 'yi' });
// Spanish names for the notes the delivery shows («El quechua…»).
const LANGUAGE_NAMES_ES = Object.freeze({
  es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán', ca: 'catalán',
  gl: 'gallego', eu: 'euskera', ja: 'japonés', zh: 'chino', ko: 'coreano', ru: 'ruso', ar: 'árabe', nl: 'neerlandés',
  qu: 'quechua', ay: 'aimara', gn: 'guaraní',
});

function languageNameEs(code) {
  return LANGUAGE_NAMES_ES[code] || `«${code}»`;
}

/** The code Whisper accepts for an ISO-639-1 code, or null when it has none. */
function whisperLanguageCode(code) {
  if (!code) return null;
  const mapped = WHISPER_LANGUAGE_ALIASES[code] || code;
  return WHISPER_LANGUAGES.has(mapped) ? mapped : null;
}

function isSupportedLanguage(value) {
  return Boolean(whisperLanguageCode(normalizeLanguage(value)));
}

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

function hasExplicitLanguage(options = {}) {
  return typeof options.language === 'string' && Boolean(options.language.trim());
}

/**
 * The language to REQUEST, or undefined («detect»). Only an explicit
 * options.language forces one, and only a language Whisper supports ('auto'
 * and unsupported languages such as quechua → detect). Short clips and
 * unknown lengths are no longer forced to the WHISPER_LANGUAGE hint: a 30 s
 * English note forced to «es» came out translated, silently. The hint stays
 * the prior that LOCKS long, segmented jobs (decideLanguage).
 */
function resolveLanguage(options = {}) {
  if (!hasExplicitLanguage(options)) return undefined;
  return whisperLanguageCode(normalizeLanguage(options.language)) || undefined;
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

// Device and app identifiers in file names are not vocabulary: on a silent or
// short clip Whisper echoes its prompt, so «WA0012» used to land in the text.
const DEVICE_ID_RE = /^[A-Z]{1,4}\d{3,}$/;
const DEVICE_PREFIX_RE = /^(?:PTT|AUD|VID|IMG|REC|GMT|DSC|MVI|WA)(?=$|[\d_\-\s.])/i;
const RESOLUTION_RE = /^\d{2,5}\s*[x×]\s*\d{2,5}$|^\d{3,4}[pi]$/i;
const NUMERIC_SHAPE_RE = /^[\d\s\-_.:/,]+$/; // dates, clocks, counters
const CLOCK_RE = /^\d{1,2}\s*h\s*\d{2}$/i;

/** True for «WA0012», «PTT-20261003», «GMT20261003», «1920x1080», «2026-10-03», «15:00»… */
function isDeviceIdentifier(term) {
  const value = oneLine(term);
  if (!value) return true;
  if (DEVICE_ID_RE.test(value) || DEVICE_PREFIX_RE.test(value) || RESOLUTION_RE.test(value) || CLOCK_RE.test(value)) return true;
  if (NUMERIC_SHAPE_RE.test(value) && (value.match(/\d/g) || []).length >= 3) return true;
  return false;
}

function hintTermsOf(options = {}) {
  const raw = options.hints && typeof options.hints === 'object' ? options.hints.terms : null;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  // A user can type «Huamán, Ayacucho» as one item: split it like keyterms.
  return normalizeKeyterms(list.flatMap((item) => String(item ?? '').split(/[,;\n]/)));
}

/**
 * The vocabulary the prompt carries: file-name key terms and the user's hint
 * terms (C4 `hints.terms`), device identifiers dropped, deduplicated case-
 * insensitively (the user's spelling wins) and capped. The user's terms go
 * LAST: Whisper reads the end of a prompt, and the start is what gets trimmed.
 */
function promptTerms(options = {}) {
  const user = hintTermsOf(options).filter((term) => !isDeviceIdentifier(term)).slice(0, MAX_HINT_TERMS);
  const taken = new Set(user.map((term) => term.toLowerCase()));
  const fromFile = normalizeKeyterms(options.keyterms)
    .filter((term) => !isDeviceIdentifier(term) && !taken.has(term.toLowerCase()));
  return [...fromFile.slice(0, Math.max(0, MAX_PROMPT_TERMS - user.length)), ...user];
}

/**
 * Prompt sent to every rung: options.prompt (or WHISPER_PROMPT) followed by
 * the key terms as a plain comma list. Whisper reads the END of a prompt, so
 * the terms go last and the free text is the part that gets trimmed.
 */
function resolvePrompt(options = {}) {
  const env = envOf(options);
  let text = oneLine(typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt : env.WHISPER_PROMPT);
  const terms = promptTerms(options);
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

/** Remember a dead key / empty balance so the next audio job and LLM ladders skip the rung. */
function rememberProviderRejection(provider, err, options = {}) {
  if (!provider || !provider.key) return;
  const ttlMs = providerCooldownMs(options);
  const env = envOf(options);
  keyHealth.markRejected(`${COOLDOWN_NAMESPACE}${provider.name}`, provider.key, err, {
    ...env,
    SIRAGPT_KEY_REJECT_MEMO_MS: String(ttlMs),
  });
  try {
    if (isBillingError(err)) {
      // eslint-disable-next-line global-require
      const billing = require('./ai/billing-failover');
      billing.markOutOfCredit(provider.name, err, { ...env, [provider.envName || 'OPENAI_API_KEY']: provider.key }, { ttlMs });
      keyHealth.markRejected(provider.name, provider.key, err, env, { reason: 'billing', ttlMs });
    } else if (isInvalidKeyError(err)) {
      keyHealth.markRejected(provider.name, provider.key, err, env, { reason: 'auth', ttlMs });
    }
  } catch (_) { /* advisory */ }
}

function providerInCooldown(provider) {
  return Boolean(provider && provider.key && keyHealth.isRejected(`${COOLDOWN_NAMESPACE}${provider.name}`, provider.key));
}

function clearTranscriptionCooldowns() {
  for (const name of COOLDOWN_PROVIDERS) {
    keyHealth.clear(`${COOLDOWN_NAMESPACE}${name}`);
    keyHealth.clear(name);
    try {
      // eslint-disable-next-line global-require
      require('./ai/billing-failover').clear(name);
    } catch (_) { /* optional */ }
  }
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

// The intake codes keep the «Transcripción no disponible» marker the RAG
// placeholder filter and the queue's hasTranscript already recognise.
const PLACEHOLDER_REASONS = Object.freeze({
  file_too_large: 'El archivo supera el tamaño máximo.',
  no_speech: 'No se detectó voz.',
  no_audio_track: 'Transcripción no disponible: el archivo no tiene pista de audio.',
  truncated_container: 'Transcripción no disponible: la grabación está incompleta (el archivo se cortó antes de terminar de guardarse).',
  drm_protected: 'Transcripción no disponible: el archivo está protegido (DRM) y su audio no se puede leer.',
});

function generatePlaceholder(fileName, label, mimeType, reasonCode) {
  const publicReason = PLACEHOLDER_REASONS[reasonCode] || 'Transcripción no disponible.';
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
  quality: report = null, refineSkipped = 0, refineSpans = null,
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
    ...(report ? { quality: report } : {}),
    ...(refineSkipped > 0 ? { refineSkipped } : {}),
    ...(Array.isArray(refineSpans) && refineSpans.length ? { refineSpans } : {}),
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
  return buildVoiceStudioRung(options);
}

/**
 * The options a Sira Voz request gets: options.voiceStudioTimeoutMs (the
 * dictation's sub-budget) bounds THAT request only — never whisper.cpp or a
 * cloud rung — so a busy or hung Sira Voz cannot eat a short request's bound.
 */
function voiceStudioCallOptions(options = {}) {
  const ms = Number(options.voiceStudioTimeoutMs);
  return Number.isFinite(ms) && ms > 0 ? { ...options, timeoutMs: Math.round(ms) } : options;
}

function buildVoiceStudioRung(options = {}) {
  let vsClient;
  try { vsClient = voiceStudioClient(options); } catch { return null; }
  if (!vsClient || typeof vsClient.isConfigured !== 'function' || !vsClient.isConfigured(options)) return null;
  return {
    name: 'voicestudio',
    kind: 'local',
    method: 'local-whisper',
    model: 'voicestudio-whisperx',
    key: null,
    transcribeFile: (filePath, mimeType, fileName, language, prompt, extra = {}) => vsClient.transcribe({
      filePath, filename: fileName, mime: mimeType, language, prompt, signal: extra.signal || options.signal,
    }, voiceStudioCallOptions(options)),
  };
}

const LOCAL_RUNG = Object.freeze({ name: 'local', kind: 'local', method: 'local-whisper', model: null, key: null });

function elevenLabsApiKey(options = {}) {
  return String(envOf(options).ELEVENLABS_API_KEY || '').trim();
}

/**
 * One request to ElevenLabs Scribe (@elevenlabs/elevenlabs-js): word timings
 * grouped into segments (xai-audio.segmentsFromPayload, audio events and
 * spacing dropped), word logprobs → segment confidence. Injectable through
 * options.elevenlabsClient ({ speechToText: { convert } }).
 */
async function transcribeWithElevenLabs({ filePath, mimeType, language, signal, timeoutMs, model, options = {} }) {
  const client = options.elevenlabsClient || (() => {
    const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
    return new ElevenLabsClient({ apiKey: elevenLabsApiKey(options) });
  })();
  const buffer = await fsPromises.readFile(filePath);
  const file = new Blob([buffer], { type: mimeType || CLIP_MASTER_MIME });
  const request = {
    file,
    modelId: model,
    tagAudioEvents: true,
    timestampsGranularity: 'word',
    diarize: false,
    ...(language ? { languageCode: language } : {}),
  };
  const body = await client.speechToText.convert(request, {
    ...(signal ? { abortSignal: signal } : {}),
    timeoutInSeconds: Math.max(30, Math.ceil((Number(timeoutMs) || 120_000) / 1000)),
    maxRetries: 0,
  });
  const words = Array.isArray(body?.words) ? body.words : [];
  const segments = require('./xai-audio').segmentsFromPayload({ words });
  let text = segments.map((s) => s.text).join(' ').trim();
  if (!text && !words.length && typeof body?.text === 'string') text = body.text.trim();
  return {
    text,
    segments,
    model,
    language: normalizeLanguage(body?.languageCode ?? body?.language_code) || null,
  };
}

/** Opt-in ElevenLabs Scribe rung (paid): never in the first-pass ladder. */
function elevenLabsRung(options = {}) {
  const env = envOf(options);
  if (String(env.TRANSCRIBE_ELEVENLABS_DISABLED || '') === '1') return null;
  const key = elevenLabsApiKey(options);
  if (!key && !options.elevenlabsClient) return null;
  const model = String(env.ELEVENLABS_STT_MODEL || '').trim() || DEFAULT_ELEVENLABS_STT_MODEL;
  return {
    name: 'elevenlabs',
    kind: 'cloud',
    method: 'whisper',
    model,
    caps: PLAIN_JSON_CAPS,
    verbose: false,
    key: key || 'injected',
    escalation: true,
    transcribeFile: (filePath, mimeType, _fileName, language, _prompt, extra = {}) => transcribeWithElevenLabs({
      filePath, mimeType, language, signal: extra.signal || options.signal, timeoutMs: extra.timeoutMs, model, options,
    }),
  };
}

/** TRANSCRIBE_ESCALATION_PROVIDERS (or options.escalationProviders): only the known opt-in names. */
function escalationProviderNames(options = {}) {
  const raw = options.escalationProviders ?? envOf(options).TRANSCRIBE_ESCALATION_PROVIDERS;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  const out = [];
  for (const item of list) {
    const name = String(item || '').trim().toLowerCase();
    if (ESCALATION_PROVIDER_NAMES.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Rungs used ONLY for flagged pieces (alternative hypotheses), in the order
 * listed. A rung already in the first-pass ladder is not repeated here.
 */
function escalationRungs(options = {}, ladder = []) {
  const taken = new Set((ladder || []).map((rung) => rung.name));
  const out = [];
  for (const name of escalationProviderNames(options)) {
    if (taken.has(name)) continue;
    const rung = name === 'voicestudio' ? buildVoiceStudioRung(options) : elevenLabsRung(options);
    if (rung) out.push({ ...rung, escalation: true });
  }
  return out;
}

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
 * Durable per-segment results. `options.checkpoint` ({ load, save, dir?, savedCutPlan? })
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

/** The cut plan a checkpoint entry was saved under, even one load ignores (optional checkpoint method), or null. */
async function savedCutPlanOf(options, index) {
  if (!options.checkpoint || typeof options.checkpoint.savedCutPlan !== 'function') return null;
  try {
    const hash = await options.checkpoint.savedCutPlan(index);
    return typeof hash === 'string' && hash ? hash : null;
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
      // Optional (parts written before the quality loop have neither): the
      // enhanced copy that produced the text, and the review record.
      ...(part?.variant ? { variant: String(part.variant).slice(0, 20) } : {}),
      ...(part?.review ? { review: compactReview(part.review) } : {}),
    });
  } catch { /* a missing checkpoint only costs a re-run of this segment */ }
}

/**
 * A bounded review record for the checkpoint. `done: false` (saved before
 * the review ran) makes a resumed job review that piece again instead of
 * re-transcribing it; a part without `review` predates the loop and is only
 * assessed for the report.
 */
function compactReview(review) {
  if (!review || typeof review !== 'object') return null;
  if (review.done !== true) return { v: 1, done: false };
  const spans = (Array.isArray(review.lowConfidence) ? review.lowConfidence : []).slice(0, 50).map((s) => ({
    start: round3(s.start), end: round3(s.end), reason: String(s.reason || 'low_confidence').slice(0, 40),
  }));
  return {
    v: 1,
    done: true,
    score: Number.isFinite(Number(review.score)) ? round3(review.score) : null,
    flags: (Array.isArray(review.flags) ? review.flags : []).slice(0, 8).map((f) => String(f).slice(0, 30)),
    escalations: Math.max(0, Math.min(20, Math.round(Number(review.escalations) || 0))),
    // Optional (records written before it have none): alternatives that answered.
    ...(review.alternatives != null && Number.isFinite(Number(review.alternatives))
      ? { alternatives: Math.max(0, Math.min(20, Math.round(Number(review.alternatives)))) }
      : {}),
    empty: review.empty === true,
    confirmedEmpty: review.confirmedEmpty === true,
    unconfirmedEmpty: review.unconfirmedEmpty === true,
    disagreement: review.disagreement === true,
    engine: review.engine ? String(review.engine).slice(0, 60) : null,
    engines: (Array.isArray(review.engines) ? review.engines : []).slice(0, 6).map((e) => String(e).slice(0, 60)),
    lowConfidence: spans,
  };
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
    // `stderr` (≤ 4 KB of ffmpeg diagnostics, never audio) lets the intake
    // tell a missing moov atom, DRM or a stream-less file from a generic failure.
    child.once('close', (code) => finish(code === 0 ? null : Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`), { code: 'SEGMENT_FAILED', exitCode: code, stderr })));
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

/** `silencedetect` filter for a threshold in dBFS (-35 → today's exact string). */
function silenceFilter(thresholdDb) {
  // Only a real number counts (null must never become «0 dB: everything is
  // silence»), and nothing above the adaptive ceiling.
  const db = typeof thresholdDb === 'number' && Number.isFinite(thresholdDb)
    ? Math.min(MAX_SILENCE_THRESHOLD_DB, Math.max(-90, Math.round(thresholdDb)))
    : DEFAULT_SILENCE_THRESHOLD_DB;
  return `silencedetect=noise=${db}dB:d=${SILENCE_MIN_SECONDS}`;
}

/** A valid stream ordinal (`-map 0:a:N`), or null. */
function streamOrdinalOf(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
  return Number.isInteger(n) && n >= 0 && n < 64 ? n : null;
}

function mapArgs(ordinal) {
  const n = streamOrdinalOf(ordinal);
  return n == null ? [] : ['-map', `0:a:${n}`];
}

/** Input options that go with mapArgs: media-probe's discovery window (see PROBE_WINDOW_ARGS). */
function mapWindowArgs(ordinal) {
  return streamOrdinalOf(ordinal) == null ? [] : [...PROBE_WINDOW_ARGS];
}

/**
 * One decode pass listing pauses; [] on any failure (cuts fall back to fixed
 * times). `options.silenceThresholdDb` (adaptive, see estimateSilenceThreshold)
 * and `options.silenceStreamOrdinal` (the chosen audio track) shape it.
 */
async function detectSilences(filePath, options = {}) {
  if (typeof options.detectSilences === 'function') return options.detectSilences(filePath, options);
  try {
    const { stderr } = await execImpl(options)(ffmpegBin(options), [
      '-hide_banner', '-nostats', '-nostdin', ...mapWindowArgs(options.silenceStreamOrdinal), '-i', filePath,
      ...mapArgs(options.silenceStreamOrdinal), '-vn', '-sn', '-dn', '-ac', '1',
      '-af', silenceFilter(options.silenceThresholdDb), '-f', 'null', '-',
    ], { timeout: segmentationTimeoutMs(options), maxBuffer: 32 * 1024 * 1024, signal: options.signal, env: mediaChildEnv() });
    return parseSilences(stderr);
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    return [];
  }
}

function adaptiveSilenceEnabled(options = {}) {
  return !/^(?:0|false|off|no)$/i.test(String(envOf(options).TRANSCRIBE_ADAPTIVE_SILENCE || '').trim());
}

/** Peak |sample| of each 50 ms frame of mono s16le PCM. Pure. */
function framePeaks(pcm, frameSamples = NOISE_FRAME_SAMPLES) {
  const buf = Buffer.isBuffer(pcm) ? pcm : (pcm instanceof Uint8Array ? Buffer.from(pcm) : null);
  if (!buf) return [];
  const samples = Math.floor(buf.length / 2);
  const out = [];
  for (let start = 0; start + frameSamples <= samples; start += frameSamples) {
    let peak = 0;
    for (let i = start; i < start + frameSamples; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    out.push(peak);
  }
  return out;
}

function peakToDb(peak) {
  return 20 * Math.log10(Math.max(1, Number(peak) || 0) / 32768);
}

function percentileOf(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

/**
 * Pure: frame peaks → silence threshold. The quiet frames' peak (10th
 * percentile) is the room; the loud frames' (90th) is the speech. The
 * threshold sits 8 dB over the room but never within 6 dB of the speech, and
 * is only ever RAISED from -35 dB (capped at -20 dB): a clean recording keeps
 * today's threshold, a café or a class with air conditioning gets pauses.
 */
function silenceThresholdFromPeaks(peaks) {
  const fallback = { thresholdDb: DEFAULT_SILENCE_THRESHOLD_DB, adaptive: false, noiseFloorDb: null, speechPeakDb: null };
  const list = (Array.isArray(peaks) ? peaks : []).filter((p) => Number.isFinite(p) && p >= 0);
  if (list.length < NOISE_MIN_FRAMES) return fallback;
  const sorted = list.slice().sort((a, b) => a - b);
  const floorDb = peakToDb(percentileOf(sorted, 0.1));
  const speechDb = peakToDb(percentileOf(sorted, 0.9));
  const raw = Math.min(floorDb + SILENCE_FLOOR_MARGIN_DB, speechDb - SILENCE_SPEECH_MARGIN_DB);
  const thresholdDb = Math.round(Math.min(MAX_SILENCE_THRESHOLD_DB, Math.max(DEFAULT_SILENCE_THRESHOLD_DB, raw)));
  return {
    thresholdDb,
    adaptive: thresholdDb !== DEFAULT_SILENCE_THRESHOLD_DB,
    noiseFloorDb: Math.round(floorDb * 10) / 10,
    speechPeakDb: Math.round(speechDb * 10) / 10,
  };
}

/**
 * Noise floor of a NEW cut plan, from a few short windows decoded with input
 * seeking (`-ss/-t`): five 12 s windows of a 5-hour file are seconds of work,
 * never a second full decode. Any failure keeps the -35 dB default. Never
 * throws except on abort. Injectable through options.estimateSilenceThreshold.
 */
async function estimateSilenceThreshold(filePath, ctx = {}, options = {}) {
  if (typeof options.estimateSilenceThreshold === 'function') return options.estimateSilenceThreshold(filePath, ctx, options);
  const fallback = { thresholdDb: DEFAULT_SILENCE_THRESHOLD_DB, adaptive: false, noiseFloorDb: null, speechPeakDb: null, windows: 0 };
  const duration = Number(ctx.durationSeconds) || 0;
  if (!adaptiveSilenceEnabled(options) || !(duration > 0)) return fallback;
  const count = Math.min(NOISE_SAMPLE_WINDOWS, Math.max(3, Math.floor(duration / 60)));
  const length = Math.max(1, Math.min(NOISE_SAMPLE_SECONDS, duration / count));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const deadline = now() + NOISE_SAMPLE_BUDGET_MS;
  const peaks = [];
  let windows = 0;
  for (let i = 0; i < count; i++) {
    throwIfAborted(options.signal);
    if (now() > deadline) break;
    const center = (duration * (i + 0.5)) / count;
    const start = Math.max(0, Math.min(duration - length, center - length / 2));
    try {
      const { stdout } = await execImpl(options)(ffmpegBin(options), [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        ...mapWindowArgs(ctx.audioStreamOrdinal), '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', filePath,
        ...mapArgs(ctx.audioStreamOrdinal), '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', SEGMENT_SAMPLE_RATE, '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
      ], {
        timeout: NOISE_SAMPLE_TIMEOUT_MS,
        maxBuffer: Math.ceil(length * Number(SEGMENT_SAMPLE_RATE) * 2) + 64 * 1024,
        encoding: 'buffer',
        signal: options.signal,
        env: mediaChildEnv(),
      });
      const framed = framePeaks(stdout);
      if (framed.length) { windows++; peaks.push(...framed); }
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      // A window that cannot be decoded only costs precision.
    }
  }
  return { ...silenceThresholdFromPeaks(peaks), windows };
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
 * What a failed ffmpeg/ffprobe run says about the MEDIA (not the host):
 *   'truncated_container' — no moov atom (phone died mid-recording);
 *   'drm_protected'       — FairPlay/Audible (by extension or diagnostics);
 *   'no_audio_track'      — nothing to map: the file has no audio stream;
 *   'stream_not_found'    — the requested `0:a:N` does not exist;
 *   'resource'            — disk full, out of memory, fork/file limits;
 *   'ffmpeg_missing'      — the binary is not installed;
 *   'timeout'             — the run hit its time budget;
 *   'spawn'               — ffmpeg could not start (not an ffmpeg verdict);
 *   'decode'              — anything else ffmpeg rejected.
 * Only reads ffmpeg diagnostics; never file contents.
 */
function classifyMediaFailure(err, fileName = '') {
  const code = String(err?.code || '');
  if (code === 'ENOENT') return 'ffmpeg_missing';
  if (code === 'SEGMENT_TIMEOUT') return 'timeout';
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  if (TRUNCATED_TEXT_RE.test(text)) return 'truncated_container';
  if (DRM_TEXT_RE.test(text)) return 'drm_protected';
  if (NO_STREAM_TEXT_RE.test(text)) return 'no_audio_track';
  if (STREAM_NOT_FOUND_TEXT_RE.test(text)) return 'stream_not_found';
  if (RESOURCE_TEXT_RE.test(text) || /^(?:ENOSPC|ENOMEM|EAGAIN|EMFILE|ENFILE)$/.test(code)) return 'resource';
  if (code !== 'SEGMENT_FAILED') return 'spawn';
  if (DRM_EXTENSION_RE.test(String(fileName || ''))) return 'drm_protected';
  return 'decode';
}

/** Error for an intake verdict that ends the job (placeholder with `intakeCode`). */
function intakeError(intakeCode, cause) {
  const err = new Error(`media intake: ${intakeCode}`);
  err.code = 'MEDIA_INTAKE';
  err.intakeCode = intakeCode;
  if (cause) err.cause = cause;
  return err;
}

async function clearSegmentFiles(dir) {
  const names = await fsPromises.readdir(dir).catch(() => []);
  await Promise.all(names
    .filter((n) => /^seg-\d+\.flac(?:\.(?:fix|merged)\.flac)?$/.test(n))
    .map((n) => fsPromises.rm(path.join(dir, n), { force: true }).catch(() => {})));
}

// What a STRICT pass may get wrong about the media and a tolerant pass (error
// tolerant, media-probe's wider window) can fix.
const RETRYABLE_DECODE_VERDICTS = new Set(['decode', 'stream_not_found', 'no_audio_track']);

/**
 * The decode ladder shared by the segment cut and the clip master. `run(mode)`
 * runs ONE ffmpeg pass, mode = { tolerant, map }:
 *   1. strict, mapping the chosen track (under media-probe's window);
 *   2. tolerant, STILL mapping the track — only when ffmpeg rejected the
 *      media: a decode error, a track it did not see («matches no streams»),
 *      or no stream at all («does not contain any stream»: audio that starts
 *      after the default window);
 *   3. tolerant WITHOUT the map — only when pass 2 still did not see the
 *      track; ffmpeg's default stream is used and `streamDropped` says so.
 * A missing moov atom or DRM is conclusive at once; «no audio stream» only
 * once a tolerant pass agrees. Resolves { decode, decodeCause, streamDropped }
 * (decodeCause: null | 'damaged' | 'stream_window'). Rejects with an abort
 * error, a MEDIA_INTAKE error (`intakeCode`), or the last ffmpeg error with
 * `strictVerdict` (pass 1's media verdict) attached. opts.strictVerdict skips
 * pass 1: a strict decode of this file already failed elsewhere that way.
 */
async function decodeLadder(run, { ordinal = null, fileName = '', signal, cleanup = async () => {}, strictVerdict = null } = {}) {
  const map = streamOrdinalOf(ordinal);
  const outcome = { decode: 'strict', decodeCause: null, streamDropped: false };
  let verdict = strictVerdict ? (RETRYABLE_DECODE_VERDICTS.has(strictVerdict) ? strictVerdict : 'decode') : null;
  if (!verdict) {
    let strictErr;
    try {
      await run({ tolerant: false, map });
      return outcome;
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      strictErr = err;
    }
    verdict = classifyMediaFailure(strictErr, fileName);
    if (verdict === 'truncated_container' || verdict === 'drm_protected') throw intakeError(verdict, strictErr);
    // A timeout, a full disk or a binary that cannot start would only repeat.
    if (strictErr?.code !== 'SEGMENT_FAILED' || !RETRYABLE_DECODE_VERDICTS.has(verdict)) throw strictErr;
  }
  const failWith = (err) => {
    if (err && typeof err === 'object') err.strictVerdict = verdict;
    return err;
  };
  outcome.decode = 'tolerant';
  outcome.decodeCause = verdict === 'decode' ? 'damaged' : 'stream_window';
  await cleanup();
  try {
    await run({ tolerant: true, map });
    return outcome;
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    const second = classifyMediaFailure(err, fileName);
    if (INTAKE_FATAL_CODES.has(second)) throw intakeError(second, err);
    if (second !== 'stream_not_found' || map == null) throw failWith(err);
  }
  await cleanup();
  outcome.streamDropped = true;
  try {
    await run({ tolerant: true, map: null });
    return outcome;
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    const third = classifyMediaFailure(err, fileName);
    if (INTAKE_FATAL_CODES.has(third)) throw intakeError(third, err);
    throw failWith(err);
  }
}

/**
 * Input options of one decode pass: tolerant flags (they carry the probe
 * window), or media-probe's window alone when a track is mapped.
 */
function decodeInputArgs({ tolerant, map }) {
  return tolerant ? [...TOLERANT_INPUT_ARGS] : mapWindowArgs(map);
}

/**
 * Cut `filePath` into FLAC 16 kHz mono pieces inside `dir` and measure them.
 * Returns [{ path, index, offsetSeconds, durationSeconds }].
 *
 * ctx.audioStreamOrdinal maps the chosen audio track (`-map 0:a:N`, under
 * media-probe's discovery window); without it ffmpeg picks its default stream
 * (today's behaviour). Silence snapping uses an adaptive threshold
 * (estimateSilenceThreshold). A cut ffmpeg rejects goes down decodeLadder
 * (tolerant with the track, then without it); a missing moov atom, DRM or a
 * file with no audio stream even in the wide window ends with an intake error.
 * When given, ctx.report receives { decode, decodeCause, silence, streamDropped }.
 */
async function cutAndMeasure(filePath, dir, ctx = {}, options = {}) {
  const S = ctx.segmentSeconds || segmentDuration(options);
  const duration = Number(ctx.durationSeconds) > 0 ? Number(ctx.durationSeconds) : 0;
  const scoped = { ...options, durationSeconds: duration };
  const ordinal = streamOrdinalOf(ctx.audioStreamOrdinal);
  const report = { decode: 'strict', decodeCause: null, silence: null, streamDropped: false };
  let cutTimes = null;
  if (duration > S) {
    let silences = [];
    if (silenceSnapEnabled(options) && duration > S * 1.2) {
      report.silence = await estimateSilenceThreshold(filePath, { durationSeconds: duration, audioStreamOrdinal: ordinal }, scoped);
      silences = await detectSilences(filePath, {
        ...scoped,
        silenceThresholdDb: report.silence?.thresholdDb,
        silenceStreamOrdinal: ordinal,
      });
    }
    cutTimes = planCutTimes(duration, S, silences);
  }
  const pattern = path.join(dir, 'seg-%04d.flac');
  const cutArgs = (mode) => [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...decodeInputArgs(mode),
    '-i', filePath,
    ...mapArgs(mode.map),
    '-vn', '-sn', '-dn',
    // Preserve pauses/discontinuities in the recording's timestamps. Without
    // this, FLAC packs the samples together and silently shifts later speech.
    '-af', 'aresample=async=1:first_pts=0',
    '-ac', '1', '-ar', SEGMENT_SAMPLE_RATE, '-c:a', 'flac',
    '-f', 'segment',
    ...(cutTimes && cutTimes.length ? ['-segment_times', cutTimes.join(',')] : ['-segment_time', String(S)]),
    '-reset_timestamps', '1',
    pattern,
  ];
  const ladder = await decodeLadder((mode) => runFfmpeg(cutArgs(mode), scoped), {
    ordinal, fileName: ctx.fileName, signal: options.signal, cleanup: () => clearSegmentFiles(dir),
  });
  Object.assign(report, ladder);
  if (ctx.report && typeof ctx.report === 'object') Object.assign(ctx.report, report);
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

/**
 * The audio track a plan's hash must name, or null. Only a file with several
 * audio streams (or an explicitly requested track) adds it: a single-stream
 * file — every plan cut before the track was chosen included — keeps the
 * original formula, so checkpoints of jobs in flight still match.
 */
function planStreamOf(audioStream) {
  if (!audioStream || typeof audioStream !== 'object') return null;
  const ordinal = streamOrdinalOf(audioStream.streamOrdinal);
  if (ordinal == null) return null;
  return audioStream.explicit === true || Number(audioStream.streams) > 1 ? ordinal : null;
}

/**
 * Identity of a cut: offsets + segment length (+ the audio track of a
 * multi-stream file). Parts are reused only within one plan. The formula for
 * a legacy plan without a track is unchanged: `{ v, s, o }`. New cuts also
 * name the preserved timestamp clock, since identical boundaries can contain
 * different audio when pauses were previously removed.
 */
function planOf(segments, segmentSeconds, audioStream = null, clock = null) {
  const offsets = segments.map((s) => Math.round((Number(s.offsetSeconds) || 0) * 1000));
  const fixed = segments.every((s, i) => Math.abs((Number(s.offsetSeconds) || 0) - i * segmentSeconds) <= 0.5);
  const track = planStreamOf(audioStream);
  const identity = track == null
    ? { v: MANIFEST_VERSION, s: segmentSeconds, o: offsets }
    : { v: MANIFEST_VERSION, s: segmentSeconds, o: offsets, a: track };
  if (clock === AUDIO_CLOCK) identity.clock = clock;
  const hash = crypto.createHash('sha1').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
  return { kind: fixed ? 'fixed' : 'snapped', hash, ...(clock === AUDIO_CLOCK ? { clock } : {}) };
}

/**
 * Optional manifest field (added after v1 shipped): { streamOrdinal, reason,
 * streams, explicit, dropped? } | null. `dropped: true` — ffmpeg never saw
 * that track, so the pieces hold its default stream.
 */
function manifestAudioStream(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    streamOrdinal: streamOrdinalOf(value.streamOrdinal),
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 40) : null,
    streams: Number.isInteger(value.streams) && value.streams >= 0 ? value.streams : null,
    explicit: value.explicit === true,
    ...(value.dropped === true ? { dropped: true } : {}),
  };
}

const DECODE_CAUSES = new Set(['damaged', 'stream_window']);

/** What a manifest (old ones: all null) tells about how its pieces were cut. */
function cutInfoOfManifest(manifest) {
  const audioStream = manifestAudioStream(manifest?.audioStream);
  const decode = manifest?.decode === 'tolerant' ? 'tolerant' : (manifest?.decode === 'strict' ? 'strict' : null);
  return {
    audioStream,
    decode,
    decodeCause: decode === 'tolerant' && DECODE_CAUSES.has(manifest?.decodeCause) ? manifest.decodeCause : null,
    silence: manifest?.silence && typeof manifest.silence === 'object' ? manifest.silence : null,
    streamDropped: audioStream?.dropped === true,
  };
}

function checkpointDirOf(options = {}) {
  const dir = options.checkpoint && options.checkpoint.dir;
  return typeof dir === 'string' && dir.trim() ? path.resolve(dir) : null;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function loadManifest(manifestPath, { segmentSeconds, sourceSize, audioStream = null }) {
  let manifest;
  try {
    manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.format !== 'flac') return null;
  if (manifest.segmentSeconds !== segmentSeconds || manifest.sourceSize !== sourceSize) return null;
  // A manifest that records its audio track is reused only for that track.
  // One written before tracks were recorded (no field) is reused untouched:
  // a job in flight across the deploy resumes, it never re-cuts.
  const recorded = manifestAudioStream(manifest.audioStream);
  const wanted = streamOrdinalOf(audioStream?.streamOrdinal);
  if (recorded && wanted != null && recorded.streamOrdinal !== wanted) return null;
  if (!recorded && wanted != null && audioStream?.explicit === true) return null;
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
  if (manifest.clock != null && manifest.clock !== AUDIO_CLOCK) return null;
  const plan = planOf(segments, segmentSeconds, recorded, manifest.clock);
  if (manifest.plan?.hash && manifest.plan.hash !== plan.hash) return null;
  return { manifest, segments, plan };
}

async function writeManifest(manifestPath, manifest) {
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(manifest));
  await fsPromises.rename(tmp, manifestPath);
}

/**
 * A decoder may exit successfully after reading only part of a damaged
 * recording. Successful STT for every emitted piece does not prove that the
 * whole audio was read. Compare measured pieces with the selected track's
 * duration before spending any STT calls. Unknown lengths are not evidence
 * of truncation; in particular, a video's length need not be its audio's.
 */
function assertDecodedAudioComplete(segments, expectedSeconds) {
  const expected = Number(expectedSeconds);
  if (!(expected > 0) || !Number.isFinite(expected) || !segments.length) return;
  if (!segments.every(segment => Number.isFinite(segment.durationSeconds) && segment.durationSeconds > 0)) return;
  const decoded = round3(segments.reduce((sum, segment) => sum + segment.durationSeconds, 0));
  // Packet boundaries, codec padding and accumulated millisecond rounding.
  // At ten hours the tolerance is 3.6 s, never an entire missing piece.
  const tolerance = Math.max(2, expected * 0.0001);
  if (decoded + tolerance >= expected) return;
  throw Object.assign(new Error('No se pudo leer todo el audio de la grabación.'), {
    code: 'audio_decode_incomplete', retryable: true,
    expectedDurationSeconds: round3(expected), decodedDurationSeconds: decoded,
  });
}

/** The duration whose audio was actually selected, not a longer video track. */
function expectedAudioDuration(intake, sourceDuration, { normalizedMime, fileName }) {
  const ordinal = intake.audioStream?.streamOrdinal;
  const stream = intake.probe?.audio?.find(item => item.streamOrdinal === ordinal);
  const duration = Number(stream?.durationSec);
  if (Number.isFinite(duration) && duration > 0) {
    // ffmpeg rebases input timestamps against the container's start. Keep
    // a late audio track's initial silence when video begins before it.
    const start = stream?.startTimeSec;
    const containerStart = intake.probe?.formatStartTimeSec;
    const lead = Number.isFinite(start) && Number.isFinite(containerStart)
      ? Math.max(0, start - containerStart) : 0;
    return duration + lead;
  }
  if (intake.probeOk && !intake.probe.hasVideo) return sourceDuration;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!intake.probeOk && /^audio\//.test(normalizedMime) && SINGLE_TRACK_AUDIO_EXTENSIONS.has(ext)) return sourceDuration;
  return null;
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
  // The track this job transcribes (identity, recorded in the manifest and in
  // a multi-stream plan's hash) and what to map on THIS source (null when the
  // source is the short-clip master, which only holds that track).
  const audioStream = manifestAudioStream(ctx.audioStream);
  const mapOrdinal = Object.prototype.hasOwnProperty.call(ctx, 'mapOrdinal')
    ? streamOrdinalOf(ctx.mapOrdinal)
    : (audioStream ? audioStream.streamOrdinal : null);
  if (typeof options.segmentAudio === 'function') {
    const out = await options.segmentAudio(filePath, options);
    const segments = (Array.isArray(out?.segments) ? out.segments : []).map((s, i) => ({
      path: s.path,
      index: Number.isInteger(s.index) ? s.index : i,
      offsetSeconds: Number(s.offsetSeconds) || 0,
      durationSeconds: Number.isFinite(Number(s.durationSeconds)) && Number(s.durationSeconds) > 0 ? Number(s.durationSeconds) : null,
    }));
    if (!segments.length) throw Object.assign(new Error('no segments'), { code: 'SEGMENT_EMPTY' });
    assertDecodedAudioComplete(segments, ctx.expectedAudioDurationSeconds);
    const dir = out?.dir || null;
    return {
      dir, persistent: Boolean(dir && checkpointDir && isInside(dir, checkpointDir)), segments, plan: planOf(segments, S),
      manifest: null, manifestPath: null,
      cutInfo: { audioStream: null, decode: null, decodeCause: null, silence: null, streamDropped: false, reused: false },
    };
  }
  const cutCtx = (report) => ({
    segmentSeconds: S, durationSeconds: ctx.durationSeconds, audioStreamOrdinal: mapOrdinal, fileName: ctx.fileName, report,
  });
  if (checkpointDir) {
    const dir = path.join(checkpointDir, 'audio');
    const manifestPath = path.join(dir, 'manifest.json');
    const reused = await loadManifest(manifestPath, { segmentSeconds: S, sourceSize: ctx.fileSize, audioStream });
    if (reused) {
      const info = cutInfoOfManifest(reused.manifest);
      let complete = true;
      try {
        // An old multi-track manifest cannot prove which audio it contains.
        const trackKnown = !ctx.audioStream || ctx.audioStream.streams === 1 || info.audioStream;
        if (!info.streamDropped && trackKnown) assertDecodedAudioComplete(reused.segments, ctx.expectedAudioDurationSeconds);
      } catch (err) {
        if (err?.code !== 'audio_decode_incomplete') throw err;
        complete = false; // Rebuild a shortened cached cut before retrying STT.
      }
      if (complete) return {
        dir, persistent: true, segments: reused.segments, plan: reused.plan, manifest: reused.manifest, manifestPath,
        reused: true, cutInfo: { ...info, reused: true },
      };
    }
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.mkdir(dir, { recursive: true });
    try {
      const report = {};
      const segments = await cutAndMeasure(filePath, dir, cutCtx(report), options);
      if (!report.streamDropped) assertDecodedAudioComplete(segments, ctx.expectedAudioDurationSeconds);
      const plan = planOf(segments, S, audioStream, AUDIO_CLOCK);
      const stat = await fsPromises.stat(filePath).catch(() => null);
      const manifest = {
        version: MANIFEST_VERSION,
        format: 'flac',
        clock: AUDIO_CLOCK,
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
        // Optional fields (absent from manifests written before them; their
        // absence means «ffmpeg's default track, strict decode, -35 dB»).
        audioStream: audioStream ? { ...audioStream, ...(report.streamDropped ? { dropped: true } : {}) } : null,
        decode: report.decode || 'strict',
        ...(report.decodeCause ? { decodeCause: report.decodeCause } : {}),
        silence: report.silence ? compactSilence(report.silence) : null,
      };
      await writeManifest(manifestPath, manifest);
      return { dir, persistent: true, segments, plan, manifest, manifestPath, cutInfo: { ...cutInfoOfManifest(manifest), reused: false } };
    } catch (err) {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-seg-'));
  try {
    const report = {};
    const segments = await cutAndMeasure(filePath, dir, cutCtx(report), options);
    if (!report.streamDropped) assertDecodedAudioComplete(segments, ctx.expectedAudioDurationSeconds);
    return {
      dir, persistent: false, segments, plan: planOf(segments, S, audioStream, AUDIO_CLOCK), manifest: null, manifestPath: null,
      cutInfo: {
        audioStream,
        decode: report.decode || 'strict',
        decodeCause: report.decodeCause || null,
        silence: report.silence ? compactSilence(report.silence) : null,
        streamDropped: report.streamDropped === true || audioStream?.dropped === true,
        reused: false,
      },
    };
  } catch (err) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function compactSilence(silence) {
  return {
    thresholdDb: Number.isFinite(silence?.thresholdDb) ? silence.thresholdDb : DEFAULT_SILENCE_THRESHOLD_DB,
    noiseFloorDb: Number.isFinite(silence?.noiseFloorDb) ? silence.noiseFloorDb : null,
    speechPeakDb: Number.isFinite(silence?.speechPeakDb) ? silence.speechPeakDb : null,
    adaptive: silence?.adaptive === true,
    windows: Number.isInteger(silence?.windows) ? silence.windows : 0,
  };
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
  throwIfAborted(signal);
  if (typeof provider.transcribeFile === 'function') {
    const start = () => {
      // Cancellation can arrive while this request waits for its dispatch turn.
      throwIfAborted(signal);
      return { p: provider.transcribeFile(filePath, mimeType, fileName, language, prompt, { signal, timeoutMs: call.timeoutMs, durationSeconds: call.durationSeconds }) };
    };
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
    throwIfAborted(signal);
    const fileBuffer = await fsPromises.readFile(filePath);
    // Stop during upload preparation must not dispatch an already-cancelled
    // request: a provider listening only for future abort events would hang.
    throwIfAborted(signal);
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
    throwIfAborted(signal);
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
      // Whisper's own hallucination signals (reviewed with the same engine only;
      // the stored segment keeps text, times and confidence).
      ...(s.no_speech_prob != null ? { no_speech_prob: s.no_speech_prob } : {}),
      ...(s.compression_ratio != null ? { compression_ratio: s.compression_ratio } : {}),
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

/**
 * 'dead' (pause the rung), 'rate_limit', 'transient', 'oom' (a SIGKILL we
 * did not send), 'language' (whisper-cli refused the `-l` value: retried once
 * with detection) or 'segment' (deterministic for THIS piece: no retry).
 */
function classifyRungError(rung, err) {
  if (rung.name === 'local') {
    if (localEngineMissing(err)) return 'dead';
    if (err?.code === 'AUDIO_DECODE_FAILED') return 'segment';
    const run = localRunError(err) || err;
    if (/unknown language|invalid language|unsupported language/i.test(String(run?.diagnostics || ''))) return 'language';
    if (run?.code === 'LOCAL_WHISPER_FAILED' && run?.signal === 'SIGKILL') return 'oom';
    // Timeout, crash, EAGAIN/ENOMEM, invalid/empty output: retried
    // (TRANSCRIBE_LOCAL_RETRIES), then backed off when it is the last rung.
    return 'transient';
  }
  if (isInvalidKeyError(err) || isBillingError(err)) return 'dead';
  if (isRateLimitError(err)) return 'rate_limit';
  if (rung.kind === 'local') return 'transient';
  if (isTransientProviderError(err)) return 'transient';
  return 'segment';
}

function describeRungError(rung, err) {
  if (rung.name === 'local') {
    const run = localRunError(err) || err;
    if (run?.code === 'LOCAL_WHISPER_FAILED' && run?.signal === 'SIGKILL') return 'oom';
    return String(err?.reason || err?.code || err?.message || 'failed').replace(/\s+/g, ' ').slice(0, 120);
  }
  return describeProviderError(err);
}

function gapReasonFor(error) {
  if (!error) return 'no_provider';
  const err = localRunError(error) || error;
  if (err.code === 'AUDIO_DECODE_FAILED') return 'audio_decode_failed';
  if (err.code === 'LOCAL_WHISPER_UNAVAILABLE') return 'local_unavailable';
  if (err.code === 'LOCAL_WHISPER_FAILED' && err.signal === 'SIGKILL') return 'local_unavailable';
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

/**
 * One request to one rung for one piece. `strategy` (alternative hypotheses
 * only): { noPrompt, audioFilter (local), maxContext (local), beamSize
 * (local) }. `segment.streamOrdinal` maps a track of an ORIGINAL file (short
 * clips without a master); FLAC pieces hold one stream and carry none.
 */
async function callRung(rung, segment, jc, language, strategy = null) {
  const { options, signal } = jc;
  const seconds = Number(segment.durationSeconds) || jc.segmentSeconds;
  const prompt = strategy?.noPrompt ? undefined : jc.prompt;
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
          prompt,
          durationSeconds: jc.mediaDurationSeconds,
          mediaDurationSeconds: jc.mediaDurationSeconds,
          segmentDurationSeconds: segment.durationSeconds || null,
          // A FLAC piece holds ONE stream: never map the source's track there.
          audioStreamOrdinal: streamOrdinalOf(segment.streamOrdinal) ?? undefined,
          ...(strategy?.audioFilter ? { audioFilter: strategy.audioFilter } : {}),
          ...(Number.isInteger(strategy?.maxContext) ? { maxContext: strategy.maxContext } : {}),
          ...(strategy?.beamSize ? { beamSize: strategy.beamSize } : {}),
        });
        return partFromOutput(out, rung, language);
      }
      const out = await rung.transcribeFile(segment.path, segment.mime, segment.name, language, prompt, { signal, durationSeconds: seconds });
      return partFromOutput(out, rung, language);
    } finally {
      jc.localPermits.release();
    }
  }
  let out;
  try {
    out = await transcribeCloudFile(rung, segment.path, segment.mime, segment.name, options, language, prompt, {
      signal,
      timeoutMs: cloudSegmentTimeoutMs(rung, seconds, options),
      maxRetries: 0,
      dispatch: jc.dispatch,
      durationSeconds: seconds,
    });
  } catch (err) {
    // xAI answers 200 with no text for a silent piece (waiting room, break)
    // and its client throws. That is a no-speech answer, as on every other
    // rung (then reviewed like one), not a failure that counts toward the streak.
    if (err?.code !== 'xai_stt_empty_transcript') throw err;
    out = { text: '', segments: [], model: rung.model };
  }
  return partFromOutput(out, rung, language);
}

// ── Rung state: pauses that end (no permanent latch) ────────────────────────

function newRungState() {
  return { deadUntil: 0, deadReason: null, revivals: 0, pausedUntil: 0, consecutiveFailures: 0, cooldownNoted: false };
}

function rungState(jc, rung) {
  if (!jc.state.has(rung.name)) jc.state.set(rung.name, newRungState());
  return jc.state.get(rung.name);
}

/**
 * Whether a rung can take a piece NOW. A cloud key in its cooldown is skipped
 * while the cooldown lasts (provider-key-health); a paused rung is revived
 * once its deadUntil has passed (the next piece probes it). `peek` reads
 * without side effects (no outcome token, no revival log).
 */
function rungAvailable(rung, jc, { peek = false } = {}) {
  const state = rungState(jc, rung);
  if (rung.kind === 'cloud' && providerInCooldown(rung)) {
    if (!peek && !state.cooldownNoted) {
      state.cooldownNoted = true;
      noteOutcome(jc, rung, 'cooldown');
    }
    return false;
  }
  if (state.deadUntil > jc.now()) return false;
  if (state.deadReason && !peek) {
    logOncePerJob(jc, `revive:${rung.name}:${state.revivals}`, `${rung.name} transcription: trying again after a pause (${state.deadReason})`);
    state.deadReason = null;
    state.deadUntil = 0;
    state.consecutiveFailures = 0;
  }
  return true;
}

function pauseRung(jc, rung, reason, untilMs) {
  const state = rungState(jc, rung);
  state.deadReason = String(reason || 'paused').slice(0, 80);
  state.deadUntil = untilMs;
}

function revivalDelayMs(state) {
  const delay = REVIVAL_DELAYS_MS[Math.min(state.revivals, REVIVAL_DELAYS_MS.length - 1)];
  state.revivals++;
  return delay;
}

/** No rung after `index` can take this piece: `index` is the last one left. */
function isLastLiveRung(jc, index) {
  for (let i = index + 1; i < jc.rungs.length; i++) {
    if (rungAvailable(jc.rungs[i], jc, { peek: true })) return false;
  }
  return true;
}

/**
 * One segment, every rung in order until one answers. Returns
 * { part, rungIndex } or { part: null, reason, error } (a gap).
 */
async function transcribeSegmentWithLadder(segment, jc, language) {
  let lastError = null;
  for (let index = 0; index < jc.rungs.length; index++) {
    const rung = jc.rungs[index];
    if (!rungAvailable(rung, jc)) continue;
    const state = rungState(jc, rung);
    let transientRetries = 0;
    let rateLimitWaits = 0;
    let backoffs = 0;
    let oomKills = 0;
    let lang = language;
    let languageRetried = false;
    for (;;) {
      throwIfAborted(jc.signal);
      const pause = state.pausedUntil - jc.now();
      if (pause > 0) await jc.sleep(pause, jc.signal);
      try {
        const part = await callRung(rung, segment, jc, lang);
        state.consecutiveFailures = 0;
        state.revivals = 0;
        return { part: { ...part, provider: rung.name, method: rung.method, kind: rung.kind }, rungIndex: index };
      } catch (err) {
        // Only the job's own signal cancels the job: a dropped socket reports
        // «Error: aborted» (ECONNRESET) and must stay a transient failure.
        if (jc.signal.aborted) throw err;
        lastError = err;
        const verdict = classifyRungError(rung, err);
        const token = describeRungError(rung, err);
        if (verdict === 'dead') {
          noteOutcome(jc, rung, token);
          if (rung.kind === 'cloud') {
            rememberProviderRejection(rung, err, jc.options);
            pauseRung(jc, rung, token, jc.now() + providerCooldownMs(jc.options));
            const what = isBillingError(err) ? 'has no credits' : 'rejected the key';
            logOncePerJob(jc, `dead:${rung.name}`, `${rung.name} transcription ${what} (${sanitizeProviderError(err)}); skipping it for ${Math.round(providerCooldownMs(jc.options) / 60000)} min; trying the next provider`);
          } else {
            // A missing engine (binary, model) does not come back by waiting.
            pauseRung(jc, rung, token, Infinity);
            logOncePerJob(jc, `dead:${rung.name}`, `${rung.name} transcription unavailable (${token}); the rest of this job skips it`);
          }
          break;
        }
        if (verdict === 'language' && lang && !languageRetried) {
          // whisper-cli refused the language code: detect it on this piece.
          languageRetried = true;
          lang = undefined;
          noteOutcome(jc, rung, 'language');
          continue;
        }
        if (verdict === 'rate_limit') {
          const hinted = parseRetryAfterMs(err, jc.now());
          if (hinted != null && hinted > jc.limits.rateLimitMaxWaitMs) {
            // «try again in 5h»: a quota for the day, not a throttle. Pause the
            // rung until then; never start the «no credits» cooldown.
            pauseRung(jc, rung, `${token} ${Math.round(hinted / 60000)}min`, jc.now() + hinted);
            noteOutcome(jc, rung, token);
            logOncePerJob(jc, `rate-dead:${rung.name}`, `${rung.name} transcription rate-limited for ${Math.round(hinted / 60000)} min; the next pieces use the next provider until then`);
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
        } else if (verdict === 'transient' || verdict === 'oom') {
          if (verdict === 'oom') oomKills++;
          const allowed = rung.kind === 'cloud' ? jc.limits.segmentRetries : jc.limits.localRetries;
          if (verdict === 'transient' && transientRetries < allowed) {
            transientRetries++;
            await jc.sleep(TRANSIENT_BACKOFF_BASE_MS * 3 ** (transientRetries - 1), jc.signal);
            continue;
          }
          // The last engine left for this piece backs off and retries (a
          // loaded host, a provider blip) within the job's wait budget. A
          // repeated OOM kill on the same piece is deterministic: no more.
          const wait = LAST_RUNG_BACKOFF_MS[backoffs];
          if (wait != null && (verdict !== 'oom' || oomKills < OOM_REPEAT_LIMIT)
            && isLastLiveRung(jc, index) && jc.waitBudget.remainingMs >= wait) {
            backoffs++;
            jc.waitBudget.remainingMs -= wait;
            noteOutcome(jc, rung, `${token} backoff`);
            logOncePerJob(jc, `backoff:${rung.name}`, `${rung.name} transcription failed (${sanitizeProviderError(err)}); it is the last engine left, waiting ${Math.round(wait / 1000)} s and retrying`);
            await jc.sleep(wait, jc.signal);
            continue;
          }
        }
        // Demote THIS segment to the next rung; the rung stays for the others.
        noteOutcome(jc, rung, token);
        state.consecutiveFailures++;
        // The streak pauses a rung — never the last one left (it would turn
        // every remaining piece of a 5-hour job into a gap).
        if (state.consecutiveFailures >= RUNG_MAX_CONSECUTIVE_FAILURES && !isLastLiveRung(jc, index)) {
          const delay = revivalDelayMs(state);
          pauseRung(jc, rung, `${token}×${state.consecutiveFailures}`, jc.now() + delay);
          logOncePerJob(jc, `streak:${rung.name}:${state.revivals}`, `${rung.name} transcription failed on ${state.consecutiveFailures} segments in a row (${sanitizeProviderError(err)}); pausing it for ${Math.round(delay / 60000)} min`);
        }
        break;
      }
    }
  }
  return { part: null, reason: gapReasonFor(lastError), error: lastError };
}

// ── Quality loop: evidence, alternative hypotheses, review ─────────────────

const filterMemo = new Map();
const injectedFilterMemo = new WeakMap();

/** Filter names from `ffmpeg -filters`. Pure. */
function parseFfmpegFilters(text) {
  const out = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*[A-Z.|]{2,4}\s+([a-z0-9_]+)\s+\S*->\S*/.exec(line);
    if (match) out.add(match[1]);
  }
  return out;
}

/**
 * The filters this ffmpeg has (`ffmpeg -filters`, read once per binary and
 * memoized; options.ffmpegFilters injects the list). Never throws: an
 * unreadable list is an empty set (no enhanced copies), with one WARN. Only a
 * listing that parsed, or a binary that is missing (ENOENT), is remembered
 * for the process; any other failure (timeout, EAGAIN under load) is probed
 * again after FILTER_LIST_RETRY_MS.
 */
async function ffmpegFilterSet(options = {}) {
  if (options.ffmpegFilters) return new Set(Array.from(options.ffmpegFilters, (name) => String(name)));
  const bin = ffmpegBin(options);
  const injected = typeof options.execFileImpl === 'function' ? options.execFileImpl : null;
  const memo = injected ? (injectedFilterMemo.get(injected) || new Map()) : filterMemo;
  if (injected && !injectedFilterMemo.has(injected)) injectedFilterMemo.set(injected, memo);
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const known = memo.get(bin);
  if (known && !(known.retryAt != null && clock() >= known.retryAt)) return known.pending;
  const entry = { pending: null, retryAt: null };
  entry.pending = (async () => {
    try {
      const { stdout } = await execImpl(options)(bin, ['-hide_banner', '-filters'], {
        timeout: FILTER_LIST_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: mediaChildEnv(),
      });
      const filters = parseFfmpegFilters(stdout);
      if (!filters.size) entry.retryAt = clock() + FILTER_LIST_RETRY_MS;
      return filters;
    } catch (err) {
      warnOnce(`ffmpeg-filters:${bin}`, 'could not list ffmpeg filters; enhanced-audio second opinions are off');
      if (err?.code !== 'ENOENT') entry.retryAt = clock() + FILTER_LIST_RETRY_MS;
      return new Set();
    }
  })();
  memo.set(bin, entry);
  return entry.pending;
}

/** Variant names this job can build (their filters exist), memoized per job. */
async function availableVariants(jc) {
  if (jc.variants) return jc.variants;
  if (!jc.variantsPending) {
    jc.variantsPending = ffmpegFilterSet(jc.options).then((filters) => {
      jc.variants = Object.entries(VARIANT_FILTERS).filter(([, spec]) => spec.needs.every((f) => filters.has(f))).map(([name]) => name);
      return jc.variants;
    }, () => { jc.variants = []; return jc.variants; });
  }
  return jc.variantsPending;
}

/**
 * An enhanced FLAC copy of a piece (or of a short clip) for a rung that
 * takes a file: `<tmp>/<piece name>` decoded with the variant's filter.
 * Returns { ok, path, dir } (the caller removes `dir`) or { ok: false }.
 * Never throws except on abort. Injectable: options.buildVariant.
 */
async function buildVariantFile(sourcePath, variant, ctx = {}, options = {}) {
  if (typeof options.buildVariant === 'function') return options.buildVariant(sourcePath, variant, ctx);
  const spec = VARIANT_FILTERS[variant];
  if (!spec) return { ok: false };
  let dir = null;
  try {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-variant-'));
  } catch {
    return { ok: false };
  }
  const name = /\.flac$/i.test(String(ctx.name || '')) ? path.basename(String(ctx.name)) : CLIP_MASTER_NAME;
  const out = path.join(dir, name);
  const ordinal = streamOrdinalOf(ctx.streamOrdinal);
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...mapWindowArgs(ordinal), '-i', sourcePath, ...mapArgs(ordinal),
      '-vn', '-sn', '-dn', '-af', spec.filter,
      '-ac', '1', '-ar', SEGMENT_SAMPLE_RATE, '-c:a', 'flac', out,
    ], { ...options, segmentTimeoutMs: Math.max(60_000, Math.ceil((Number(ctx.durationSeconds) || 600) * 300)) });
    const stat = await fsPromises.stat(out).catch(() => null);
    if (!stat || !stat.size) {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ok: false };
    }
    return { ok: true, path: out, dir };
  } catch (err) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (isAbortError(err, options.signal)) throw err;
    return { ok: false };
  }
}

/**
 * Voiced seconds of one piece above `thresholdDb`: ONE decode of that piece
 * only (≤ a segment), and only for a suspicious answer — never a second full
 * decode of the recording. Two thresholds: an empty answer is checked for ANY
 * sound (quality.ENERGY_THRESHOLD_DB, -50 dB: a quiet far-field voice
 * counts); a sparse answer or a hole is checked against the job's speech
 * threshold (the cut plan's adaptive one, else -35 dB), so a classroom's air
 * conditioning is not taken for skipped speech. Returns { voicedSec,
 * silences } (null voicedSec: unknown). Injectable: options.measureVoiced(path,
 * ctx) → { voicedSec, silences? } (ctx.thresholdDb says which).
 */
async function measurePieceEnergy(segment, jc, { thresholdDb = quality.ENERGY_THRESHOLD_DB } = {}) {
  const threshold = Math.round(Number(thresholdDb) || quality.ENERGY_THRESHOLD_DB);
  const key = `${segment.index}:${segment.path}:${threshold}`;
  if (jc.energy.has(key)) return jc.energy.get(key);
  const duration = Number(segment.durationSeconds) || Number(segment.spanSeconds) || 0;
  let measured = { voicedSec: null, silences: null };
  try {
    let out;
    if (typeof jc.options.measureVoiced === 'function') {
      out = await jc.options.measureVoiced(segment.path, {
        durationSeconds: duration, index: segment.index, streamOrdinal: segment.streamOrdinal ?? null, thresholdDb: threshold, signal: jc.signal,
      });
    } else if (duration > 0) {
      const ordinal = streamOrdinalOf(segment.streamOrdinal);
      const { stderr } = await execImpl(jc.options)(ffmpegBin(jc.options), [
        '-hide_banner', '-nostats', '-nostdin', ...mapWindowArgs(ordinal), '-i', segment.path, ...mapArgs(ordinal),
        '-vn', '-sn', '-dn', '-ac', '1', '-af', `silencedetect=noise=${threshold}dB:d=${SILENCE_MIN_SECONDS}`,
        '-f', 'null', '-',
      ], {
        timeout: Math.max(ENERGY_MEASURE_TIMEOUT_MS, Math.ceil(duration * 100)),
        maxBuffer: 4 * 1024 * 1024, signal: jc.signal, env: mediaChildEnv(),
      });
      out = quality.voicedFromSilencedetect(stderr, duration);
    }
    const voiced = Number(out?.voicedSec);
    if (out && out.voicedSec != null && Number.isFinite(voiced) && voiced >= 0) {
      measured = { voicedSec: voiced, silences: Array.isArray(out.silences) ? out.silences : null };
    }
  } catch (err) {
    if (isAbortError(err, jc.signal)) throw err;
  }
  jc.energy.set(key, measured);
  return measured;
}

function engineLabelOf(part) {
  const provider = part?.provider || inferProvider(part);
  const model = part?.model ? `:${String(part.model).slice(0, 40)}` : '';
  return `${provider}${model}${part?.variant ? `+${part.variant}` : ''}`.slice(0, 60);
}

function engineKeyOf(part) {
  return `${part?.provider || inferProvider(part)}:${part?.model || ''}`;
}

function qualityLoopEnabled(options = {}) {
  if (options.qualityLoop === false) return false;
  return !/^(?:0|false|off|no)$/i.test(String(envOf(options).TRANSCRIBE_QUALITY_LOOP || '').trim());
}

/**
 * The job-wide quality state shared by every piece: budgets, the escalation
 * rungs, the prompt-echo index and the per-piece energy cache.
 */
function qualityState(options, { mediaSeconds = 0, pieces = 1 } = {}) {
  const ratio = envNumber(options, 'TRANSCRIBE_ESCALATION_BUDGET_RATIO', DEFAULT_ESCALATION_BUDGET_RATIO, { min: 0, max: 2, integer: false });
  return {
    enabled: qualityLoopEnabled(options),
    perPiece: envNumber(options, 'TRANSCRIBE_ESCALATION_MAX_PER_PIECE', DEFAULT_ESCALATIONS_PER_PIECE, { min: 0, max: 4 }),
    budgetSec: Math.max(ESCALATION_MIN_BUDGET_SEC, ratio * (Number(mediaSeconds) || 0)),
    usedSec: 0,
    attempts: 0,
    secondOpinions: { allowance: Math.max(4, Math.ceil(pieces * 0.25)), used: 0, possible: 0, agreedEmpty: 0, foundSpeech: 0 },
    // What the recogniser is primed with: the terms and the free-text prompt.
    promptIndex: quality.buildPromptIndex([
      ...promptTerms(options),
      oneLine(typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt : envOf(options).WHISPER_PROMPT),
    ].filter(Boolean)),
  };
}

/**
 * Alternative hypotheses for a flagged piece, in the order to try them.
 *   second opinion (nothing said): the next live rungs (another engine),
 *     then the SAME rung on the enhanced copy, then the escalation rungs;
 *   echo (the text only repeats the prompt): the same rung WITHOUT the
 *     prompt, then the others;
 *   loop: whisper.cpp again with no text context (-mc 0, beam 5), then the
 *     escalation rungs, then the next rungs;
 *   quality / refine: the escalation rungs, the next rungs, a wider beam on
 *     local, then the enhanced copy.
 */
async function reviewPlan(jc, producerIndex, mode) {
  const producer = producerIndex >= 0 ? jc.rungs[producerIndex] : null;
  const others = jc.rungs.slice(Math.max(0, producerIndex + 1)).filter((rung) => !producer || rung.name !== producer.name);
  const escalation = (jc.escalationRungs || []).filter((rung) => !producer || rung.name !== producer.name);
  const variants = producer ? await availableVariants(jc) : [];
  const enhanced = producer ? variants.map((variant) => ({ rung: producer, variant, noPrompt: mode === 'echo' })) : [];
  const steps = [];
  const add = (step) => { if (step && step.rung) steps.push(step); };
  if (mode === 'second_opinion' || mode === 'echo') {
    if (mode === 'echo' && producer && jc.prompt) add({ rung: producer, noPrompt: true });
    others.forEach((rung) => add({ rung, noPrompt: mode === 'echo' }));
    add(enhanced[0]);
    escalation.forEach((rung) => add({ rung, noPrompt: mode === 'echo' }));
  } else if (mode === 'loop') {
    if (producer?.name === 'local') add({ rung: producer, maxContext: 0, beamSize: 5, noPrompt: true });
    escalation.forEach((rung) => add({ rung }));
    others.forEach((rung) => add({ rung }));
    add(enhanced[0]);
  } else {
    escalation.forEach((rung) => add({ rung }));
    others.forEach((rung) => add({ rung }));
    if (producer?.name === 'local' && mode === 'refine') add({ rung: producer, beamSize: 5 });
    enhanced.forEach(add);
  }
  return steps;
}

/**
 * One alternative hypothesis: one attempt, no waiting on rate limits. A dead
 * key / empty balance updates the rung like the ladder does. Returns
 * { part } | { error } | { skipped: true }.
 */
async function obtainHypothesis(step, segment, jc, language) {
  const { rung } = step;
  if (!rungAvailable(rung, jc)) return { skipped: true };
  let target = segment;
  let tempDir = null;
  const strategy = { noPrompt: step.noPrompt === true, maxContext: step.maxContext, beamSize: step.beamSize };
  if (step.variant) {
    const spec = VARIANT_FILTERS[step.variant];
    if (!spec) return { skipped: true };
    if (rung.name === 'local') {
      strategy.audioFilter = spec.filter;
    } else {
      const built = await buildVariantFile(segment.path, step.variant, {
        name: segment.name, durationSeconds: segment.durationSeconds, streamOrdinal: segment.streamOrdinal,
      }, { ...jc.options, signal: jc.signal });
      if (!built?.ok) return { skipped: true };
      tempDir = built.dir || null;
      // Named after the FLAC that was built («audio.flac» / «segment-N.flac»),
      // never the uploaded container's name: providers read the format from it.
      target = { ...segment, path: built.path, name: path.basename(built.path), mime: CLIP_MASTER_MIME, streamOrdinal: null };
    }
  }
  // A cloud blip (5xx, dropped socket, timeout) gets ONE more try: a second
  // opinion that fails once must not decide a «nothing heard» verdict.
  const transientRetries = rung.kind === 'cloud' ? Math.min(REVIEW_TRANSIENT_RETRIES, jc.limits.segmentRetries) : 0;
  let retried = 0;
  try {
    for (;;) {
      try {
        const part = await callRung(rung, target, jc, language, strategy);
        rungState(jc, rung).consecutiveFailures = 0;
        return { part: { ...part, provider: rung.name, method: rung.method, kind: rung.kind, ...(step.variant ? { variant: step.variant } : {}) } };
      } catch (err) {
        if (jc.signal.aborted) throw err;
        const verdict = classifyRungError(rung, err);
        const token = describeRungError(rung, err);
        if (verdict === 'transient' && retried < transientRetries) {
          retried++;
          noteOutcome(jc, rung, `review ${token} retry`);
          await jc.sleep(TRANSIENT_BACKOFF_BASE_MS, jc.signal);
          continue;
        }
        noteOutcome(jc, rung, `review ${token}`);
        if (verdict === 'dead') {
          if (rung.kind === 'cloud') {
            rememberProviderRejection(rung, err, jc.options);
            pauseRung(jc, rung, token, jc.now() + providerCooldownMs(jc.options));
          } else {
            pauseRung(jc, rung, token, Infinity);
          }
        } else if (verdict === 'rate_limit') {
          const hinted = parseRetryAfterMs(err, jc.now());
          if (hinted != null) rungState(jc, rung).pausedUntil = Math.max(rungState(jc, rung).pausedUntil, jc.now() + Math.min(hinted, jc.limits.rateLimitMaxWaitMs));
        }
        return { error: err };
      }
    }
  } finally {
    if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function stopReview(mode, candidates) {
  const latest = candidates[candidates.length - 1];
  if (mode === 'second_opinion') return true;
  if (!latest || quality.isHard(latest.assessment)) return false;
  if (mode === 'echo' || mode === 'loop') return true;
  const original = candidates[0];
  if (quality.isHard(original.assessment)) return true;
  const agree = candidates.slice(0, -1).some((c) => !quality.isHard(c.assessment)
    && quality.wordAgreement(c.assessment.speechText, latest.assessment.speechText) >= quality.AGREEMENT_OK);
  // Engine-agnostic scores only (no logprob across engines).
  return agree || latest.assessment.agnosticScore - original.assessment.agnosticScore >= 0.25;
}

function wholeSpan(duration, reason) {
  const end = Number(duration) > 0 ? Number(duration) : 0;
  return { start: 0, end, reason };
}

/**
 * A kept answer the review judged to say nothing (confirmed by a second
 * opinion, trusted, or over measured silence): the words an engine invents
 * over silence (sign-offs, prompt echo) are dropped so the transcript never
 * carries text the engine itself judged to be no speech. Non-speech
 * annotations («[Música]») stay: they describe the piece honestly.
 */
function withoutInventedText(part, promptIndex) {
  const segments = Array.isArray(part?.segments) ? part.segments : [];
  if (segments.length) {
    const kept = segments.filter((seg) => quality.classifySegment(seg, promptIndex) === 'annotation');
    return { ...part, text: kept.map((seg) => String(seg.text || '').trim()).filter(Boolean).join(' '), segments: kept };
  }
  const text = String(part?.text || '').trim();
  return { ...part, text: quality.isNonSpeechText(text) ? text : '', segments: [] };
}

/**
 * Review one piece's first answer (contract C4). Returns { part } — the kept
 * hypothesis with `part.review` (piece-relative lowConfidence spans) — or
 * { gap: { reason }, error } when a «nothing heard» answer could not be
 * checked: second opinions were asked and none answered (a piece with speech
 * energy, or a check C4 requires), or the job's second-opinion allowance is
 * spent on a piece with speech energy. A gap leaves the piece's `review: {
 * done: false }` checkpoint, so the partial retry reviews only that piece.
 *   opts: { producerIndex, forced (refine), alwaysSecondOpinion (short clip:
 *   no_speech needs a second opinion whatever the energy), forceSecondOpinion
 *   (the whole recording's «no voice anywhere» check) }
 */
async function reviewPiece(segment, part, jc, language, opts = {}) {
  const q = jc.quality;
  const duration = Number(segment.durationSeconds) || Number(segment.spanSeconds) || null;
  const timedFirst = normalizeSegments(part.segments).length > 0;
  const assessOf = (p, evidence) => quality.assessHypothesis({
    text: p.text, segments: p.segments, durationSec: duration, voicedSec: evidence.voicedSec, silences: evidence.silences,
    promptIndex: q.promptIndex,
  });
  let evidence = { voicedSec: null, silences: null };
  let assessment = assessOf(part, evidence);
  if (q.enabled && assessment.needsEnergy && !opts.alwaysSecondOpinion) {
    const nothing = quality.saysNothing(assessment) || assessment.suspectOnly;
    evidence = await measurePieceEnergy(segment, jc, { thresholdDb: nothing ? quality.ENERGY_THRESHOLD_DB : jc.speechThresholdDb });
    assessment = assessOf(part, evidence);
  }
  const label = engineLabelOf(part);
  const record = {
    done: true, score: assessment.score, flags: assessment.flags.slice(), escalations: 0, alternatives: 0, empty: quality.saysNothing(assessment),
    confirmedEmpty: false, unconfirmedEmpty: false, disagreement: false, engine: label, engines: [label],
    lowConfidence: assessment.spans.slice(),
  };
  const finish = (chosenPart, rec) => ({ part: { ...chosenPart, review: rec } });
  if (!q.enabled) return finish(part, record);

  const silent = assessment.voicedSec != null && assessment.voicedSec < quality.SILENT_VOICED_SEC;
  const energetic = assessment.voicedSec != null && assessment.voicedSec >= quality.ENERGY_VOICED_SEC;
  const opinions = q.secondOpinions;
  const insisted = Boolean(opts.forceSecondOpinion || opts.alwaysSecondOpinion || opts.forced);
  // C4: this «nothing heard» may only stand once a second opinion agrees
  // (the short clip; the whole recording's last check).
  const opinionRequired = Boolean(opts.forceSecondOpinion || opts.alwaysSecondOpinion);
  // Several second opinions already agreed that this job's empty answers are
  // music / noise, and none found speech: the rest are trusted as such.
  const trustEmpty = !insisted && opinions.agreedEmpty >= SECOND_OPINION_TRUST_AFTER && opinions.foundSpeech === 0;
  const dropEnergyFlags = (rec) => {
    rec.flags = rec.flags.filter((f) => f !== 'empty_with_energy' && f !== 'hallucination');
    rec.score = quality.scoreFromFlags(rec.flags);
  };
  // Past the allowance, second opinions in this job keep finding speech under
  // empty answers: an empty piece with sound is still asked about (bounded by
  // the escalation budget), never covered unread.
  let overAllowance = false;
  let mode = null;
  if (record.empty) {
    if (silent && !insisted) {
      // Measured silence: nothing to ask about.
      return finish(withoutInventedText(part, q.promptIndex), record);
    } else if (trustEmpty) {
      dropEnergyFlags(record);
      return finish(withoutInventedText(part, q.promptIndex), record);
    } else if (insisted || opinions.used < opinions.allowance) {
      mode = assessment.hardOnly && assessment.kinds.echo > 0 ? 'echo' : 'second_opinion';
    } else if (energetic && opinions.foundSpeech > 0) {
      mode = assessment.hardOnly && assessment.kinds.echo > 0 ? 'echo' : 'second_opinion';
      overAllowance = true;
    } else if (energetic && opinions.possible > 0) {
      // Sound, no recognised voice, and the job's second-opinion allowance is
      // spent without trust (C4: empty text over speech energy is retried,
      // never counted as covered). A gap the partial retry reviews again.
      logOncePerJob(jc, 'second-opinion-allowance', 'second-opinion allowance spent; empty pieces with sound are left for the retry');
      return { gap: { reason: 'provider_error' }, error: null };
    } else if (energetic) {
      // No second opinion exists in this job (one engine, no enhanced copy):
      // a retry would not change it. Sound with no recognised voice.
      record.unconfirmedEmpty = true;
      record.lowConfidence.push(wholeSpan(duration, 'quiet'));
      record.flags.push('quiet');
      record.score = quality.scoreFromFlags(record.flags);
    }
  } else if (assessment.flags.includes('loop')) {
    mode = 'loop';
  } else if (opts.forced) {
    mode = 'refine';
  } else if (assessment.flags.includes('suspect')) {
    if (opinions.used < opinions.allowance) mode = 'second_opinion';
  } else if (quality.needsReview(assessment)) {
    mode = 'quality';
  }
  if (!mode) return finish(part, record);
  const budgeted = overAllowance || !(mode === 'second_opinion' || mode === 'echo' || opts.forced);
  // TRANSCRIBE_ESCALATION_MAX_PER_PIECE=0: quality escalations off (second
  // opinions on «nothing heard» and a requested refine still get one).
  const maxAttempts = budgeted && !overAllowance ? q.perPiece : Math.max(1, q.perPiece);
  if (maxAttempts <= 0) return finish(part, record);
  const seconds = Number(duration) || jc.segmentSeconds || 0;
  if (budgeted && q.usedSec + seconds > q.budgetSec) {
    // Out of escalation budget. An empty piece with sound that second
    // opinions elsewhere showed to hide speech is left for the retry.
    if (overAllowance) return { gap: { reason: 'provider_error' }, error: null };
    return finish(part, record);
  }
  if (mode === 'second_opinion' || mode === 'echo') opinions.used++;

  const steps = await reviewPlan(jc, Number.isInteger(opts.producerIndex) ? opts.producerIndex : jc.rungs.findIndex((r) => r.name === part.provider), mode);
  // A second opinion exists in this job (another rung or an enhanced copy).
  if ((mode === 'second_opinion' || mode === 'echo') && steps.length) opinions.possible++;
  const candidates = [{ part, assessment, order: 0, engineKey: engineKeyOf(part) }];
  let attempts = 0;
  let lastError = null;
  for (const step of steps) {
    if (attempts >= maxAttempts) break;
    if (budgeted && q.usedSec + seconds > q.budgetSec) break;
    throwIfAborted(jc.signal);
    const hypothesis = await obtainHypothesis(step, segment, jc, language);
    if (hypothesis.skipped) continue;
    attempts++;
    q.attempts++;
    q.usedSec += seconds;
    if (hypothesis.error) { lastError = hypothesis.error; continue; }
    candidates.push({ part: hypothesis.part, assessment: assessOf(hypothesis.part, evidence), order: candidates.length, engineKey: engineKeyOf(hypothesis.part) });
    if (stopReview(mode, candidates)) break;
  }
  record.escalations = attempts;
  // Alternative hypotheses that ANSWERED (escalations also counts failed attempts).
  record.alternatives = candidates.length - 1;
  record.engines = [...new Set(candidates.map((c) => engineLabelOf(c.part)))].slice(0, 6);
  if (candidates.length === 1) {
    // No other opinion could be had.
    if (record.empty) {
      if ((attempts > 0 && (energetic || opinionRequired)) || overAllowance) {
        // An empty answer, second opinions were asked and none answered (on
        // a piece with sound, or where C4 requires one): not «covered» and
        // not «no speech» — a gap the retry can fill later.
        return { gap: { reason: lastError ? gapReasonFor(lastError) : 'provider_error' }, error: lastError };
      }
      if (!steps.length) logOncePerJob(jc, 'no-second-opinion', 'no second opinion available for an empty answer (single engine, no enhanced copy); keeping it');
      if (energetic) {
        record.unconfirmedEmpty = true;
        record.lowConfidence.push(wholeSpan(duration, 'quiet'));
        if (!record.flags.includes('quiet')) record.flags.push('quiet');
        record.score = quality.scoreFromFlags(record.flags);
      }
    }
    return finish(part, record);
  }
  const choice = quality.chooseHypothesis(candidates);
  if (record.empty && silent && !quality.saysNothing(choice.chosen?.assessment) && !(choice.agreement >= quality.AGREEMENT_OK)) {
    // The first answer heard nothing and the piece is measured silent: ONE
    // alternative's text there (an amplified copy of the room tone is where
    // Whisper invents phrases) is not adopted unless another one reads the
    // same words. The energy and the empty answer agree: no voice.
    logOncePerJob(jc, 'silent-uncorroborated', 'an alternative read text over a measured-silent piece with no agreement; kept «no speech»');
    return finish(withoutInventedText(part, q.promptIndex), { ...record, confirmedEmpty: true });
  }
  const chosen = choice.chosen || candidates[0];
  const chosenAssessment = chosen.assessment;
  const out = {
    ...record,
    score: chosenAssessment.score,
    flags: chosenAssessment.flags.slice(),
    empty: quality.saysNothing(chosenAssessment),
    engine: engineLabelOf(chosen.part),
    lowConfidence: chosenAssessment.spans.slice(),
  };
  if (out.empty) {
    if (choice.confirmedEmpty) {
      // Two engines agree there is no voice: music / noise, not a doubt.
      out.confirmedEmpty = true;
      opinions.agreedEmpty++;
      dropEnergyFlags(out);
    } else if (energetic) {
      out.unconfirmedEmpty = true;
      out.lowConfidence.push(wholeSpan(duration, 'quiet'));
    }
  } else if (record.empty) {
    // The first engine heard nothing, another one heard speech.
    opinions.foundSpeech++;
  }
  if (choice.agreement != null && choice.agreement >= quality.AGREEMENT_OK) {
    // Two engines read the same words: a lone suspect phrase or an engine's
    // own low confidence is confirmed, not doubtful.
    out.flags = out.flags.filter((f) => f !== 'suspect' && f !== 'low_confidence');
    out.lowConfidence = out.lowConfidence.filter((span) => span.flag !== 'suspect');
  }
  if (choice.disagreement) {
    out.disagreement = true;
    if (!out.flags.includes('engine_disagreement')) out.flags.push('engine_disagreement');
    out.lowConfidence.push(wholeSpan(duration, 'engine_disagreement'));
  }
  // A keeper without timestamps (json-only engine) replacing a timed answer:
  // its times are one coarse block, said so instead of passed as exact.
  if (!out.empty && timedFirst && !normalizeSegments(chosen.part.segments).length && Number(duration) > 30) {
    out.lowConfidence.push(wholeSpan(duration, 'timestamps'));
    if (!out.flags.includes('timestamps')) out.flags.push('timestamps');
  }
  if (out.unconfirmedEmpty && !out.flags.includes('quiet')) out.flags.push('quiet');
  out.score = quality.scoreFromFlags(out.flags);
  // Confirmed «no voice»: whatever the kept hypothesis invented is dropped.
  return finish(out.confirmedEmpty ? withoutInventedText(chosen.part, q.promptIndex) : chosen.part, out);
}

/**
 * Whether a review got at least one alternative hypothesis that answered.
 * Records saved before `alternatives` existed fall back to the attempts.
 */
function reviewAnswered(review) {
  if (!review) return false;
  const answered = Number(review.alternatives);
  if (review.alternatives != null && Number.isFinite(answered)) return answered > 0;
  return Number(review.escalations) > 0;
}

/**
 * Quality numbers of a finished piece for the report: its review record, or
 * (a part checkpointed before the loop existed) a pure assessment.
 */
function pieceQuality(part, length, promptIndex) {
  const review = part?.review && part.review.done === true ? part.review : null;
  if (review) {
    return {
      score: Number.isFinite(Number(review.score)) ? Number(review.score) : 1,
      spans: Array.isArray(review.lowConfidence) ? review.lowConfidence : [],
      empty: review.empty === true,
      reviewed: reviewAnswered(review),
      disagreement: review.disagreement === true,
      confirmedEmpty: review.confirmedEmpty === true,
      unconfirmedEmpty: review.unconfirmedEmpty === true,
      engine: review.engine || engineLabelOf(part),
      escalations: Math.max(0, Number(review.escalations) || 0),
    };
  }
  const assessment = quality.assessHypothesis({ text: part?.text, segments: part?.segments, durationSec: length, promptIndex });
  return {
    score: assessment.score,
    spans: assessment.spans,
    empty: quality.saysNothing(assessment),
    reviewed: false,
    disagreement: false,
    confirmedEmpty: false,
    unconfirmedEmpty: false,
    engine: engineLabelOf(part),
    escalations: 0,
  };
}

function isBasicLocalModel(model) {
  return /(?:^|[-_/])base(?:[-_.]|$)|ggml-base/i.test(String(model || '')) || !model;
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

/** A checkpointed part cut by another plan (or a legacy fixed-cut part on a snapped plan). */
function cutByOtherPlan(part, plan) {
  if (!part || typeof part !== 'object') return false;
  return part.cutPlan ? part.cutPlan !== plan.hash : plan.kind !== 'fixed' || Boolean(plan.clock);
}

/** A checkpointed part is reused only within the same cut plan and language. */
function partUsable(part, plan, language) {
  if (!part || typeof part !== 'object') return false;
  if (part.cutPlan) {
    if (part.cutPlan !== plan.hash) return false;
  } else if (plan.kind !== 'fixed' || plan.clock) {
    return false; // legacy parts cannot prove matching snapped boundaries or the preserved audio clock
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

function withoutReview(part) {
  const copy = { ...part };
  delete copy.review;
  return copy;
}

/** options.range + options.forceRetranscribe === true → { start, end } (seconds, file clock), else null. */
function refineWindow(options = {}) {
  if (options.forceRetranscribe !== true || !options.range || typeof options.range !== 'object') return null;
  const start = Number(options.range.start);
  const end = Number(options.range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { start, end };
}

function hasConfidence(segments) {
  return (Array.isArray(segments) ? segments : []).some((s) => s && s.confidence != null && Number.isFinite(Number(s.confidence)));
}

/**
 * The per-job ladder context shared by the segmented job and the short clip:
 * rung states (pauses that end), budgets, the quality state, the energy cache.
 */
function createJobContext({ options, signal, rungs, prompt, mediaDurationSeconds = null, segmentSeconds, sleep, now, pieces = 1, escalationRungs: extra = [] }) {
  const jc = {
    options,
    signal,
    rungs,
    escalationRungs: extra,
    state: new Map([...rungs, ...extra].map((rung) => [rung.name, newRungState()])),
    prompt,
    mediaDurationSeconds,
    segmentSeconds,
    sleep: sleep || abortableSleep,
    now: now || Date.now,
    limits: ladderLimits(options),
    localPermits: createSemaphore(localParallel(options)),
    dispatch: createDispatchLock(),
    outcomes: new Map(),
    logged: new Set(),
    energy: new Map(),
    waitBudget: { remainingMs: envNumber(options, 'TRANSCRIBE_LAST_RUNG_WAIT_BUDGET_MS', DEFAULT_WAIT_BUDGET_MS, { min: 0, max: 6 * 3600 * 1000 }) },
    variants: null,
    variantsPending: null,
    // Speech vs room tone for sparse answers and holes (the cut plan's adaptive threshold when known).
    speechThresholdDb: DEFAULT_SILENCE_THRESHOLD_DB,
  };
  jc.quality = qualityState(options, { mediaSeconds: mediaDurationSeconds || 0, pieces });
  return jc;
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
    const cut = { durationSeconds: job.durationSeconds, segmentSeconds: job.segmentSeconds, fileSize: job.fileSize,
      fileName: job.fileName, expectedAudioDurationSeconds: job.expectedAudioDurationSeconds };
    if (job.audioStreamInfo) cut.audioStream = job.audioStreamInfo;
    if (Object.prototype.hasOwnProperty.call(job, 'mapOrdinal')) cut.mapOrdinal = job.mapOrdinal;
    prepared = await prepareSegments(filePath, options, cut);
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
    // Refine (options.range + forceRetranscribe): the pieces that overlap the
    // range are transcribed again (their checkpoints ignored) and reviewed.
    const refine = refineWindow(options);
    const refineSet = new Set();
    if (refine) spans.forEach((span, i) => { if (span.start < refine.end && span.end > refine.start) refineSet.add(i); });
    // A refine reads only its window: a piece outside it whose checkpoint part
    // cannot be reused (none kept, swept, or kept in another language) is
    // skipped — not transcribed, no text, no gap, left out of the coverage.
    // The caller takes only the window's text from this result. (A window
    // that overlaps no piece skips nothing: never an empty result.) A caller
    // that needs the whole result (refineSkipUnusable: false) gets every piece.
    // So does a recording whose kept parts were cut by another plan: the
    // stored transcript's segments then do not line up with these pieces (one
    // may run from a re-read piece into a skipped one, and its words there
    // would be lost), so the caller needs a whole reading to cut into.
    let planChanged = loaded.some((part) => cutByOtherPlan(part, prepared.plan));
    if (!planChanged && refineSet.size > 0 && options.refineSkipUnusable !== false) {
      // An entry the checkpoint would not load (cut into another number of
      // pieces, or another piece length) still says which plan cut it.
      for (let i = 0; i < total && !planChanged; i++) {
        if (loaded[i]) continue;
        const hash = await savedCutPlanOf(options, segments[i].index);
        if (hash && hash !== prepared.plan.hash) planChanged = true;
      }
    }
    const refining = refineSet.size > 0 && options.refineSkipUnusable !== false && !planChanged;
    const refineSkipped = new Set();
    // Saved before their review finished (a restart mid-review): reviewed again, not re-transcribed.
    const reviewPending = new Set();
    let resumed = 0;
    loaded.forEach((part, i) => {
      if (refineSet.has(i)) return;
      if (partUsable(part, prepared.plan, language)) {
        results[i] = { part, resumed: true };
        if (part.review && part.review.done === false) reviewPending.add(i);
        resumed++;
      } else if (refining) {
        refineSkipped.add(i);
      }
    });
    if (resumed) emit('resuming', { completed: resumed, total, gaps: 0 });

    const jc = createJobContext({
      options, signal: inner.signal, rungs: job.rungs, prompt: job.prompt, mediaDurationSeconds: mediaDuration || null,
      segmentSeconds: job.segmentSeconds, sleep, now, pieces: total,
      escalationRungs: job.escalationRungs || escalationRungs(options, job.rungs),
    });
    const cutThreshold = Number(prepared.cutInfo?.silence?.thresholdDb);
    if (Number.isFinite(cutThreshold)) jc.speechThresholdDb = Math.max(DEFAULT_SILENCE_THRESHOLD_DB, cutThreshold);
    for (const token of job.tried || []) {
      const match = /^([^(]+)\((.*)\)$/.exec(token);
      if (match) noteOutcome(jc, { name: match[1] }, match[2]);
    }

    // Skipped pieces count as done for the progress and its ETA.
    let completed = resumed + refineSkipped.size;
    let gapCount = 0;
    let processed = 0;
    let firstError = null;
    const startedAt = now();
    // Pieces already counted as completed that are read again in the locked language.
    const redo = new Set();
    const pieceOf = (i) => ({ ...segments[i], spanSeconds: Math.max(0, spans[i].end - spans[i].start) });
    /** Review a piece's answer and record the outcome (part or gap), durable first. */
    const settlePiece = async (i, part, lang, reviewOpts = {}) => {
      let finalPart = { ...part, cutPlan: prepared.plan.hash };
      if (jc.quality.enabled) {
        // The first answer is durable before any escalation: a restart reviews it again.
        await saveSegmentCheckpoint(options, segments[i].index, meta, { ...finalPart, review: { done: false } });
        const reviewed = await reviewPiece(pieceOf(i), finalPart, jc, lang, { forced: refineSet.has(i), ...reviewOpts });
        if (reviewed.gap) {
          results[i] = { gap: { reason: reviewed.gap.reason }, error: reviewed.error };
          return false;
        }
        finalPart = { ...reviewed.part, cutPlan: prepared.plan.hash };
      }
      results[i] = { part: finalPart };
      await saveSegmentCheckpoint(options, segments[i].index, meta, finalPart);
      return true;
    };
    const runIndex = async (i, lang) => {
      const outcome = await transcribeSegmentWithLadder(segments[i], jc, lang);
      if (outcome.part) {
        const kept = await settlePiece(i, outcome.part, lang, { producerIndex: outcome.rungIndex });
        if (!kept) gapCount++;
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
      // The kept hypothesis (after review), not only the first answer: the
      // language detection reads what a second opinion heard.
      return { ...outcome, part: results[i]?.part || null };
    };

    const pending = [];
    for (let i = 0; i < total; i++) if (!results[i] && !refineSkipped.has(i)) pending.push(i);
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
        // A refine never re-reads a piece outside its window.
        if (refining && !refineSet.has(i)) continue;
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
      const cloudLive = jc.rungs.some((rung) => rung.kind === 'cloud' && rungAvailable(rung, jc, { peek: true }));
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
    // A restart in the middle of a review: finish those reviews (no re-transcription).
    for (const i of [...reviewPending].sort((a, b) => a - b)) {
      const part = results[i]?.part;
      // Re-read in the locked language meanwhile: already reviewed.
      if (!part || !jc.quality.enabled || part.review?.done !== false) continue;
      if (!(await settlePiece(i, withoutReview(part), language))) gapCount++;
    }
    // «No voice anywhere» needs a second opinion that agrees (C4): when every
    // piece came back empty and none was confirmed, ask about the most voiced one.
    // A refine that skipped pieces read only its window (each piece there was
    // already reviewed as forced): it says nothing about the whole recording.
    if (jc.quality.enabled && !refineSkipped.size) {
      const covered = results.map((r, i) => (r?.part ? i : -1)).filter((i) => i >= 0);
      const saysNothing = (part) => (part.review && part.review.done === true ? part.review.empty === true : !hasSpeechText(part.text));
      const confirmed = covered.some((i) => results[i].part.review?.confirmedEmpty === true);
      if (covered.length && covered.every((i) => saysNothing(results[i].part)) && !confirmed) {
        const energyOf = (i) => Number(jc.energy.get(`${segments[i].index}:${segments[i].path}:${quality.ENERGY_THRESHOLD_DB}`)?.voicedSec) || 0;
        const target = covered.reduce((best, i) => (energyOf(i) > energyOf(best) ? i : best), covered[0]);
        const answer = withoutReview(results[target].part);
        if (!(await settlePiece(target, answer, language, { forceSecondOpinion: true, producerIndex: jc.rungs.findIndex((r) => r.name === answer.provider) }))) gapCount++;
      }
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
    let speechPieces = 0;
    let escalations = 0;
    let allBasicLocal = true;
    const pieceReports = [];
    for (let i = 0; i < total; i++) {
      // Outside a refine's window and never read: neither covered nor a gap.
      if (refineSkipped.has(i)) continue;
      const span = spans[i];
      const length = Math.max(0, span.end - span.start);
      totalSeconds += length;
      const entry = results[i];
      if (entry && entry.part) {
        const part = entry.part;
        coveredCount++;
        coveredSeconds += length;
        const pq = pieceQuality(part, length, jc.quality.promptIndex);
        if (!pq.empty) speechPieces++;
        escalations += pq.escalations;
        if (!pq.empty && !(inferProvider(part) === 'local' && isBasicLocalModel(part.model))) allBasicLocal = false;
        pieceReports.push({
          start: span.start, end: span.end, covered: true, score: pq.score, engine: pq.engine,
          lowConfidence: pq.spans.map((s) => ({ start: span.start + (Number(s.start) || 0), end: span.start + Math.min(length, Number(s.end) || length), reason: s.reason })),
          disagreement: pq.disagreement, confirmedEmpty: pq.confirmedEmpty, unconfirmedEmpty: pq.unconfirmedEmpty, reviewed: pq.reviewed,
        });
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
          // A start is kept inside its piece (whisper may time the last words
          // at the piece's very end): a segment belongs to the piece it starts
          // in, which is how a refine's caller tells re-read text from the rest.
          const lastStart = Math.max(span.start, round3(span.end - 0.001));
          for (const s of local) {
            stitched.push({ ...s, start: Math.min(round3(s.start + span.start), lastStart), end: round3(s.end + span.start) });
          }
        } else if (text) {
          // No timestamps from this rung: one coarse segment keeps the text on the timeline.
          stitched.push({ start: span.start, end: Math.max(span.end, span.start + 0.5), text });
        }
      } else {
        lastError = entry?.error || lastError;
        gaps.push({ start: span.start, end: span.end, reason: entry?.gap?.reason || 'provider_error' });
        texts.push(gapMarker(span.start, span.end));
        pieceReports.push({ start: span.start, end: span.end, covered: false, score: 0, lowConfidence: [] });
      }
    }
    const top = (map) => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const engine = kinds.size > 1 ? 'mixed' : (kinds.has('local') ? 'local' : (kinds.has('cloud') ? 'cloud' : null));
    const counted = Math.max(1, total - refineSkipped.size);
    const coverage = totalSeconds > 0 ? Math.round((coveredSeconds / totalSeconds) * 10000) / 10000 : Math.round((coveredCount / counted) * 10000) / 10000;
    const stitchedSorted = sortSegments(stitched);
    const report = quality.summarizeQuality({
      pieces: pieceReports,
      segments: stitchedSorted,
      escalations,
      basicLocalOnly: speechPieces > 0 && allBasicLocal,
      // Without any confidence signal the basic model cannot vouch for «alta».
      capBasicLevel: !hasConfidence(stitchedSorted),
    });
    return {
      transcript: texts.join('\n\n'),
      coveredText: covered.join('\n\n'),
      segments: stitchedSorted,
      speechPieces,
      quality: report,
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
      cutInfo: prepared.cutInfo || null,
      ...(refineSkipped.size ? { refineSkipped: refineSkipped.size } : {}),
      // The stretches read again for the window (file clock, one per piece).
      ...(refineSet.size ? { refineSpans: [...refineSet].sort((a, b) => a - b).map((i) => [spans[i].start, spans[i].end]) } : {}),
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
    // A refine that read only its window: how many pieces it left out.
    ...(assembled.refineSkipped > 0 ? { refineSkipped: assembled.refineSkipped } : {}),
    // Which stretches the refine read again (one [start, end] per piece).
    ...(Array.isArray(assembled.refineSpans) && assembled.refineSpans.length ? { refineSpans: assembled.refineSpans } : {}),
  };
  // Text that only says nothing (annotations, sign-offs, prompt echo) is no speech.
  const speech = hasSpeechText(assembled.coveredText) && !(Number.isInteger(assembled.speechPieces) && assembled.speechPieces === 0);
  const covered = `${assembled.coveredCount}/${assembled.segmentCount} segments (coverage ${Math.round(assembled.coverage * 1000) / 10}%)`
    + (assembled.refineSkipped > 0 ? `, ${assembled.refineSkipped} outside the refine window skipped` : '');
  const report = assembled.quality || null;
  const qualityLog = report ? `; quality ${report.level || '?'} ${report.score ?? '?'} (escalations ${report.escalations}, doubtful ${report.lowConfidence.length})` : '';
  if (!assembled.gaps.length) {
    if (!speech) return { ...placeholderResult(fileName, label, normalizedMime, 'no_speech'), ...extra, language: assembled.language, segments: [] };
    logInfo(`segmented transcription of ${fileName}: ${covered}; providers: ${formatProviders(assembled.providers)}${qualityLog}`);
    return formatSuccess({
      text: assembled.transcript,
      method: assembled.method,
      model: assembled.model || (assembled.engine === 'local' ? 'base' : null),
      language: assembled.language,
      segments: assembled.segments,
      ...extra,
      quality: report,
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
  logSafe(`partial transcription of ${fileName}: ${covered}; providers tried: ${assembled.ladder || 'none'}${qualityLog}`);
  return formatSuccess({
    text: assembled.transcript,
    method: assembled.method,
    model: assembled.model || (assembled.engine === 'local' ? 'base' : null),
    language: assembled.language,
    segments: assembled.segments,
    ...extra,
    quality: report,
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

/**
 * whisper.cpp on the whole clip. Resolves { part } for ANY answer the engine
 * gave (speech or not: the review decides what silence means), or
 * { placeholder } when it could not run.
 */
async function localWholeFileAnswer(filePath, job, tried) {
  const { options, fileName, label, normalizedMime, language, prompt } = job;
  const impl = options.localTranscribe || localWhisper.transcribeLocal;
  try {
    const local = await impl(filePath, {
      ...options,
      language,
      prompt,
      mediaDurationSeconds: job.durationSeconds || null,
      // The original file: decode the chosen track. The FLAC master (or no
      // probe): leave ffmpeg's default, the only track there is.
      audioStreamOrdinal: streamOrdinalOf(job.localStreamOrdinal) ?? undefined,
    });
    return {
      part: {
        text: String(local?.text || local?.transcript || '').trim(),
        segments: Array.isArray(local?.segments) ? local.segments : [],
        model: local?.model || 'base',
        language: normalizeLanguage(local?.language) || normalizeLanguage(language) || null,
        provider: 'local',
        method: 'local-whisper',
        kind: 'local',
      },
    };
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    const localReason = String(err?.reason || err?.code || err?.message || 'failed').replace(/\s+/g, ' ').slice(0, 120);
    tried.push(`local(${localReason})`);
    logSafe(`Local Whisper failed: ${sanitizeProviderError(err)}`);
    logSafe(`transcription unavailable for ${fileName}; providers tried: ${tried.join(' ')}`);
    if (err?.code === 'AUDIO_DECODE_FAILED') {
      // ffmpeg's own words say WHY. A missing moov atom or DRM is conclusive;
      // «no stream» from this strict, default-window decode is NOT (audio that
      // starts late): it stays a decode failure, so the tolerant repair runs
      // and ITS verdict decides. The verdict is kept for that repair.
      const verdict = classifyMediaFailure({ code: 'SEGMENT_FAILED', stderr: String(err.cause?.diagnostics || '') }, fileName);
      job.localDecodeVerdict = verdict;
      if (verdict === 'truncated_container' || verdict === 'drm_protected') return { placeholder: placeholderResult(fileName, label, normalizedMime, verdict) };
    }
    return { placeholder: placeholderResult(fileName, label, normalizedMime, err?.code === 'AUDIO_DECODE_FAILED' ? 'audio_decode_failed' : 'local_unavailable') };
  }
}

/** The whole clip on whisper.cpp, formatted (no review: the cut-failure fallback). */
async function transcribeLocalWholeFile(filePath, job, tried) {
  const answer = await localWholeFileAnswer(filePath, job, tried);
  if (answer.placeholder) return answer.placeholder;
  const { part } = answer;
  if (!hasSpeechText(part.text)) return placeholderResult(job.fileName, job.label, job.normalizedMime, 'no_speech');
  // No second engine on this path (ffmpeg could not even cut the file): the
  // report says what the text itself shows.
  const seconds = Number(job.durationSeconds) > 0 ? Number(job.durationSeconds) : 0;
  const pq = pieceQuality(part, seconds || null, null);
  const segments = normalizeSegments(part.segments);
  return formatSuccess({
    text: part.text,
    method: 'local-whisper',
    model: part.model,
    language: part.language,
    segments: part.segments,
    ...singleRequestFields(job.durationSeconds, 'local', 'local'),
    quality: quality.summarizeQuality({
      pieces: [{ start: 0, end: seconds, covered: true, score: pq.score, engine: pq.engine, lowConfidence: pq.spans }],
      segments,
      basicLocalOnly: isBasicLocalModel(part.model),
      capBasicLevel: !hasConfidence(segments),
    }),
  });
}

// ── Intake: streams, track, language, short-clip master ─────────────────────

const warnedOnce = new Set();
function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  logSafe(message);
}

// Only on a successful result whose decode needed the tolerant pass because
// ffmpeg rejected the media (not merely a wider stream-discovery window).
const TOLERANT_NOTE = 'Parte del archivo no se pudo leer con normalidad; usé una lectura tolerante a errores y transcribí lo que se pudo leer.';

/** media-probe's exec, run through this module's (injectable) execFile with the untrusted child env. */
function probeExec(options) {
  const run = execImpl(options);
  return (bin, args, { signal, timeoutMs, maxBuffer } = {}) => run(bin, args, {
    timeout: timeoutMs, maxBuffer, signal, env: mediaChildEnv(),
  });
}

/**
 * The C1 stream probe: `options.mediaProbe` (already probed by the caller),
 * `options.probeMediaStreams` (injected) or ONE ffprobe call. Never throws
 * except on abort; a failed probe is `{ ok: false }` and the job continues
 * exactly as before (ffmpeg's default track).
 */
async function probeStreamsForIntake(filePath, options = {}) {
  if (options.mediaProbe && typeof options.mediaProbe === 'object') return options.mediaProbe;
  try {
    const probe = typeof options.probeMediaStreams === 'function'
      ? await options.probeMediaStreams(filePath, { signal: options.signal })
      : await require('./media-probe').probeMediaStreams(filePath, {
        signal: options.signal, ffprobe: ffprobeBin(options), exec: probeExec(options),
      });
    return probe && typeof probe === 'object' ? probe : { ok: false, error: 'probe_failed', reason: 'no_answer' };
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    return { ok: false, error: 'probe_failed', reason: 'probe_threw' };
  }
}

/**
 * A conclusive «no audio stream»: the probe worked and recognised streams,
 * none of them audio (a screen recording, a muted export). A probe that
 * recognised nothing, or only ffprobe's text-art «video», proves nothing.
 */
function probeShowsNoAudio(probe) {
  if (!probe || probe.ok !== true) return false;
  if (Array.isArray(probe.audio) && probe.audio.length) return false;
  const video = Array.isArray(probe.video) ? probe.video : [];
  const subtitles = Array.isArray(probe.subtitles) ? probe.subtitles : [];
  if (!video.length && !subtitles.length) return false;
  const textArtOnly = video.length > 0 && video.every((v) => TEXT_ART_CODECS.has(String(v?.codec || '').toLowerCase()));
  return !(textArtOnly && !subtitles.length);
}

/**
 * MP4-family sample descriptions: are ALL audio tracks protected (FairPlay
 * `drms`, CENC/CBCS `enca`, Audible `aavd`)? Walks box HEADERS only (moov →
 * trak → mdia → hdlr / minf → stbl → stsd), reading at most a few hundred
 * small ranges, never the media data and never logged. Resolves
 * { checked, protected, audioTracks }; never throws except on abort.
 */
async function mp4AudioProtection(filePath, { signal } = {}) {
  const none = { checked: false, protected: false, audioTracks: 0 };
  let fh = null;
  try {
    fh = await fsPromises.open(filePath, 'r');
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    const tracks = [];
    let boxes = 0;
    const readBox = async (pos, end) => {
      if (end - pos < 8) return null;
      const { bytesRead } = await fh.read(head, 0, 16, pos);
      if (bytesRead < 8) return null;
      let boxSize = head.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(head.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - pos;
      }
      if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || pos + boxSize > end) return null;
      return { type: head.toString('latin1', 4, 8), body: pos + headerSize, end: pos + boxSize };
    };
    const readBody = async (box, limit) => {
      const length = Math.min(limit, box.end - box.body);
      const buf = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = length > 0 ? await fh.read(buf, 0, length, box.body) : { bytesRead: 0 };
      return buf.subarray(0, bytesRead);
    };
    const walk = async (pos, end, depth, track) => {
      while (pos < end && boxes < MP4_MAX_BOXES) {
        boxes++;
        throwIfAborted(signal);
        const box = await readBox(pos, end);
        if (!box) return;
        if (depth === 0 && box.type !== 'moov') {
          pos = box.end;
          continue;
        }
        if (box.type === 'trak') {
          const next = { handler: null, entries: [] };
          tracks.push(next);
          await walk(box.body, box.end, depth + 1, next);
        } else if (MP4_CONTAINER_BOXES.has(box.type)) {
          await walk(box.body, box.end, depth + 1, track);
        } else if (box.type === 'hdlr' && track) {
          const body = await readBody(box, 12);
          if (body.length >= 12) track.handler = body.toString('latin1', 8, 12);
        } else if (box.type === 'stsd' && track) {
          const body = await readBody(box, MP4_MAX_STSD_BYTES);
          const count = body.length >= 8 ? body.readUInt32BE(4) : 0;
          for (let at = 8, i = 0; i < count && at + 8 <= body.length; i++) {
            const entrySize = body.readUInt32BE(at);
            track.entries.push(body.toString('latin1', at + 4, at + 8));
            if (entrySize < 8) break;
            at += entrySize;
          }
        }
        // One moov per file: a fragmented MP4's thousands of moof boxes after
        // it are never walked.
        if (depth === 0) return;
        pos = box.end;
      }
    };
    await walk(0, size, 0, null);
    const audio = tracks.filter((t) => t.handler === 'soun' && t.entries.length);
    return {
      checked: true,
      audioTracks: audio.length,
      protected: audio.length > 0 && audio.every((t) => t.entries.every((type) => PROTECTED_AUDIO_ENTRIES.has(type))),
    };
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    return none;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** A probe tag (codecTag / codec_tag_string, when media-probe reports it) of a protected sample entry. */
function probeTagProtected(stream) {
  const tag = String(stream?.codecTag ?? stream?.codecTagString ?? stream?.codec_tag_string ?? '').trim().toLowerCase();
  return PROTECTED_AUDIO_ENTRIES.has(tag);
}

/**
 * Whether every audio track is DRM-protected, decided BEFORE any decode (a
 * protected track decodes to noise or decode errors, often with exit 0):
 * the probe's codec tags when it reports them, else the MP4 sample
 * descriptions of an MP4-family file.
 */
async function detectProtectedAudio(filePath, probe, options = {}, { fileName } = {}) {
  if (typeof options.detectProtectedAudio === 'function') return Boolean(await options.detectProtectedAudio(filePath, probe, options));
  const audio = probe && probe.ok === true && Array.isArray(probe.audio) ? probe.audio : [];
  if (audio.length && audio.every(probeTagProtected)) return true;
  const mp4 = MP4_FAMILY_EXT_RE.test(String(fileName || '')) || /\b(?:mov|mp4|m4a|3gp)\b/.test(String(probe?.formatName || ''));
  if (!mp4) return false;
  return (await mp4AudioProtection(filePath, { signal: options.signal })).protected;
}

function unsupportedLanguageNote(code) {
  const subject = LANGUAGE_NAMES_ES[code] ? `El ${LANGUAGE_NAMES_ES[code]}` : `El idioma ${languageNameEs(code)}`;
  return `${subject} no está disponible en los motores de transcripción; detecté el idioma automáticamente, así que la transcripción puede ser aproximada.`;
}

/**
 * Whether the stream probe is worth its ffprobe. It also measures the length,
 * so it always runs when the caller did not; with a measured length it is
 * skipped only for single-track audio formats (WAV, MP3, FLAC, Opus…), where
 * there is no track to choose and a missing stream shows up in the decode.
 */
function streamProbeWanted(options = {}, { normalizedMime, fileName } = {}) {
  if (options.mediaProbe || typeof options.probeMediaStreams === 'function') return true;
  if (streamOrdinalOf(options.audioStreamOrdinal) != null) return true;
  if (!(Number.isFinite(options.durationSeconds) && options.durationSeconds >= 0)) return true;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return !(/^audio\//.test(String(normalizedMime || '')) && SINGLE_TRACK_AUDIO_EXTENSIONS.has(ext));
}

/**
 * Everything decided before a rung runs: the language to request (C4:
 * explicit and supported, else detection), the audio track (C1 choice or
 * options.audioStreamOrdinal), whether the file has any audio at all and
 * whether it is DRM-protected. Returns a mutable record the job completes
 * (master, decode, silence, trackUsed). `notes` holds only what stays true
 * whatever happens next (an unsupported language, a missing requested
 * track); the track and tolerant-read notes are written by decorateResult,
 * on a successful result only.
 */
async function analyzeIntake(filePath, options = {}, meta = {}) {
  const notes = [];
  const addNote = (note) => {
    if (note && !notes.includes(note) && notes.length < MAX_INTAKE_NOTES) notes.push(note);
  };
  const explicit = hasExplicitLanguage(options);
  const requested = explicit ? normalizeLanguage(options.language) : undefined;
  const supported = whisperLanguageCode(requested);
  let language;
  let languageSource;
  if (supported) {
    language = supported;
    languageSource = 'explicit';
  } else if (requested) {
    // Quechua, aimara…: every rung would reject `language=qu`. Detect, prior
    // included (Andean recordings code-switch with Spanish), and say so.
    language = undefined;
    languageSource = 'auto';
    addNote(unsupportedLanguageNote(requested));
  } else {
    language = undefined;
    languageSource = explicit ? 'explicit' : 'auto';
  }

  const probed = streamProbeWanted(options, meta);
  const probe = probed ? await probeStreamsForIntake(filePath, options) : { ok: false, error: 'probe_failed', reason: 'skipped' };
  throwIfAborted(options.signal);
  const probeOk = Boolean(probe && probe.ok === true);
  const audio = probeOk && Array.isArray(probe.audio) ? probe.audio : [];
  const requestedTrack = streamOrdinalOf(options.audioStreamOrdinal);
  let choice = null;
  let explicitTrack = false;
  if (requestedTrack != null) {
    if (!probeOk || requestedTrack < audio.length) {
      choice = { streamOrdinal: requestedTrack, reason: 'requested', language: audio[requestedTrack]?.language || null };
      explicitTrack = true;
    } else if (audio.length) {
      addNote(`La pista de audio pedida (${requestedTrack + 1}) no existe: el archivo tiene ${audio.length}.`);
    }
  }
  if (!choice && audio.length) {
    let auto = null;
    try {
      auto = require('./media-probe').chooseAudioStream(probe, { language: requested || undefined });
    } catch { auto = null; }
    if (auto && streamOrdinalOf(auto.streamOrdinal) != null) {
      choice = { streamOrdinal: auto.streamOrdinal, reason: String(auto.reason || 'auto').slice(0, 40), language: auto.language || null };
    }
  }
  const noAudioTrack = probeShowsNoAudio(probe);
  const drmProtected = !noAudioTrack && await detectProtectedAudio(filePath, probe, options, meta);
  throwIfAborted(options.signal);
  return {
    probe,
    probed,
    probeOk,
    noAudioTrack,
    drmProtected,
    language,
    languageSource,
    requestedLanguage: requested || null,
    languageSupported: requested ? Boolean(supported) : null,
    audioStream: choice ? { streamOrdinal: choice.streamOrdinal, reason: choice.reason } : null,
    audioStreamLanguage: choice ? choice.language || null : null,
    audioStreamInfo: choice
      ? { streamOrdinal: choice.streamOrdinal, reason: choice.reason, streams: probeOk ? audio.length : null, explicit: explicitTrack }
      : null,
    streamCount: probeOk ? audio.length : null,
    // null: the chosen track (when there is one) is what was transcribed;
    // 'default_stream': ffmpeg (or a provider given the uploaded file) used its
    // default stream instead; 'unrecorded': pieces cut before tracks were
    // recorded were reused, so which track they hold is unknown.
    trackUsed: null,
    master: 'none',
    decode: null,
    decodeCause: null,
    silence: null,
    notes,
    addNote,
  };
}

/** The decode a pass needed, never downgrading a tolerant read to strict. */
function noteDecode(intake, decode, decodeCause) {
  if (decode === 'tolerant') {
    if (intake.decode !== 'tolerant' || intake.decodeCause !== 'damaged') {
      intake.decode = 'tolerant';
      intake.decodeCause = DECODE_CAUSES.has(decodeCause) ? decodeCause : 'damaged';
    }
  } else if (decode && !intake.decode) {
    intake.decode = decode;
  }
}

/** The chosen track did not make it into what was transcribed. */
function noteTrackLost(intake, why) {
  if (intake.audioStream && !intake.trackUsed) intake.trackUsed = why;
}

function applyCutInfo(intake, cutInfo) {
  if (!intake || !cutInfo) return;
  noteDecode(intake, cutInfo.decode, cutInfo.decodeCause);
  if (cutInfo.silence) intake.silence = cutInfo.silence;
  if (cutInfo.streamDropped) noteTrackLost(intake, 'default_stream');
  // Pieces cut before the track was recorded (a job in flight across the
  // deploy) hold ffmpeg's default stream: certain only for a one-track file.
  else if (cutInfo.reused && !cutInfo.audioStream && intake.streamCount !== 1) noteTrackLost(intake, 'unrecorded');
}

/**
 * C4 result fields: `audioStream`, Spanish `notes` and a bounded machine-
 * readable `intake`. The notes only state what happened: the track and the
 * tolerant read are claimed on a SUCCESSFUL result only (a failure keeps the
 * notes that stay true: an unsupported language, a missing requested track),
 * and a track that did not make it into the text (`trackUsed`) is reported
 * as `audioStream: null`, never as the one «transcribed».
 */
function decorateResult(result, intake) {
  if (!result || typeof result !== 'object' || !intake) return result;
  const audioStream = intake.audioStream && !intake.trackUsed ? { ...intake.audioStream } : null;
  const notes = intake.notes.slice();
  if (result.ok === true) {
    if (audioStream && intake.streamCount > 1) {
      const language = intake.audioStreamLanguage ? ` (${languageNameEs(intake.audioStreamLanguage)})` : '';
      notes.push(`El archivo tiene ${intake.streamCount} pistas de audio; transcribí la pista ${audioStream.streamOrdinal + 1}${language}.`);
    }
    if (intake.decode === 'tolerant' && intake.decodeCause !== 'stream_window') notes.push(TOLERANT_NOTE);
  }
  return {
    ...result,
    audioStream,
    notes: notes.slice(0, MAX_INTAKE_NOTES),
    intake: {
      probe: intake.probeOk ? 'ok' : (intake.probed ? 'failed' : 'skipped'),
      audioStreams: intake.streamCount,
      requestedLanguage: intake.requestedLanguage,
      languageSupported: intake.languageSupported,
      // 'chosen' | 'default_stream' | 'unrecorded' | null (no track chosen).
      track: intake.audioStream ? (intake.trackUsed || 'chosen') : null,
      master: intake.master,
      decode: intake.decode,
      decodeCause: intake.decodeCause,
      silence: intake.silence,
    },
  };
}

/** Containers OpenAI / Groq accept as an upload (by extension, their documented list). */
function providerAcceptsContainer(fileName) {
  return CLOUD_SAFE_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase());
}

/**
 * Without the FLAC master because ffmpeg REJECTED the media (both reads):
 * only audio in an accepted container still goes as uploaded — a video the
 * decoder cannot read would only collect 400s.
 */
function rawUploadSafe(mime, fileName) {
  if (!providerAcceptsContainer(fileName)) return false;
  return /^audio\//.test(String(mime || '')) || mime === 'application/ogg';
}

/**
 * Why a clip master could not be built, from the ladder's last error: 'decode'
 * when ffmpeg rejected the media itself (pass 1 said so, or the last pass
 * did), else the host-side reason ('timeout' / 'resource' / 'spawn' /
 * 'ffmpeg_missing') — those say nothing about the file.
 */
function masterFailureCode(err, fileName) {
  if (err?.strictVerdict === 'decode') return 'decode';
  const verdict = classifyMediaFailure(err, fileName);
  return verdict === 'stream_not_found' || verdict === 'no_audio_track' ? 'decode' : verdict;
}

/**
 * Short clip → ONE mono 16 kHz FLAC master (`audio.flac`) in its own temp
 * dir, mapping the chosen track (under media-probe's window). A decode ffmpeg
 * rejects goes down decodeLadder (tolerant with the track, then without it).
 * Returns { ok: true, path, dir, size, durationSeconds, tolerant, decodeCause,
 * streamDropped } or { ok: false, code, dir? } (code: an intake verdict such
 * as 'truncated_container', or 'ffmpeg_missing' / 'decode' / 'timeout' /
 * 'resource' / 'spawn' / 'empty'). Never throws except on abort, and then
 * removes its dir; otherwise the caller removes `dir`. ctx.tolerantOnly skips
 * the strict pass (ctx.strictVerdict: how a strict decode already failed).
 * Injectable through options.transcodeClip.
 */
async function buildClipMaster(filePath, ctx = {}, options = {}) {
  if (typeof options.transcodeClip === 'function') return options.transcodeClip(filePath, ctx, options);
  let dir = null;
  try {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-clip-'));
  } catch (err) {
    return { ok: false, code: classifyMediaFailure(err), dir: null };
  }
  const out = path.join(dir, CLIP_MASTER_NAME);
  const scoped = { ...options, durationSeconds: Number(ctx.durationSeconds) || 0 };
  const ordinal = streamOrdinalOf(ctx.audioStreamOrdinal);
  const args = (mode) => [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...decodeInputArgs(mode),
    '-i', filePath,
    ...mapArgs(mode.map),
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', SEGMENT_SAMPLE_RATE, '-c:a', 'flac',
    out,
  ];
  try {
    let ladder;
    try {
      ladder = await decodeLadder((mode) => runFfmpeg(args(mode), scoped), {
        ordinal,
        fileName: ctx.fileName,
        signal: options.signal,
        cleanup: () => fsPromises.rm(out, { force: true }).catch(() => {}),
        strictVerdict: ctx.tolerantOnly ? (ctx.strictVerdict || 'decode') : null,
      });
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      if (err?.code === 'MEDIA_INTAKE' && err.intakeCode) return { ok: false, code: err.intakeCode, dir };
      return { ok: false, code: masterFailureCode(err, ctx.fileName), dir };
    }
    const stat = await fsPromises.stat(out).catch(() => null);
    if (!stat || !stat.size) return { ok: false, code: 'empty', dir };
    const durationSeconds = await probeFileDuration(out, scoped);
    return {
      ok: true, path: out, dir, size: stat.size, durationSeconds,
      tolerant: ladder.decode === 'tolerant', decodeCause: ladder.decodeCause, streamDropped: ladder.streamDropped,
    };
  } catch (err) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Transcribe an audio or video file.
 * Returns { ok, status, text, transcript, method, model, language, segments,
 * durationSec, segmentCount, partial, gaps, coverage, providers, engine,
 * audioStream, notes, intake }.
 */
async function transcribeUnqueued(filePath, mimeType, originalName, options = {}) {
  throwIfAborted(options.signal);
  const fileName = originalName || path.basename(filePath);
  const normalizedMime = normalizeAudioMime(mimeType, fileName);
  const label = mimeInfo(normalizedMime, fileName).label;
  const intake = await analyzeIntake(filePath, options, { normalizedMime, fileName });
  // The probe already read the container's length: no second ffprobe unless
  // the caller injected its own duration probe (or the header had none).
  let durationSeconds;
  if (Number.isFinite(options.durationSeconds) && options.durationSeconds >= 0) durationSeconds = options.durationSeconds;
  else if (typeof options.probeAudioDuration !== 'function' && intake.probeOk && Number(intake.probe.durationSec) > 0) durationSeconds = Number(intake.probe.durationSec);
  else if (intake.noAudioTrack) durationSeconds = 0;
  else durationSeconds = await probeAudioDuration(filePath, options);
  const clip = { dirs: [] };
  try {
    const result = await transcribeWithIntake(filePath, { fileName, normalizedMime, label }, { ...options, durationSeconds }, intake, clip);
    return decorateResult(result, intake);
  } finally {
    for (const dir of clip.dirs) await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeWithIntake(filePath, meta, initialOptions, intake, clip) {
  const { fileName, normalizedMime, label } = meta;
  let options = initialOptions;
  const { language, languageSource } = intake;
  const prompt = resolvePrompt(options);
  const maxBytes = audioMaxFileBytes(options);

  let fileSize = 0;
  try {
    fileSize = (await fsPromises.stat(filePath)).size;
  } catch {
    return placeholderResult(fileName, label, normalizedMime, 'file_unavailable');
  }
  if (!fileSize) return placeholderResult(fileName, label, normalizedMime, 'file_empty');
  if (intake.noAudioTrack) {
    logInfo(`no audio stream in ${fileName}${intake.probe?.hasVideo ? ' (video only)' : ''}; nothing to transcribe`);
    const seconds = Number(intake.probe?.durationSec);
    return { ...placeholderResult(fileName, label, normalizedMime, 'no_audio_track'), durationSec: seconds > 0 ? round3(seconds) : null };
  }
  if (intake.drmProtected) {
    // Decoding would only produce noise (often with exit 0) or decode errors.
    logSafe(`transcription unavailable for ${fileName} (drm_protected: protected audio sample entries)`);
    const seconds = Number(intake.probe?.durationSec);
    return { ...placeholderResult(fileName, label, normalizedMime, 'drm_protected'), durationSec: seconds > 0 ? round3(seconds) : null };
  }

  const cloud = cloudProviders(options);
  const segmentSeconds = effectiveSegmentSeconds(options, cloud);
  let duration = Number(options.durationSeconds) || 0;
  const trackOrdinal = intake.audioStream ? intake.audioStream.streamOrdinal : null;
  const job = {
    options, fileName, normalizedMime, label, language, languageSource, prompt, durationSeconds: duration, fileSize, segmentSeconds,
    expectedAudioDurationSeconds: expectedAudioDuration(intake, duration, { normalizedMime, fileName }),
    // Track identity (manifest + multi-stream plan hash), what to map on the
    // cut source, and what the local whole-file decode maps.
    audioStreamInfo: intake.audioStreamInfo, mapOrdinal: trackOrdinal, localStreamOrdinal: trackOrdinal,
  };
  const tried = [];
  if (intake.audioStreamInfo && intake.streamCount > 1) {
    logInfo(`${fileName}: ${intake.streamCount} audio streams; transcribing #${trackOrdinal} (${intake.audioStream.reason})`);
  }
  const intakePlaceholder = (code) => {
    logSafe(`transcription unavailable for ${fileName} (${code})`);
    return placeholderResult(fileName, label, normalizedMime, code);
  };

  // Long media (or a file above the provider cap): one cut, a per-segment
  // ladder, partial results instead of all-or-nothing.
  const segmentedRun = async (sourcePath) => {
    const vs = voiceStudioRung(job.options);
    const rungs = [...cloud, ...(vs ? [vs] : []), ...(localEnabled(job.options) ? [LOCAL_RUNG] : [])];
    if (!rungs.length) {
      logSafe(`transcription unavailable for ${fileName}; providers tried: none local(disabled)`);
      return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
    }
    try {
      const assembled = await runSegmentedJob(sourcePath, { ...job, rungs, tried });
      applyCutInfo(intake, assembled.cutInfo);
      return finalizeSegmentedResult(assembled, job);
    } catch (err) {
      if (isAbortError(err, job.options.signal) || err?.code === 'audio_decode_incomplete' || !err?.segmentationFailed) throw err;
      if (INTAKE_FATAL_CODES.has(err.intakeCode)) return intakePlaceholder(err.intakeCode);
      logSafe(`could not cut ${fileName} into segments (${sanitizeProviderError(err)})`);
      // Unknown length and ffmpeg cannot cut it: let the local decoder decide
      // (it reports a decode failure honestly). A known long file is retried.
      if (job.durationSeconds > 0 || !localEnabled(job.options)) {
        logSafe(`transcription unavailable for ${fileName}; providers tried: segmentation(${err?.code || 'failed'})`);
        return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
      }
      return transcribeLocalWholeFile(sourcePath, job, tried);
    }
  };
  if (fileSize > maxBytes || duration > segmentSeconds) return segmentedRun(filePath);

  // Short clip: the FLAC master every OTHER-PROCESS rung receives (never the
  // uploaded container: .opus/.amr/.mov 400s, whole videos uploaded for their
  // audio). A local-only clip needs none: whisper.cpp's own decode maps the
  // track, and the master (tolerant) is built only to repair a failed decode.
  let source = { path: filePath, mime: normalizedMime, name: fileName };
  let cloudAllowed = true;
  let masterTried = false;
  // The two on-host engines run in the LISTED order: «local,voicestudio» (the
  // free dictation) reads the clip with whisper.cpp first (seconds on CPU) and
  // asks Sira Voz (WhisperX large-v3, much slower) only when whisper.cpp
  // could not answer, or as the review's second opinion.
  const order = providerOrder(options);
  const localFirst = localEnabled(options)
    && (!order.includes('voicestudio') || order.indexOf('local') < order.indexOf('voicestudio'));
  // Whisper.cpp maps the track itself: no master just for a Sira Voz that
  // comes later, unless the chosen track may not be the default one (several
  // tracks, or a requested one in an unprobed file): Sira Voz uploads the
  // file, and only the master holds the chosen track alone.
  const trackNeedsMaster = Boolean(intake.audioStream) && intake.streamCount !== 1;
  const vsWanted = (!localFirst || trackNeedsMaster) && order.includes('voicestudio') && (() => {
    try { const vs = voiceStudioClient(options); return Boolean(vs && typeof vs.isConfigured === 'function' && vs.isConfigured(options)); } catch { return false; }
  })();
  const adoptMaster = (master) => {
    intake.master = 'flac';
    noteDecode(intake, master.tolerant ? 'tolerant' : 'strict', master.decodeCause);
    if (master.streamDropped) {
      // ffmpeg never saw the chosen track: the master holds its default one,
      // and so does every piece a later cut makes of it (the manifest says so).
      noteTrackLost(intake, 'default_stream');
      if (job.audioStreamInfo) job.audioStreamInfo = { ...job.audioStreamInfo, dropped: true };
    }
    if (Number(master.durationSeconds) > 0) {
      // The master's FLAC header is exact: it settles an unknown or wrong length.
      duration = Number(master.durationSeconds);
      options = { ...options, durationSeconds: duration };
      Object.assign(job, { options, durationSeconds: duration });
    }
    // The master holds only the chosen track: nothing to map from here on.
    Object.assign(job, { mapOrdinal: null, localStreamOrdinal: null });
    source = { path: master.path, mime: CLIP_MASTER_MIME, name: CLIP_MASTER_NAME };
  };
  if (cloud.some((provider) => !providerInCooldown(provider)) || vsWanted) {
    masterTried = true;
    const master = await buildClipMaster(filePath, { audioStreamOrdinal: trackOrdinal, fileName, durationSeconds: duration }, options);
    if (master?.dir) clip.dirs.push(master.dir);
    if (!master?.ok && INTAKE_FATAL_CODES.has(master?.code)) return intakePlaceholder(master.code);
    if (master?.ok) {
      adoptMaster(master);
      if (master.size > maxBytes || duration > segmentSeconds) return segmentedRun(master.path);
    } else {
      intake.master = 'raw';
      if (master?.code === 'ffmpeg_missing') {
        warnOnce('clip-ffmpeg-missing', 'ffmpeg is not available; short clips go to the providers as uploaded (degraded)');
      } else if (master?.code === 'decode') {
        // ffmpeg rejected the media itself: only audio in an accepted
        // container is still worth an upload.
        cloudAllowed = rawUploadSafe(normalizedMime, fileName);
      } else {
        // A host-side failure (timeout under load, full disk, spawn limits,
        // empty output) says nothing about the file: as before the master,
        // every container the providers accept (video/mp4 included) goes up.
        cloudAllowed = providerAcceptsContainer(fileName);
      }
    }
  }

  // The last rung on the whole clip. A decode of the ORIGINAL that ffmpeg
  // rejected is repaired once: a tolerant FLAC master, then local again.
  // Resolves { part } | { placeholder } | { result } (a repaired master that
  // turned out long went the segmented way).
  const localWholeFile = async () => {
    const answer = await localWholeFileAnswer(source.path, job, tried);
    if (answer.placeholder?.reasonCode !== 'audio_decode_failed' || masterTried || source.path !== filePath) return answer;
    masterTried = true;
    const repaired = await buildClipMaster(filePath, {
      audioStreamOrdinal: trackOrdinal, fileName, durationSeconds: duration, tolerantOnly: true,
      strictVerdict: job.localDecodeVerdict || 'decode',
    }, options);
    if (repaired?.dir) clip.dirs.push(repaired.dir);
    if (!repaired?.ok) return INTAKE_FATAL_CODES.has(repaired?.code) ? { placeholder: intakePlaceholder(repaired.code) } : answer;
    adoptMaster(repaired);
    // The repaired master's FLAC length is often the first right one (a
    // damaged header lies): a long recording is cut and checkpointed, never
    // handed to ONE whisper.cpp process.
    if (repaired.size > maxBytes || duration > segmentSeconds) return { result: await segmentedRun(repaired.path) };
    return localWholeFileAnswer(source.path, job, tried);
  };

  // ONE request per rung until one ANSWERS (speech or not): that first answer
  // is then reviewed — «nothing heard» needs a second opinion that agrees,
  // a flagged answer gets an alternative hypothesis. `tried` feeds the final
  // summary line («providers tried: …»).
  let first = null;
  if (!cloudAllowed && cloud.length) tried.push('cloud(container)');
  for (const provider of cloudAllowed ? cloud : []) {
    if (providerInCooldown(provider)) {
      tried.push(`${provider.name}(cooldown)`);
      continue;
    }
    try {
      const result = await transcribeCloudFile(provider, source.path, source.mime, source.name, options, language, prompt);
      // The uploaded file (no master): the provider decoded ITS default stream.
      if (source.path === filePath && intake.streamCount !== 1) noteTrackLost(intake, 'default_stream');
      first = {
        text: String(result.text || '').trim(), segments: result.segments, model: result.model, language: result.language,
        provider: provider.name, method: 'whisper', kind: 'cloud',
      };
      break;
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      if (err?.code === 'xai_stt_empty_transcript') {
        // A 200 with no text: an answer («nothing heard»), reviewed like one.
        first = { text: '', segments: [], model: provider.model, language: normalizeLanguage(language) || null, provider: provider.name, method: 'whisper', kind: 'cloud' };
        break;
      }
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
  // 'voicestudio' BEFORE 'local' in TRANSCRIBE_PROVIDERS to use it before the
  // bundled whisper.cpp base model — better accuracy, slower on CPU, still
  // free. Listed after it, it is whisper.cpp's fallback and second opinion.
  const vsShort = order.includes('voicestudio') ? buildVoiceStudioRung(options) : null;
  // One request to Sira Voz on the whole clip: its part, or null (`tried` says why).
  const askVoiceStudio = async () => {
    try {
      const vs = await voiceStudioClient(options).transcribe({
        filePath: source.path, filename: source.name, mime: source.mime, language, prompt, signal: options.signal,
      }, voiceStudioCallOptions(options));
      if (source.path === filePath && intake.streamCount !== 1) noteTrackLost(intake, 'default_stream');
      return {
        text: String(vs?.text || '').trim(), segments: Array.isArray(vs?.segments) ? vs.segments : [], model: 'voicestudio-whisperx',
        language: vs?.language || language || null, provider: 'voicestudio', method: 'local-whisper', kind: 'local',
      };
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      tried.push(`voicestudio(${describeProviderError(err)})`);
      logSafe(`VoiceStudio transcription failed (${sanitizeProviderError(err)}); trying the next provider`);
      return null;
    }
  };
  if (!first && vsShort && !localFirst) first = await askVoiceStudio();

  if (!first) {
    if (!localEnabled(options)) {
      logSafe(`transcription unavailable for ${fileName}; providers tried: ${tried.join(' ') || 'none'} local(disabled)`);
      return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
    }

    // Unknown length: never hand a possibly multi-hour file to ONE whisper
    // process (no checkpoints, ~2 GB of RAM). Cut it; if ffmpeg cannot, the
    // local decoder gets the whole file as before.
    if (!(duration > 0)) {
      try {
        // Sira Voz not asked yet (listed after local): whisper.cpp's fallback per piece.
        const rungs = [LOCAL_RUNG, ...(localFirst && vsShort ? [vsShort] : [])];
        const assembled = await runSegmentedJob(source.path, { ...job, rungs, tried });
        applyCutInfo(intake, assembled.cutInfo);
        return finalizeSegmentedResult(assembled, job);
      } catch (err) {
        if (isAbortError(err, options.signal) || !err?.segmentationFailed) throw err;
        if (INTAKE_FATAL_CODES.has(err.intakeCode)) return intakePlaceholder(err.intakeCode);
        // The cut already tried a tolerant decode: the repair would only repeat it.
        if (err.code === 'SEGMENT_FAILED') masterTried = true;
      }
    }
    const local = await localWholeFile();
    if (local.result) return local.result;
    if (local.placeholder) {
      // whisper.cpp could not run or decode it: Sira Voz, listed after it, is
      // the next rung (never for a verdict about the file itself).
      const fallback = localFirst && vsShort && !INTAKE_FATAL_CODES.has(local.placeholder.reasonCode) ? await askVoiceStudio() : null;
      if (!fallback) return local.placeholder;
      first = fallback;
    } else {
      first = local.part;
    }
  }

  const onHost = [...(vsShort ? [vsShort] : []), ...(localEnabled(options) ? [LOCAL_RUNG] : [])];
  return reviewShortClip(first, {
    options, fileName, label, normalizedMime, language, prompt, duration, segmentSeconds,
    source, sourceIsOriginal: source.path === filePath, localStreamOrdinal: job.localStreamOrdinal,
    // Sira Voz after whisper.cpp when listed after it: the second opinion of a «nothing heard».
    rungs: [...(cloudAllowed ? cloud : []), ...(localFirst ? onHost.reverse() : onHost)],
    // A review answer read from the uploaded file (no master): ITS default stream.
    onDefaultStreamRead: () => { if (intake.streamCount !== 1) noteTrackLost(intake, 'default_stream'); },
  });
}

/**
 * The short clip's review (C4): the first answer is ONE piece of the quality
 * loop. «Nothing heard» always gets a second opinion (the next rungs, then
 * the same rung on an enhanced copy) and is `no_speech` only when it agrees
 * (or when no second opinion exists at all: today's behaviour, logged).
 * Second opinions that were asked and all failed are not agreement: the clip
 * ends `local_unavailable` (transient), so the queue tries again.
 */
async function reviewShortClip(firstPart, ctx) {
  const { options, fileName, label, normalizedMime, language, prompt, duration, rungs } = ctx;
  const jc = createJobContext({
    options,
    signal: options.signal || new AbortController().signal,
    rungs,
    prompt,
    mediaDurationSeconds: duration > 0 ? duration : null,
    segmentSeconds: ctx.segmentSeconds,
    sleep: typeof options.sleep === 'function' ? options.sleep : undefined,
    now: typeof options.now === 'function' ? options.now : undefined,
    pieces: 1,
    escalationRungs: escalationRungs(options, rungs),
  });
  const piece = {
    path: ctx.source.path, mime: ctx.source.mime, name: ctx.source.name, index: 0, offsetSeconds: 0,
    durationSeconds: duration > 0 ? duration : null, spanSeconds: duration > 0 ? duration : null,
    // The original file (no master): every decode maps the chosen track.
    streamOrdinal: ctx.sourceIsOriginal ? streamOrdinalOf(ctx.localStreamOrdinal) : null,
  };
  const reviewed = await reviewPiece(piece, firstPart, jc, language, {
    producerIndex: rungs.findIndex((rung) => rung.name === firstPart.provider),
    alwaysSecondOpinion: true,
    forced: Boolean(refineWindow(options)),
  });
  if (!reviewed.part) {
    logSafe(`no second opinion answered for the empty first answer on ${fileName} (${reviewed.gap?.reason || 'provider_error'}); not concluding «no speech», retry later`);
    return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
  }
  const chosen = reviewed.part;
  const review = chosen.review || {};
  const text = String(chosen.text || '').trim();
  if (review.empty === true || !hasSpeechText(text)) {
    if (review.confirmedEmpty) logInfo(`no speech in ${fileName}: confirmed by a second opinion (${(review.engines || []).length} engines)`);
    return placeholderResult(fileName, label, normalizedMime, 'no_speech');
  }
  // Sira Voz or a cloud rung given the uploaded file decoded its default
  // stream; whisper.cpp and an enhanced copy map the chosen track.
  if (ctx.sourceIsOriginal && chosen.provider !== 'local' && !chosen.variant) ctx.onDefaultStreamRead?.();
  const segments = normalizeSegments(chosen.segments);
  const report = quality.summarizeQuality({
    pieces: [{
      start: 0, end: duration > 0 ? duration : 0, covered: true, score: review.score, engine: review.engine || engineLabelOf(chosen),
      lowConfidence: Array.isArray(review.lowConfidence) ? review.lowConfidence : [],
      disagreement: review.disagreement === true, confirmedEmpty: false, unconfirmedEmpty: review.unconfirmedEmpty === true,
      reviewed: reviewAnswered(review),
    }],
    segments,
    escalations: review.escalations,
    basicLocalOnly: chosen.provider === 'local' && isBasicLocalModel(chosen.model),
    capBasicLevel: !hasConfidence(segments),
  });
  if (report.escalations) logInfo(`short clip ${fileName}: quality ${report.level || '?'} ${report.score ?? '?'} after ${report.escalations} alternative hypotheses`);
  const kind = chosen.kind || kindOfProvider(chosen.provider);
  return formatSuccess({
    text,
    method: chosen.method || (kind === 'local' ? 'local-whisper' : 'whisper'),
    model: chosen.model || (chosen.provider === 'local' ? 'base' : null),
    language: chosen.language || language || null,
    segments: chosen.segments,
    ...singleRequestFields(duration, chosen.provider || inferProvider(chosen), kind),
    quality: report,
  });
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

// The media queue's short lane (options.lane === 'short': ≤ 15-min jobs) has
// its own slot, so a voice note never waits behind two 5-hour lectures that
// hold both shared slots. It also takes a shared slot when one is free.
let activeShortLane = 0;
function shortLaneConcurrency() {
  const n = Number.parseInt(process.env.TRANSCRIBE_SHORT_LANE_CONCURRENCY || '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(4, n) : 1;
}

// Interactive callers (dictation, transcribe_url inline clips, the runner's
// transcribe_audio) wait on a person in a chat turn. They pass
// options.lane === 'interactive' and get a slot that queue jobs never take,
// so two long lectures can never hold a dictation for hours.
let activeInteractiveLane = 0;
function interactiveLaneConcurrency() {
  const n = Number.parseInt(process.env.TRANSCRIBE_INTERACTIVE_LANE_CONCURRENCY || '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(4, n) : 1;
}

function normalizeLane(lane) {
  return lane === 'short' || lane === 'interactive' ? lane : null;
}

function startTranscription(job, pool) {
  if (pool === 'short') activeShortLane++;
  else if (pool === 'interactive') activeInteractiveLane++;
  else activeTranscriptions++;
  Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
    if (pool === 'short') activeShortLane--;
    else if (pool === 'interactive') activeInteractiveLane--;
    else activeTranscriptions--;
    drainTranscriptions();
  });
}

function drainTranscriptions() {
  for (let i = 0; i < transcriptionQueue.length;) {
    const job = transcriptionQueue[i];
    if (job.signal.aborted) {
      transcriptionQueue.splice(i, 1);
      job.signal.removeEventListener('abort', job.onAbort);
      job.reject(abortError());
      continue;
    }
    let pool = null;
    if (activeTranscriptions < TRANSCRIPTION_CONCURRENCY) pool = 'shared';
    else if (job.lane === 'short' && activeShortLane < shortLaneConcurrency()) pool = 'short';
    else if (job.lane === 'interactive' && activeInteractiveLane < interactiveLaneConcurrency()) pool = 'interactive';
    if (!pool) {
      // FIFO among long work; a short-lane job further back may still have its slot.
      i++;
      continue;
    }
    transcriptionQueue.splice(i, 1);
    job.signal.removeEventListener('abort', job.onAbort);
    startTranscription(job, pool);
  }
}

function enqueueTranscription(run, signal, lane = null) {
  return new Promise((resolve, reject) => {
    const job = { run, signal, resolve, reject, lane: normalizeLane(lane) };
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
  if (options.signal) return enqueueTranscription(() => transcribeUnqueued(filePath, mimeType, originalName, options), options.signal, options.lane);
  const stat = await fsPromises.stat(filePath).catch(() => null);
  throwIfAborted(options.signal);
  // Include configuration identity as well as file revision. Never share a
  // result across explicitly different injected clients/settings. No permanent
  // cache: persistence and access checks are owned by the File/job layer.
  const key = JSON.stringify([path.resolve(filePath), stat?.size, stat?.mtimeMs,
    normalizeAudioMime(mimeType, originalName), originalName, options.language, resolveLanguage(options), options.prompt || envOf(options).WHISPER_PROMPT,
    promptTerms(options), streamOrdinalOf(options.audioStreamOrdinal), options.parallel, options.minCoverage,
    providerOrder(options), options.model, options.maxFileBytes, options.durationSeconds, options.segmentSeconds,
    options.ffmpegPath, options.ffprobePath, options.whisperBin, options.modelPath, options.pythonPath, options.threads, options.timeoutMs, options.voiceStudioTimeoutMs,
    // Quality loop (G1b): a refine window, hints, budgets and its injectables.
    refineWindow(options), options.refineSkipUnusable === false, options.hints?.speakers ?? null, options.hints?.verbatim ?? null, options.qualityLoop,
    escalationProviderNames(options), options.ffmpegFilters ? Array.from(options.ffmpegFilters) : null,
    ...['env', 'openai', 'groqClient', 'metaClient', 'localTranscribe', 'xaiTranscribe', 'voiceStudio', 'segmentAudio', 'probeAudioDuration', 'spawnImpl', 'createFile',
      'execFileImpl', 'detectSilences', 'concatAudio', 'sleep', 'checkpoint', 'mediaProbe', 'probeMediaStreams', 'transcodeClip',
      'estimateSilenceThreshold', 'detectProtectedAudio', 'measureVoiced', 'buildVariant', 'elevenlabsClient', 'now',
      'whisperCapabilities', 'whisperHelpImpl'].map((k) => identity(options[k])),
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
    }), entry.controller.signal, options.lane);
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
  // Admission gate, exported for tests of the lanes (shared / short / interactive).
  _enqueueTranscription: enqueueTranscription,
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
  // Quality loop (C4, G1b).
  reviewPiece,
  createJobContext,
  refineWindow,
  escalationRungs,
  escalationProviderNames,
  elevenLabsRung,
  transcribeWithElevenLabs,
  ffmpegFilterSet,
  parseFfmpegFilters,
  buildVariantFile,
  measurePieceEnergy,
  classifyRungError,
  VARIANT_FILTERS,
  REVIVAL_DELAYS_MS,
  LAST_RUNG_BACKOFF_MS,
  // Intake (C4, G1a): helpers shared with the queue and covered by tests.
  isSupportedLanguage,
  isDeviceIdentifier,
  promptTerms,
  classifyMediaFailure,
  estimateSilenceThreshold,
  silenceThresholdFromPeaks,
  framePeaks,
  planOf,
  buildClipMaster,
  cutAndMeasure,
  mp4AudioProtection,
  WHISPER_LANGUAGES,
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
