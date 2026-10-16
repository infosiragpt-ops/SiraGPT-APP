'use strict';

/**
 * transcribe_url — transcribe the audio of a video / audio / recording LINK,
 * whole or from one timecode to another («del minuto 1:30 al 10:00»).
 *
 * Pipeline (every step bounded, every binary spawned with a scrubbed env):
 *   1. URL safety: the same SSRF posture as web_fetch (public http(s) only,
 *      no credentials, no private / metadata targets, DNS re-checked).
 *   2. Probe with yt-dlp (`--dump-single-json --skip-download`): title,
 *      duration, extractor. A login wall / private video / 401-403 comes
 *      back as `media_login_required`, never as a crash. yt-dlp handles the
 *      public platforms (YouTube, Vimeo, Drive public links, direct mp4/mp3…).
 *   3. Download ONLY the requested section (`--download-sections`) as best
 *      audio, then ffmpeg trims precisely and encodes a mono 16 kHz AAC clip
 *      (small enough for the cloud ladder; whisper.cpp converts it itself).
 *   4. Transcribe through services/audio-transcriber (OpenAI → Groq → xAI →
 *      local whisper.cpp ladder, cooldowns, segmentation) and shift the
 *      segment timestamps back to the recording's own clock.
 *   5. Deliver: timestamped text for the model (capped) + a downloadable
 *      .txt (and .srt on request) through the artifact store, announced as a
 *      `file_artifact` card like create_artifact does.
 *
 * Ladder (2026-10-03, Luis: «tiene que entrar al video y sacar el audio sí o
 * sí»): yt-dlp first. When yt-dlp does not know the page («Unsupported URL»,
 * a login-looking 401/403, a generic failure), the headless Chromium of the
 * image opens the page WITH the user's cookies (media-discovery), presses
 * play and records the HLS/DASH/MP4 the player really fetches; that URL goes
 * back to yt-dlp with the page as Referer and the browser's cookies, and if
 * yt-dlp still refuses, ffmpeg reads the stream directly (HLS/MP4 + headers).
 * A page that still shows a login form with no media is reported as
 * `media_login_required` with the two user paths: attach the file, or attach
 * a `cookies.txt` once (kept encrypted per user by cookie-jar-store and
 * reused for every later link of that site).
 *
 * YouTube needs a JS runtime for its signature challenge: every yt-dlp call
 * gets `--js-runtimes node:<this process's node>` (TRANSCRIBE_URL_JS_RUNTIME:
 * node | deno | none) and, when set, TRANSCRIBE_URL_REMOTE_COMPONENTS.
 *
 * Limits: TRANSCRIBE_URL_MAX_SECONDS (default 3 h of audio per call — ask for
 * a range beyond that), TRANSCRIBE_URL_TIMEOUT_MS (default 20 min),
 * TRANSCRIBE_URL_YTDLP (binary, default `yt-dlp`), FFMPEG_PATH,
 * TRANSCRIBE_URL_BROWSER_DISCOVERY (`0` disables the browser rung),
 * TRANSCRIBE_URL_DISCOVERY_TIMEOUT_MS (default 30 s).
 * Fully injectable (`deps.runCommand`, `deps.transcribe`, `deps.saveArtifact`,
 * `deps.dnsCheck`, `deps.fs`, `deps.discoverMedia`, `deps.cookieJar`,
 * `deps.loadAttachedCookies`) so the tests run without network or binaries.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { z } = require('zod');
const { assertSafeUrl } = require('./web-fetch-tool');
const { buildUntrustedChildEnv } = require('../../../utils/untrusted-child-env');
const { composeAbortSignals } = require('../../../utils/abort-signals');
const mediaDiscovery = require('./media-discovery');
const cookieJar = require('./cookie-jar-store');
const mediaCapture = require('./media-capture');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_SECONDS = 3 * 60 * 60;
// Long sections leave the chat turn: the downloaded audio becomes the
// user's own media file, the durable media queue transcribes it (resumable
// across deploys, partial results, professional pack) and the result is
// posted into this chat with a notification.
const DEFAULT_DURABLE_MIN_SECONDS = 20 * 60;
const DEFAULT_DURABLE_MAX_SECONDS = 12 * 60 * 60;
const MAX_TEXT_CHARS = 60_000;
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
/** The chat computer may be cold (container + Chrome) and the player is a heavy SPA. */
const COMPUTER_DISCOVERY_TIMEOUT_MS = 60_000;
/** Time kept for transcription + delivery after a capture. */
const TRANSCRIBE_RESERVE_MS = 4 * 60 * 1000;

/**
 * The harness timeout for one transcribe_url call (it otherwise cuts every
 * tool at 2 min, far below a download + transcription of a long class).
 */
function toolTimeoutMs(env = process.env) {
  const explicit = Number(env.TRANSCRIBE_URL_TOOL_TIMEOUT_MS);
  if (explicit > 0) return explicit;
  const step = Number(env.TRANSCRIBE_URL_TIMEOUT_MS) > 0 ? Number(env.TRANSCRIBE_URL_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  return step + 10 * 60 * 1000;
}
/** yt-dlp verdicts that mean «the page is not a platform yt-dlp knows» — worth a look with the browser. */
const DISCOVERY_ELIGIBLE = new Set(['media_unsupported_url', 'media_download_failed', 'media_login_required', 'media_not_found', 'ytdlp_missing', 'media_rate_limited', 'media_timeout']);

class TranscribeUrlError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TranscribeUrlError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ─── Timecodes ────────────────────────────────────────────────────────────

/**
 * «90» → 90 s · «1:30» → 90 · «01:02:03» → 3723 · «1.5m» / «1,5 min» /
 * «minuto 1.5» → 90 · «2h» → 7200. A bare number is SECONDS; the model is
 * told so in the schema. Returns null for anything else.
 */
function parseTimecode(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const raw = String(value).trim().toLowerCase().replace(',', '.');
  if (!raw) return null;
  let m = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(raw);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]); const c = m[3] == null ? null : Number(m[3]);
    if (c == null) return a * 60 + b;
    return a * 3600 + b * 60 + c;
  }
  m = /^(?:min(?:uto)?s?\s*)?(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutos?)$/.exec(raw) || /^min(?:uto)?s?\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|horas?)$/.exec(raw);
  if (m) return Math.round(Number(m[1]) * 3600);
  m = /^(\d+(?:\.\d+)?)\s*(?:s|seg|segundos?|sec|secs)?$/.exec(raw);
  if (m) return Number(m[1]);
  return null;
}

/**
 * «del minuto 60 al minuto 1:20» — after a start past the hour, an «a:bb» end
 * that would fall BEFORE the start is hours:minutes (1:20 → 1:20:00), not
 * minutes:seconds. Returns the corrected end, or the parsed one unchanged.
 */
function resolveRangeEnd(start, end, rawEnd) {
  if (start == null || end == null || end > start || start < 3600) return end;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(rawEnd == null ? '' : rawEnd));
  if (!m) return end;
  const asHours = Number(m[1]) * 3600 + Number(m[2]) * 60;
  return asHours > start ? asHours : end;
}

function fmtClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}

function fmtSrtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)},${String(ms).padStart(3, '0')}`;
}

// ─── Processes ────────────────────────────────────────────────────────────

/** Runs a binary with a scrubbed env; resolves {code, stdout, stderr}; kills on timeout/abort. */
function runCommand(bin, args, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, cwd, extraEnv = {}, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, env: buildUntrustedChildEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(Object.assign(new Error(`cannot spawn ${bin}: ${err && err.message}`), { code: err && err.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED' }));
      return;
    }
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } finish(reject, Object.assign(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)} s`), { code: 'TIMEOUT' })); }, timeoutMs);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => { if (stdout.length < MAX_COMMAND_OUTPUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_COMMAND_OUTPUT) stderr += d.toString('utf8'); });
    child.on('error', (err) => finish(reject, Object.assign(new Error(`${path.basename(bin)}: ${err && err.message}`), { code: err && err.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED' })));
    child.on('close', (code) => finish(resolve, { code: code == null ? -1 : code, stdout, stderr }));
  });
}

function classifyDownloadFailure(stderr, err) {
  const text = String((stderr || '') + ' ' + (err && err.message || '')).toLowerCase();
  if (err && err.code === 'ENOENT') return 'ytdlp_missing';
  if (err && err.code === 'TIMEOUT') return 'media_timeout';
  if (/sign in|log ?in|login|private video|members[- ]only|requires authentication|cookies|http error 40[13]|unauthorized|forbidden|paywall|drm/.test(text)) return 'media_login_required';
  if (/unsupported url|is not a valid url|no video formats|no suitable|not a valid|unable to extract/.test(text) && !/http error 40[13]/.test(text)) return 'media_unsupported_url';
  if (/http error 404|not found|does not exist|video unavailable|has been removed|is unavailable|no longer available/.test(text)) return 'media_not_found';
  if (/http error 429|rate.?limit|too many requests/.test(text)) return 'media_rate_limited';
  return 'media_download_failed';
}

const USER_MESSAGES = Object.freeze({
  media_login_required: 'El enlace pide iniciar sesión (cuenta institucional, video privado o acceso restringido), así que sin tu sesión no puedo sacar el audio desde aquí. Dos caminos: (1) descarga el video o audio desde la plataforma y adjúntalo en el chat; (2) adjunta UNA sola vez tu archivo cookies.txt de ese sitio (expórtalo con la extensión «Get cookies.txt LOCALLY» en Chrome/Edge con la sesión abierta) y lo guardaré cifrado para que los próximos enlaces de esa plataforma se transcriban solos.',
  media_login_in_computer: 'La grabación pide iniciar sesión. La abrí en la computadora de este chat (panel de la derecha): entra ahí con tu cuenta —la contraseña la escribes tú, yo no la veo— y luego escribe «listo». La sesión queda guardada en esa computadora, así que los próximos enlaces de ese sitio se transcriben sin volver a pedírtela. También puedes adjuntar el video o el audio.',
  media_unsupported_url: 'Abrí el enlace con el navegador y no encontré ningún video o audio reproducible en esa página. Pásame el enlace directo del video, o adjunta el archivo; si la página pide iniciar sesión, adjunta tu cookies.txt de ese sitio una vez.',
  media_not_found: 'El enlace no existe o el contenido fue retirado (404). Revisa el enlace.',
  media_rate_limited: 'La plataforma del enlace limitó las descargas por ahora. Intenta en unos minutos o adjunta el archivo.',
  media_too_long: 'El contenido supera el máximo por llamada. Dime el rango que necesitas (de tal minuto a tal minuto) y lo transcribo por partes.',
  media_timeout: 'La descarga o la transcripción tardó más del tiempo máximo. Prueba con un rango más corto.',
  media_download_failed: 'No pude descargar el audio del enlace. Si es un video público, pásame el enlace directo; si es privado, adjunta el archivo.',
  ytdlp_missing: 'El servidor no tiene instalado el descargador de medios (yt-dlp); avisa al administrador.',
  ffmpeg_failed: 'No pude recortar o convertir el audio descargado.',
  transcription_failed: 'Descargué el audio pero ningún motor de transcripción pudo procesarlo ahora.',
  invalid_range: 'El rango no es válido: el inicio debe ser menor que el fin y estar dentro de la duración del contenido.',
  invalid_url: 'El enlace no es una URL http(s) pública válida.',
});

/** Last non-empty line of a process' stderr — the actionable one. */
function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function errorResult(code, detail, extra = {}) {
  return {
    ok: false,
    code,
    userMessage: USER_MESSAGES[code] || USER_MESSAGES.media_download_failed,
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    ...extra,
  };
}

// ─── Core ─────────────────────────────────────────────────────────────────

function safeTitle(title) {
  const base = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return base || 'transcripcion';
}

function buildTimestampedText(segments, { offset = 0 } = {}) {
  const lines = [];
  let paragraph = []; let paragraphStart = null; let lastEnd = null;
  const flush = () => {
    if (!paragraph.length) return;
    lines.push(`[${fmtClock(paragraphStart)}] ${paragraph.join(' ')}`);
    paragraph = []; paragraphStart = null;
  };
  for (const seg of segments) {
    const start = Number(seg.start) + offset;
    if (paragraphStart == null) paragraphStart = start;
    // New paragraph every ~25 s of speech or on a long pause.
    if (lastEnd != null && (start - lastEnd > 2.5 || start - paragraphStart > 25)) { flush(); paragraphStart = start; }
    paragraph.push(String(seg.text || '').trim());
    lastEnd = Number(seg.end) + offset;
  }
  flush();
  return lines.join('\n');
}

function buildSrt(segments, { offset = 0 } = {}) {
  return segments.map((seg, i) => `${i + 1}\n${fmtSrtTime(Number(seg.start) + offset)} --> ${fmtSrtTime(Number(seg.end) + offset)}\n${String(seg.text || '').trim()}\n`).join('\n');
}

/**
 * The recording's title for the user's own file name: accents and case kept
 * (the media queue primes the recogniser with its proper nouns), path and
 * control characters removed. safeTitle stays for temp clip names.
 */
function displayTitle(title) {
  const base = String(title || '').normalize('NFC').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || 'transcripcion';
}

// ─── Glossary and platform captions (contract C7) ─────────────────────────

const GENERIC_TITLE_WORDS = new Set(['audio', 'video', 'vídeo', 'clase', 'clases', 'grabacion', 'grabación', 'reunion', 'reunión',
  'sesion', 'sesión', 'parte', 'capitulo', 'capítulo', 'episodio', 'completo', 'completa', 'oficial', 'official', 'video',
  'full', 'live', 'directo', 'stream', 'podcast', 'entrevista', 'interview', 'conferencia', 'charla', 'tutorial', 'curso']);
const SENTENCE_STARTERS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'y', 'pero', 'hoy', 'bueno', 'entonces', 'ahora', 'esto',
  'este', 'esta', 'eso', 'en', 'de', 'que', 'si', 'no', 'yo', 'nosotros', 'vamos', 'muy', 'the', 'and', 'so', 'now', 'this', 'it', 'we', 'i']);
const MAX_GLOSSARY_TERMS = 20;

function formatModule() {
  try { return require('../../media-transcript-format'); } catch (_) { return null; }
}

/** Proper nouns / subject words of a title («Clase 12 · Bioquímica (Dr. Pérez)» → Bioquímica, Pérez). */
function titleTerms(title) {
  const fmt = formatModule();
  const words = String(title || '').normalize('NFC').split(/[^\p{L}\p{N}'’-]+/u)
    .filter(word => word.length >= 4 && /\p{L}/u.test(word) && !/^\d+$/.test(word)
      && !GENERIC_TITLE_WORDS.has(word.toLowerCase())
      && (/^\p{Lu}/u.test(word) || /[áéíóúñü]/i.test(word))
      && !(fmt && fmt.isDeviceIdentifierToken(word)));
  return [...new Set(words)].slice(0, 10);
}

/** Capitalised words used mid-sentence in captions (names, places), most frequent first. */
function captionTerms(cues = []) {
  const counts = new Map();
  for (const cue of cues) {
    const words = String(cue.text || '').split(/\s+/);
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (word.length < 4 || !/^\p{Lu}\p{Ll}/u.test(word)) return;
      const prev = index > 0 ? words[index - 1] : '';
      if (index === 0 || /[.!?¿¡:]$/.test(prev) || SENTENCE_STARTERS.has(word.toLowerCase())) return;
      counts.set(word, (counts.get(word) || 0) + 1);
    });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word).slice(0, MAX_GLOSSARY_TERMS);
}

function glossaryFor(title, captions) {
  const fmt = formatModule();
  const raw = [...titleTerms(title), ...((captions && captions.tracks) || []).flatMap(track => captionTerms(track.cues))];
  const terms = fmt ? fmt.normalizeHintTerms(raw) : [...new Set(raw)];
  return terms.slice(0, MAX_GLOSSARY_TERMS);
}

const CAPTION_TIMEOUT_MS = 60_000;
const CAPTION_MAX_BYTES = 4 * 1024 * 1024;
const CAPTION_MIN_COVERAGE = 0.9;
const CAPTION_FALLBACK_MIN_COVERAGE = 0.3;
const CAPTION_COVERAGE_TOLERANCE_SEC = 2.5;
const CAPTION_SPOT_SECONDS = 60;
const CAPTION_SPOT_MIN_WORDS = 6;
const CAPTION_SPOT_MIN_AGREEMENT = 0.5;
// The whole spot check (its ≤ 2 samples) has its own deadline and the short
// admission lane: two long lectures holding the shared transcription slots
// for hours must never park a link here until the tool times out.
const CAPTION_SPOT_TIMEOUT_MS = 90_000;
const CAPTION_TIMING_RE = /((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

function baseLanguage(code) {
  const base = String(code || '').toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

function captionClock(value) {
  const parts = String(value).replace(',', '.').split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return NaN;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

function cleanCaptionLine(line) {
  const stripped = String(line || '').replace(/<\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?>/g, '');
  let cleaned = stripped;
  try { cleaned = require('../../media-probe').cleanSubtitleText(stripped); } catch (_) {
    cleaned = stripped.replace(/<\/?[a-zA-Z][^<>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}

/**
 * WebVTT / SRT text → cues [{ start, end, text }] on the recording clock.
 * Rolling captions (YouTube's automatic ones repeat the previous line in
 * every cue) keep only each cue's new lines. Pure; never throws.
 */
function parseCaptionText(text) {
  const cues = [];
  let previous = [];
  for (const block of String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex(line => CAPTION_TIMING_RE.test(line));
    if (at < 0) continue;
    const m = CAPTION_TIMING_RE.exec(lines[at]);
    const start = captionClock(m[1]);
    const end = captionClock(m[2]);
    const textLines = lines.slice(at + 1).map(cleanCaptionLine).filter(Boolean);
    const fresh = textLines.filter(line => !previous.includes(line));
    if (textLines.length) previous = textLines;
    const value = fresh.join(' ').replace(/\s+/g, ' ').trim();
    if (!value || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const last = cues[cues.length - 1];
    if (last && last.text === value && start - last.end <= 1) { last.end = Math.max(last.end, end); continue; }
    cues.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: value });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Share of [from, to] the cues cover (pauses up to ±2.5 s count as covered). */
function captionCoverage(cues, from, to) {
  if (!(to > from)) return 0;
  const spans = cues.map(cue => [Math.max(from, cue.start - CAPTION_COVERAGE_TOLERANCE_SEC), Math.min(to, cue.end + CAPTION_COVERAGE_TOLERANCE_SEC)])
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let cursor = from;
  for (const [a, b] of spans) {
    const start = Math.max(a, cursor);
    if (b > start) { covered += b - start; cursor = b; }
  }
  return Math.max(0, Math.min(1, covered / (to - from)));
}

function cuesInRange(cues, from, to) {
  return cues.filter(cue => cue.end > from && (to == null || cue.start < to))
    .map(cue => ({ start: Math.max(from, cue.start), end: to == null ? cue.end : Math.min(to, cue.end), text: cue.text }));
}

function wordSet(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9ñ]+/).filter(word => word.length >= 3));
}

/**
 * The platform's caption tracks listed by the probe: { manual: Map(base→key),
 * auto: Map(base→key), manualKeys: Set(key), language }. `manualKeys` holds
 * the EXACT keys of the human tracks: a fetched file is human only when its
 * own key is one of them (manual «es-419» next to automatic «es», manual
 * «en» next to automatic «en-orig» share a base but not a kind).
 */
function listCaptionTracks(info) {
  const out = { manual: new Map(), auto: new Map(), manualKeys: new Set(), language: baseLanguage(info && info.language) };
  const add = (map, dict, keys = null) => {
    if (!dict || typeof dict !== 'object') return;
    for (const key of Object.keys(dict).slice(0, 200)) {
      if (/live_chat|rechat/i.test(key)) continue;
      const base = baseLanguage(key);
      if (!base) continue;
      if (keys) keys.add(key);
      // «es-orig» is the original-language automatic track: preferred.
      if (!map.has(base) || /-orig$/i.test(key)) map.set(base, key);
    }
  };
  add(out.manual, info && info.subtitles, out.manualKeys);
  add(out.auto, info && info.automatic_captions);
  return out;
}

/** The kind of one fetched caption file, by its own key («es-419», «en-orig»). */
function captionKindFor(tracks, key) {
  return tracks && tracks.manualKeys && tracks.manualKeys.has(key) ? 'manual' : 'auto';
}

/**
 * The caption track to fall back on when no voice is recognised: the
 * audio's language first, human before automatic, then coverage. Only tracks
 * covering ≥ 30 % of the range count. → { track, end, coverage } | null.
 */
function pickFallbackCaptions(captions, { known = null, rangeStart = 0, rangeEnd = null } = {}) {
  if (!captions || !Array.isArray(captions.tracks) || !captions.tracks.length) return null;
  const ranked = captions.tracks.filter(track => Array.isArray(track.cues) && track.cues.length).map((track) => {
    const end = rangeEnd != null ? rangeEnd : track.cues[track.cues.length - 1].end;
    return { track, end, coverage: captionCoverage(track.cues, rangeStart, end) };
  }).filter(item => item.coverage >= CAPTION_FALLBACK_MIN_COVERAGE)
    .sort((a, b) => (Number(b.track.language === known) - Number(a.track.language === known))
      || (Number(b.track.kind === 'manual') - Number(a.track.kind === 'manual')) || (b.coverage - a.coverage));
  return ranked[0] || null;
}

// What a hand-off keeps of the platform captions for the durable job.
const LINK_CAPTIONS_MAX_CUES = 6000;
const LINK_CAPTIONS_MAX_CHARS = 256 * 1024;

/**
 * The stored form of a fallback caption track (bounded): cues in the range,
 * on the RECORDING's clock, with language, kind and coverage. Pure.
 */
function linkCaptionsRecord(pick, { rangeStart = 0, rangeEnd = null } = {}) {
  if (!pick || !pick.track) return null;
  const segments = [];
  let chars = 0;
  let truncated = false;
  for (const cue of cuesInRange(pick.track.cues, rangeStart, rangeEnd != null ? rangeEnd : pick.end)) {
    const text = String(cue.text || '').slice(0, 500);
    if (!text) continue;
    if (segments.length >= LINK_CAPTIONS_MAX_CUES || chars + text.length > LINK_CAPTIONS_MAX_CHARS) { truncated = true; break; }
    chars += text.length;
    segments.push({ start: Math.round(cue.start * 1000) / 1000, end: Math.round(cue.end * 1000) / 1000, text });
  }
  if (!segments.length) return null;
  return { version: 1, source: 'platform_captions', clock: 'recording', language: pick.track.language,
    kind: pick.track.kind === 'manual' ? 'manual' : 'auto', coverage: Math.round(pick.coverage * 1000) / 1000,
    ...(truncated ? { truncated: true } : {}), segments };
}

/**
 * Durable, owner-scoped copy of a link's fallback captions in
 * DocumentAnalysis.metadata.linkCaptions (deleted with the File). The media
 * queue reads it back (readLinkCaptions) when the durable ASR fails or finds
 * no voice. Never throws: { ok } | { ok: false, reason }.
 */
async function recordLinkCaptions(prisma, { fileId, userId, mimeType = null, captions } = {}) {
  if (!captions || !Array.isArray(captions.segments) || !captions.segments.length) return { ok: false, reason: 'empty' };
  if (!fileId || !userId || !prisma || !prisma.documentAnalysis || typeof prisma.documentAnalysis.upsert !== 'function') {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    let metadata = {};
    if (typeof prisma.documentAnalysis.findUnique === 'function') {
      const existing = await prisma.documentAnalysis.findUnique({ where: { fileId }, select: { userId: true, metadata: true } });
      if (existing && existing.userId !== String(userId)) return { ok: false, reason: 'foreign' };
      if (existing && existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)) metadata = existing.metadata;
    }
    const linkCaptions = { ...captions, recordedAt: new Date().toISOString() };
    await prisma.documentAnalysis.upsert({
      where: { fileId },
      create: { userId: String(userId), fileId, status: 'pending', mimeType, metadata: { linkCaptions } },
      update: { metadata: { ...metadata, linkCaptions } },
    });
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'write_failed' };
  }
}

/** The stored fallback captions of a file of `userId`, or null (owner-scoped). Never throws. */
async function readLinkCaptions(prisma, { fileId, userId } = {}) {
  if (!fileId || !userId || !prisma || !prisma.documentAnalysis || typeof prisma.documentAnalysis.findUnique !== 'function') return null;
  try {
    const row = await prisma.documentAnalysis.findUnique({ where: { fileId }, select: { userId: true, metadata: true } });
    const record = row && row.userId === String(userId) && row.metadata && row.metadata.linkCaptions;
    if (!record || record.version !== 1 || !Array.isArray(record.segments) || !record.segments.length) return null;
    const segments = record.segments.slice(0, LINK_CAPTIONS_MAX_CUES)
      .map(seg => ({ start: Number(seg.start), end: Number(seg.end), text: String(seg.text || '').slice(0, 500) }))
      .filter(seg => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end >= seg.start && seg.text);
    if (!segments.length) return null;
    return { source: 'platform_captions', clock: 'recording', language: baseLanguage(record.language),
      kind: record.kind === 'manual' ? 'manual' : 'auto', coverage: Number(record.coverage) || null,
      ...(record.truncated ? { truncated: true } : {}), segments };
  } catch (_) {
    return null;
  }
}

/** The language bases worth fetching (the asked/audio language first, then manual tracks), ≤ 3. */
function captionBasesToFetch(tracks, wanted) {
  const bases = [];
  for (const base of [baseLanguage(wanted), tracks.language, ...tracks.manual.keys()]) {
    if (base && !bases.includes(base) && (tracks.manual.has(base) || tracks.auto.has(base))) bases.push(base);
    if (bases.length >= 3) break;
  }
  return bases;
}

/** Netscape cookie jar of THIS turn's attachments (ownership re-checked), or null. */
async function loadAttachedCookies(ctx = {}, deps = {}) {
  const prisma = ctx.prisma || null;
  const ids = (Array.isArray(ctx.fileIds) ? ctx.fileIds : []).map(String).filter(Boolean);
  if (!prisma || !ctx.userId || !ids.length) return null;
  let rows = [];
  try { rows = await prisma.file.findMany({ where: { id: { in: ids }, userId: ctx.userId } }); } catch (_) { return null; }
  const fsImpl = deps.fs || fs;
  for (const row of rows) {
    const name = String(row.originalName || row.filename || '').toLowerCase();
    const mime = String(row.mimeType || '').toLowerCase();
    const size = Number(row.size) || 0;
    const plausible = /\.txt$/.test(name) || /cookie/.test(name) || mime.startsWith('text/');
    if (!plausible || size > cookieJar.MAX_JAR_BYTES || !row.path) continue;
    let text = null;
    try {
      const objectStorage = deps.objectStorage || require('../../object-storage');
      if (objectStorage.isRemote(row.path)) {
        const local = await objectStorage.toLocalTemp(row.path);
        try { text = await fsImpl.promises.readFile(local.path, 'utf8'); } finally { await local.cleanup(); }
      } else {
        text = await fsImpl.promises.readFile(row.path, 'utf8');
      }
    } catch (_) { text = null; }
    if (text && cookieJar.isNetscapeCookieText(text)) return { text, filename: row.originalName || row.filename || 'cookies.txt', fileId: row.id };
  }
  return null;
}

/**
 * The chat computer as a discovery rung: `available(ctx)`, `discover(url, ctx,
 * opts) → { disc, session }` (media-discovery attached to the computer's live
 * Chrome over CDP) and `show(session, url, ctx)` (open the page in the visible
 * tab for the sign-in). Off when the computer feature is off for the user.
 */
function defaultComputer(env) {
  return {
    available: (ctx = {}) => {
      if (!ctx.userId || String(env.TRANSCRIBE_URL_COMPUTER || '1') === '0') return false;
      try { return Boolean(require('../../computer/persistent').computerToolsAvailable({ userId: ctx.userId, env })); } catch (_) { return false; }
    },
    discover: async (pageUrl, ctx = {}, opts = {}) => {
      const persistent = require('../../computer/persistent');
      const livePage = require('../../computer/live-page');
      const session = await persistent.ensureSession({ userId: ctx.userId, conversationId: ctx.chatId || '', env });
      const disc = await mediaDiscovery.discoverMedia(pageUrl, {
        ...opts,
        attach: async () => {
          const browser = await livePage.connectLiveBrowser(session, env, opts.signal || undefined);
          return { browser, context: browser.contexts()[0] };
        },
      });
      return { disc, session };
    },
    capture: async (pageUrl, ctx = {}, opts = {}) => {
      const persistent = require('../../computer/persistent');
      const livePage = require('../../computer/live-page');
      const session = await persistent.ensureSession({ userId: ctx.userId, conversationId: ctx.chatId || '', env });
      return mediaCapture.captureMediaAudio(pageUrl, {
        ...opts,
        cookies: [],
        attach: async () => {
          const browser = await livePage.connectLiveBrowser(session, env, opts.signal || undefined);
          return { browser, context: browser.contexts()[0] };
        },
      });
    },
    show: async (session, pageUrl, ctx = {}) => {
      await require('../../computer/live-page').navigatePage(session, pageUrl, env, ctx.signal || undefined);
    },
  };
}

/**
 * The capture rung: the chat computer's Chrome first (the user's sessions,
 * real codecs), then a headless Chromium with the saved cookies.
 */
function defaultCapture(env, computer) {
  return async (pageUrl, ctx = {}, opts = {}) => {
    if (computer && typeof computer.capture === 'function' && (await safeAvailable(computer, ctx))) {
      try {
        const r = await computer.capture(pageUrl, ctx, opts);
        if (r && (r.ok || r.reason === 'drm_protected' || r.reason === 'login_wall')) return { ...r, browser: 'computer' };
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
      }
    }
    const r = await mediaCapture.captureMediaAudio(pageUrl, { ...opts, env });
    return { ...r, browser: 'browser' };
  };
}

async function safeAvailable(computer, ctx) {
  try { return Boolean(await computer.available(ctx)); } catch (_) { return false; }
}

function durableConfig(env = process.env, ctx = {}, deps = {}) {
  const minRaw = Number(env.TRANSCRIBE_URL_DURABLE_MIN_SECONDS);
  const maxRaw = Number(env.TRANSCRIBE_URL_DURABLE_MAX_SECONDS);
  const enabled = String(env.TRANSCRIBE_URL_DURABLE || '1') !== '0' && Boolean(ctx.userId) && Boolean(ctx.chatId)
    && (deps.durableHandoff !== null);
  return {
    enabled,
    minSeconds: Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : DEFAULT_DURABLE_MIN_SECONDS,
    maxSeconds: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_DURABLE_MAX_SECONDS,
  };
}

/**
 * Best-effort cancel of a delivery record whose job could not be queued:
 * terminal 'failed' without posting anything into the chat.
 */
async function cancelDeliveryRecord(delivery, id) {
  const store = typeof delivery?.getMediaDeliveryService === 'function' ? delivery.getMediaDeliveryService()?.store : null;
  if (!id || !store || typeof store.claim !== 'function' || typeof store.markFailed !== 'function') return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Held only while a sweep is looking at it (it sees the file pending
    // and releases it at once).
    const held = await Promise.resolve(store.claim(id)).catch(() => null);
    if (held?.token) {
      const error = Object.assign(new Error('queue_unavailable'), { code: 'queue_unavailable' });
      return Boolean(await Promise.resolve(store.markFailed(id, held.token, error, { maxAttempts: 1 })).catch(() => null));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Default hand-off: copy the clip into the user's uploads, register it as a
 * media File, record where the clip sits on the recording's clock, record
 * the chat delivery and only then enqueue the durable transcription.
 * Returns { ok, fileId, deliveryId, message } or { ok:false, reason }; an
 * ok:false means no job was queued and nothing was left behind, so the
 * caller may transcribe inline without a twin job.
 * `services` (prisma, enqueueMediaTranscription, delivery, transcriptStore)
 * is for tests.
 */
/**
 * Generic durable hand-off of a local media file (a link clip, a runner
 * workspace recording): copy it into the user's uploads, register it as a
 * media File, record where it sits on the recording's clock, record the chat
 * delivery and only then enqueue the durable transcription. Returns
 * { ok, fileId, deliveryId, message } or { ok:false, reason } — an ok:false
 * means no job was queued and nothing was left behind.
 */
async function handOffMediaFile({ sourcePath, originalName, mimeType = 'audio/mp4', extension = '.m4a', filePrefix = 'link',
  displayName = null, goal = '', sourceInfo = null, offset = 0, subtitles = false, spanSec = null,
  language = null, hints = null, captions = null, ctx, env = process.env, logTag = '[transcribe_url]', services = {} }) {
  const crypto = require('node:crypto');
  const prisma = services.prisma || require('../../../config/database');
  const enqueueMediaTranscription = services.enqueueMediaTranscription || require('../../media-transcription-queue').enqueueMediaTranscription;
  const delivery = services.delivery || require('../../media-delivery');
  const transcriptStore = services.transcriptStore || require('../../media-transcript-store');
  if (!delivery.isMediaDeliveryEnabled(env)) return { ok: false, reason: 'delivery_disabled' };
  const uploadRoot = path.resolve(env.UPLOAD_DIR || 'uploads');
  const userDir = path.join(uploadRoot, String(ctx.userId).replace(/[^a-zA-Z0-9_-]/g, '_'));
  await fs.promises.mkdir(userDir, { recursive: true });
  // What the request said about the recording (contract C7): the language
  // and the glossary reach the delivery and the job.
  const normalizedHints = hints && typeof hints === 'object' && Object.keys(hints).length ? hints : null;
  let languageCode = null;
  try { languageCode = language ? require('../../media-transcript-format').normalizeHintLanguage(language) : null; } catch (_) { languageCode = null; }
  const media = { ...(languageCode ? { language: languageCode } : {}), ...(normalizedHints ? { hints: normalizedHints } : {}) };
  const safeExt = /^\.[a-z0-9]{1,6}$/i.test(String(extension)) ? String(extension).toLowerCase() : '.m4a';
  const filename = `${String(filePrefix).replace(/[^a-z0-9-]/gi, '') || 'media'}-${crypto.randomBytes(8).toString('hex')}${safeExt}`;
  const target = path.join(userDir, filename);
  let size;
  try {
    await fs.promises.copyFile(sourcePath, target);
    ({ size } = await fs.promises.stat(target));
  } catch (err) {
    await fs.promises.rm(target, { force: true }).catch(() => {});
    throw err;
  }
  let row;
  try {
    row = await prisma.file.create({ data: { userId: ctx.userId, filename, originalName, mimeType, size,
      path: target, processingStage: 'uploaded', processingStageAt: new Date() } });
  } catch (err) {
    await fs.promises.rm(target, { force: true }).catch(() => {});
    throw err;
  }
  // No job exists yet: remove the File, the copy and the offset record.
  const discard = async (reason) => {
    try { await prisma.file.delete({ where: { id: row.id } }); } catch (_) {
      try { await prisma.file.update({ where: { id: row.id }, data: { deletedAt: new Date() } }); } catch (__) { /* best-effort */ }
    }
    await fs.promises.rm(target, { force: true }).catch(() => {});
    if (offset) await Promise.resolve(transcriptStore.recordMediaClipOffset({ fileId: row.id, userId: ctx.userId, timeOffsetSec: 0, env })).catch(() => {});
    return { ok: false, reason, fileId: row.id };
  };
  if (offset) {
    // Durable copy for a lost job that reconcile re-queues with only
    // { fileId, userId }; the job itself also carries the offset.
    const recorded = await Promise.resolve(transcriptStore.recordMediaClipOffset({ fileId: row.id, userId: ctx.userId, timeOffsetSec: offset, prisma, env }))
      .catch(() => null);
    if (!recorded?.ok) console.warn(`${logTag} clip offset not recorded; the queued job still carries it`, recorded?.reason || 'record_error');
  }
  // The platform's captions (a link): kept with the File for the queue's
  // fallback when the durable ASR fails or finds no voice. Best-effort.
  if (captions) {
    const kept = await Promise.resolve(recordLinkCaptions(prisma, { fileId: row.id, userId: ctx.userId, mimeType, captions }))
      .catch(() => ({ ok: false, reason: 'write_failed' }));
    if (!kept.ok && kept.reason !== 'unavailable') console.warn(`${logTag} platform captions not kept for the fallback`, kept.reason);
  }
  // The delivery exists before the job, so a job that finishes at once
  // always finds it.
  let record = null;
  try {
    record = await delivery.createDelivery({
      userId: ctx.userId, chatId: ctx.chatId, taskId: ctx.taskId || null,
      fileIds: [row.id], fileNames: [originalName], goal,
      mode: subtitles ? 'subtitles' : 'transcript', formats: ['txt', ...(subtitles ? ['srt', 'vtt'] : [])],
      range: null,
      // The stored transcript is already on the recording's clock.
      output: { documentFormat: null, wantsSubtitles: Boolean(subtitles), timeOffsetSec: 0 },
      ...(sourceInfo ? { source: sourceInfo } : {}),
      ...media,
    });
  } catch (err) {
    return discard((err && err.code) || 'delivery_error');
  }
  if (!record) return discard('delivery_unavailable');
  try {
    await enqueueMediaTranscription({ fileId: row.id, userId: ctx.userId, timeOffsetSec: offset, ...media });
  } catch (err) {
    // Without a job the delivery would wait for nothing: cancel it, then
    // drop the File so the caller can transcribe inline. If the record
    // cannot be taken, keep the hand-off: reconcile re-queues the
    // uploaded File and the delivery posts it.
    if (await cancelDeliveryRecord(delivery, record.id)) return discard((err && err.code) || 'queue_unavailable');
    console.warn(`${logTag} media job not queued; delivery kept for reconcile`, (err && err.code) || 'queue_error');
  }
  const shownName = displayName || originalName;
  let etaSeconds = null;
  let message = '';
  try {
    etaSeconds = typeof delivery.estimateTranscriptionSeconds === 'function' && spanSec != null
      ? delivery.estimateTranscriptionSeconds({ durationSec: spanSec }) : null;
    message = delivery.handOffMessage({ fileNames: [shownName], durationSec: spanSec, etaSeconds });
  } catch (_) { message = ''; }
  if (!message) message = `Recibí «${shownName}». Te aviso aquí cuando la transcripción esté lista.`;
  return { ok: true, fileId: row.id, deliveryId: record.id, message };
}

/**
 * Default link hand-off: the clip becomes the user's media File (the title's
 * accents kept), on the recording's clock, with its delivery and job.
 * `services` (prisma, enqueueMediaTranscription, delivery, transcriptStore)
 * is for tests.
 */
async function defaultDurableHandoff({ clipPath, title, url, rangeStart, rangeEnd, spanSec, sectioned, subtitles, ctx, env,
  language = null, hints = null, captions = null, services = {} }) {
  const label = sectioned ? ` (${fmtClock(rangeStart)}-${fmtClock(rangeEnd != null ? rangeEnd : rangeStart + spanSec)})` : '';
  // The user's own file keeps the title's accents and case: the media queue
  // primes the recogniser with its proper nouns (keytermsFromFileName).
  const originalName = `${displayTitle(title)}${label}.m4a`.replace(/:/g, '.');
  // Where the clip starts on the recording's clock. The queue shifts the
  // transcript onto that clock before storing it (File text, sidecar), so
  // the preview, follow-ups and files all read the recording's own times.
  const offset = sectioned && rangeStart > 0 ? rangeStart : 0;
  return handOffMediaFile({ sourcePath: clipPath, originalName, mimeType: 'audio/mp4', extension: '.m4a', filePrefix: 'link',
    displayName: `${title}${label}`, goal: `Transcripción de ${url.href}`, sourceInfo: { url: url.href, host: url.hostname, title },
    offset, subtitles, spanSec, language, hints, captions, ctx, env, services });
}

async function executeTranscribeUrl(args = {}, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.runCommand || runCommand;
  const transcribeImpl = deps.transcribe || ((...a) => require('../../audio-transcriber').transcribe(...a));
  const saveArtifactImpl = deps.saveArtifact || ((...a) => require('../../agents/task-tools').saveArtifact(...a));
  const dnsCheck = deps.dnsCheck || (async (hostname) => require('../../connectors/web-fetch').resolveAndAssertSafe(hostname));
  const discoverImpl = deps.discoverMedia || mediaDiscovery.discoverMedia;
  const jar = deps.cookieJar || { save: (userId, text) => cookieJar.saveUserCookies(userId, text, { env }), load: (userId) => cookieJar.loadUserCookies(userId, { env }) };
  const loadAttached = deps.loadAttachedCookies || loadAttachedCookies;
  const computer = deps.computer === undefined ? defaultComputer(env) : deps.computer;
  const captureImpl = String(env.TRANSCRIBE_URL_CAPTURE || '1') === '0' ? null : (deps.capture === undefined ? defaultCapture(env, computer) : deps.capture);
  const captureMaxRate = Math.min(4, Math.max(1, Number(env.TRANSCRIBE_URL_CAPTURE_MAX_RATE) || 2));
  const fsImpl = deps.fs || fs;
  const ytdlp = env.TRANSCRIBE_URL_YTDLP || 'yt-dlp';
  const ffmpeg = env.FFMPEG_PATH || 'ffmpeg';
  const timeoutMs = Number(env.TRANSCRIBE_URL_TIMEOUT_MS) > 0 ? Number(env.TRANSCRIBE_URL_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const inlineMaxSeconds = Number(env.TRANSCRIBE_URL_MAX_SECONDS) > 0 ? Number(env.TRANSCRIBE_URL_MAX_SECONDS) : DEFAULT_MAX_SECONDS;
  const durable = durableConfig(env, ctx, deps);
  const durableImpl = deps.durableHandoff || defaultDurableHandoff;
  const probeDuration = deps.probeDuration || ((filePath, opts) => require('../../audio-transcriber').probeAudioDuration(filePath, opts));
  // With the durable path a 5-hour class fits in one call; without it the
  // inline ceiling applies (the turn would hold the transcription).
  const maxSeconds = durable.enabled ? Math.max(inlineMaxSeconds, durable.maxSeconds) : inlineMaxSeconds;
  const discoveryEnabled = String(env.TRANSCRIBE_URL_BROWSER_DISCOVERY || '1') !== '0';
  const captionsEnabled = String(env.TRANSCRIBE_URL_PLATFORM_CAPTIONS || '1') !== '0';
  const discoveryTimeoutMs = Number(env.TRANSCRIBE_URL_DISCOVERY_TIMEOUT_MS) > 0 ? Number(env.TRANSCRIBE_URL_DISCOVERY_TIMEOUT_MS) : DISCOVERY_TIMEOUT_MS;
  const signal = ctx.signal || null;
  const startedAt = Date.now();
  // Whole-call deadline (the harness cuts the tool at toolTimeoutMs(env)).
  const toolDeadline = startedAt + toolTimeoutMs(env) - 30_000;

  // 1. URL
  let url;
  try {
    url = assertSafeUrl(args.url);
    if (typeof url !== 'object') url = new URL(String(args.url));
  } catch (err) {
    return errorResult('invalid_url', err && err.message);
  }
  try { await dnsCheck(url.hostname); } catch (err) { return errorResult('invalid_url', err && err.message); }

  // Range
  const start = parseTimecode(args.start);
  const end = resolveRangeEnd(start, parseTimecode(args.end), args.end);
  if ((args.start != null && args.start !== '' && start == null) || (args.end != null && args.end !== '' && end == null)) {
    return errorResult('invalid_range', 'start/end must be seconds or mm:ss / hh:mm:ss');
  }
  if (start != null && end != null && end <= start) return errorResult('invalid_range', 'end <= start');

  const workDir = await fsImpl.promises.mkdtemp(path.join(deps.tmpDir || os.tmpdir(), 'sira-transcribe-'));
  const cleanup = async () => { try { await fsImpl.promises.rm(workDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ } };
  try {
    // Session: a cookies.txt attached in this turn (saved for next time) or the
    // user's saved jar. Only hosts/counts are ever reported, never values.
    let cookiesText = null;
    let cookiesInfo = null;
    let cookiesPath = null;
    try {
      const attached = await loadAttached(ctx, deps);
      if (attached && attached.text) {
        cookiesText = attached.text;
        cookiesInfo = { source: 'attachment', hosts: cookieJar.cookieHosts(attached.text) };
        if (ctx.userId) {
          try { const saved = await jar.save(ctx.userId, attached.text); cookiesInfo.saved = true; cookiesInfo.hosts = saved.hosts; } catch (err) { cookiesInfo.saved = false; cookiesInfo.saveError = String((err && err.message) || err).slice(0, 120); }
        }
      } else if (ctx.userId) {
        const stored = await jar.load(ctx.userId);
        if (stored) { cookiesText = stored; cookiesInfo = { source: 'saved', hosts: cookieJar.cookieHosts(stored) }; }
      }
    } catch (_) { cookiesText = null; }
    const writeCookies = async () => {
      if (!cookiesText) return;
      cookiesPath = path.join(workDir, 'cookies.txt');
      await fsImpl.promises.writeFile(cookiesPath, cookiesText, { mode: 0o600 });
    };
    await writeCookies();

    const ytBase = () => {
      const base = ['--no-playlist', '--no-warnings'];
      const jsRuntime = String(env.TRANSCRIBE_URL_JS_RUNTIME || 'node').toLowerCase();
      if (jsRuntime === 'node') base.push('--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`);
      else if (jsRuntime !== 'none' && jsRuntime !== 'deno') base.push('--js-runtimes', jsRuntime);
      if (env.TRANSCRIBE_URL_REMOTE_COMPONENTS) base.push('--remote-components', String(env.TRANSCRIBE_URL_REMOTE_COMPONENTS));
      // YouTube lists ~150 machine-translated caption tracks: without this the
      // probe JSON can pass the 2 MB output cap and lose title and duration.
      base.push('--extractor-args', 'youtube:skip=translated_subs');
      // yt-dlp needs ffmpeg for --download-sections and HLS; point it at the
      // same binary we use (it only honours a binary actually named ffmpeg).
      if (path.isAbsolute(ffmpeg) && /^ffmpeg(\.exe)?$/i.test(path.basename(ffmpeg))) base.push('--ffmpeg-location', path.dirname(ffmpeg));
      if (cookiesPath) base.push('--cookies', cookiesPath);
      return base;
    };
    const headerArgs = (t) => (t.referer ? ['--referer', t.referer, '--add-headers', `User-Agent:${t.userAgent || mediaDiscovery.DESKTOP_UA}`] : []);

    const probeWith = async (t) => {
      try {
        const probe = await run(ytdlp, [...ytBase(), ...headerArgs(t), '--dump-single-json', '--skip-download', '--', t.href], { signal, timeoutMs: Math.min(timeoutMs, PROBE_TIMEOUT_MS), cwd: workDir });
        if (probe.code !== 0) return { ok: false, code: classifyDownloadFailure(probe.stderr), detail: lastLine(probe.stderr) };
        let info = null;
        try { info = JSON.parse(probe.stdout); } catch (_) { info = null; }
        return { ok: true, info };
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return { ok: false, code: classifyDownloadFailure('', err), detail: err && err.message };
      }
    };

    let target = { href: url.href, referer: null, userAgent: null, via: 'yt-dlp', direct: false, titleHint: null };
    let discovery = null;
    // The platform's caption tracks (contract C7): a glossary for the
    // recogniser, the fallback when no voice is recognised, and the
    // transcript itself only when they pass every check (verifyCaptions).
    let captions = null;
    const requestedLanguage = args.language ? String(args.language) : null;

    const fetchCaptions = async (t, info) => {
      if (!captionsEnabled || t.direct || !info) return null;
      const tracks = listCaptionTracks(info);
      if (!tracks.manual.size && !tracks.auto.size) return null;
      const bases = captionBasesToFetch(tracks, requestedLanguage);
      if (!bases.length) return null;
      const langs = bases.flatMap(base => [base, `${base}-.*`]).join(',');
      try {
        await run(ytdlp, [...ytBase(), ...headerArgs(t), '--skip-download', '--write-subs', '--write-auto-subs',
          '--sub-langs', langs, '--sub-format', 'vtt/srt/best', '-o', path.join(workDir, 'captions.%(ext)s'), '--', t.href],
        { signal, timeoutMs: Math.min(timeoutMs, CAPTION_TIMEOUT_MS), cwd: workDir });
        // A non-zero exit may still have written the tracks that matter.
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return null;
      }
      const found = [];
      let names = [];
      try { names = (await fsImpl.promises.readdir(workDir)).filter(name => /^captions\..+\.(vtt|srt)$/i.test(name)); } catch (_) { names = []; }
      for (const name of names.slice(0, 6)) {
        const key = name.replace(/^captions\./, '').replace(/\.(vtt|srt)$/i, '');
        const base = baseLanguage(key);
        if (!base) continue;
        let text = '';
        try {
          const stat = await fsImpl.promises.stat(path.join(workDir, name));
          if (stat.size > CAPTION_MAX_BYTES) continue;
          text = await fsImpl.promises.readFile(path.join(workDir, name), 'utf8');
        } catch (_) { continue; }
        const cues = parseCaptionText(text);
        if (!cues.length) continue;
        // Human only when THIS key is a listed human track: yt-dlp writes the
        // manual file when both kinds share a key, and fetches the automatic
        // one too when its key differs («es-419» manual, «es» automatic).
        found.push({ language: base, key, kind: captionKindFor(tracks, key), cues });
      }
      if (!found.length) return null;
      found.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === 'manual' ? -1 : 1));
      return { tracks: found, audioLanguage: tracks.language };
    };

    // 5. Deliver timed text: a .txt (and an .srt on request) as file cards plus
    // the capped text for the model. Shared by ASR and platform captions.
    const deliverText = ({ title, rangeStart, rangeEnd, duration, segments, offset, plain = '', language = null, via,
      partial = null, extra = {}, sourceLabel = null, note = null }) => {
      const body = segments.length >= 2 ? buildTimestampedText(segments, { offset }) : (plain || segments.map(seg => seg.text).join(' '));
      const rangeLabel = `${fmtClock(rangeStart)} → ${fmtClock(rangeEnd != null ? rangeEnd : rangeStart + (duration || 0))}`;
      const header = `Transcripción de «${title}» (${url.hostname.replace(/^www\./, '')}) · ${rangeLabel}${language ? ` · idioma: ${language}` : ''}${sourceLabel ? ` · fuente: ${sourceLabel}` : ''}\n\n${note ? `${note}\n\n` : ''}`;
      const fullText = header + body;
      let artifact = null; let srtArtifact = null;
      try {
        const saved = saveArtifactImpl({
          filename: `${safeTitle(title)} transcripcion ${fmtClock(rangeStart).replace(/:/g, '-')}.txt`,
          base64: Buffer.from(fullText, 'utf8').toString('base64'),
          mime: 'text/plain',
          ownerUserId: ctx.userId || null,
          chatId: ctx.chatId || null,
          category: 'agent_artifact',
          validation: null,
        });
        artifact = { id: saved.id, filename: saved.filename, mime: saved.mime, format: saved.format, sizeBytes: saved.sizeBytes, downloadUrl: saved.downloadUrl };
        if (args.subtitles && segments.length) {
          const srt = saveArtifactImpl({
            filename: `${safeTitle(title)} ${fmtClock(rangeStart).replace(/:/g, '-')}.srt`,
            base64: Buffer.from(buildSrt(segments, { offset }), 'utf8').toString('base64'),
            mime: 'application/x-subrip',
            ownerUserId: ctx.userId || null,
            chatId: ctx.chatId || null,
            category: 'agent_artifact',
            validation: null,
          });
          srtArtifact = { id: srt.id, filename: srt.filename, mime: srt.mime, format: srt.format, sizeBytes: srt.sizeBytes, downloadUrl: srt.downloadUrl };
        }
        if (ctx && typeof ctx.onEvent === 'function') {
          for (const a of [artifact, srtArtifact].filter(Boolean)) {
            try { ctx.onEvent({ type: 'file_artifact', artifact: { ...a, previewHtml: null, validation: null } }); } catch (_) { /* UI plumbing never fails the tool */ }
          }
        }
      } catch (_) { artifact = artifact || null; }
      const shown = note ? `${note}\n\n${body}` : body;
      const truncated = shown.length > MAX_TEXT_CHARS;
      return {
        ok: true,
        title,
        source: url.href,
        host: url.hostname.replace(/^www\./, ''),
        range: { start: rangeStart, end: rangeEnd, label: rangeLabel },
        durationSeconds: duration,
        ...extra,
        language: language || null,
        segments: segments.length,
        text: truncated ? `${shown.slice(0, MAX_TEXT_CHARS)}\n… [transcripción recortada en la respuesta; el archivo adjunto tiene el texto completo]` : shown,
        truncated,
        artifact,
        ...(srtArtifact ? { srtArtifact } : {}),
        via,
        ...(partial ? { partial } : {}),
        ...(discovery ? { discovery } : {}),
        ...(cookiesInfo ? { cookies: cookiesInfo } : {}),
        elapsedMs: Date.now() - startedAt,
      };
    };

    const languageName = (code) => {
      const fmt = formatModule();
      try { return fmt ? fmt.languageNameEs(code) : code; } catch (_) { return code; }
    };

    // A quick ASR of ~60 s of the clip: the audio's language and words, to
    // check the captions against what is really said. ≤ 2 samples, on the
    // short admission lane and under its own deadline: a spot check that
    // cannot get a transcription slot in time answers `spot_timeout` and the
    // link goes on (hand-off or inline ASR), never waits for the tool cut.
    const spotTimeoutMs = Number(env.TRANSCRIBE_URL_CAPTION_SPOT_TIMEOUT_MS) > 0
      ? Number(env.TRANSCRIBE_URL_CAPTION_SPOT_TIMEOUT_MS) : CAPTION_SPOT_TIMEOUT_MS;
    const spotCheck = async (clipPath, rangeStart, end) => {
      const span = Math.max(0, end - rangeStart);
      const positions = [Math.max(0, span / 2 - CAPTION_SPOT_SECONDS / 2), Math.max(0, span / 4 - CAPTION_SPOT_SECONDS / 2)];
      const bounded = composeAbortSignals([signal], { timeoutMs: spotTimeoutMs, timeoutReason: 'caption_spot_timeout' });
      const outerAborted = () => Boolean(signal && signal.aborted);
      // Never trust a step to honour the signal: the deadline settles the wait
      // even when an engine (or a stuck admission) ignores it.
      const raceDeadline = (promise) => new Promise((resolve, reject) => {
        if (bounded.signal.aborted) { reject(Object.assign(new Error('caption_spot_timeout'), { name: 'AbortError' })); return; }
        const onAbort = () => reject(Object.assign(new Error('caption_spot_timeout'), { name: 'AbortError' }));
        bounded.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => bounded.signal.removeEventListener('abort', onAbort));
      });
      let last = { ok: false, reason: 'spot_failed' };
      try {
        for (const [index, at] of positions.entries()) {
          if (index > 0 && Math.abs(at - positions[0]) < 1) break;
          if (bounded.signal.aborted) {
            if (outerAborted()) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            return { ok: false, reason: 'spot_timeout' };
          }
          const samplePath = path.join(workDir, `spot-${index}.m4a`);
          try {
            const ff = await raceDeadline(run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(Math.round(at * 1000) / 1000),
              '-t', String(CAPTION_SPOT_SECONDS), '-i', clipPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', samplePath],
            { signal: bounded.signal, timeoutMs: 60_000, cwd: workDir }));
            if (ff.code !== 0) { last = { ok: false, reason: 'spot_cut_failed' }; continue; }
            const res = await raceDeadline(transcribeImpl(samplePath, 'audio/mp4', 'muestra.m4a', { signal: bounded.signal, lane: 'interactive',
              ...(requestedLanguage ? { language: requestedLanguage } : {}) }));
            if (!res || res.ok === false) { last = { ok: false, reason: 'spot_no_speech' }; continue; }
            const words = wordSet(Array.isArray(res.segments) && res.segments.length ? res.segments.map(seg => seg.text).join(' ') : (res.transcript || res.text));
            if (words.size < CAPTION_SPOT_MIN_WORDS) { last = { ok: false, reason: 'spot_too_short' }; continue; }
            return { ok: true, language: baseLanguage(res.language), words, from: rangeStart + at, to: rangeStart + at + CAPTION_SPOT_SECONDS };
          } catch (err) {
            // The caller's cancel stops the whole tool; our own deadline only
            // ends the check.
            if (outerAborted()) throw err;
            if (bounded.signal.aborted) return { ok: false, reason: 'spot_timeout' };
            if (err && err.name === 'AbortError') throw err;
            last = { ok: false, reason: 'spot_failed' };
          } finally {
            await Promise.resolve().then(() => fsImpl.promises.rm(samplePath, { force: true })).catch(() => {});
          }
        }
        return last;
      } finally {
        bounded.cleanup();
      }
    };

    /**
     * Human captions replace ASR only when they pass every check: same
     * language as the audio, ≥ 90 % of the requested range covered, and a
     * sample of the audio agrees with them (translated, partial or shifted
     * tracks fail one of the three). Automatic captions never replace ASR.
     */
    const verifyCaptions = async ({ clipPath, rangeStart, rangeEnd }) => {
      const manual = (captions && captions.tracks || []).filter(track => track.kind === 'manual');
      if (!manual.length) return { ok: false, reason: 'no_human_captions' };
      const lastCue = Math.max(...manual.map(track => track.cues[track.cues.length - 1].end));
      const end = rangeEnd != null ? rangeEnd : lastCue;
      if (!(end > rangeStart)) return { ok: false, reason: 'range_unknown' };
      const known = baseLanguage(requestedLanguage) || captions.audioLanguage || null;
      if (known && !manual.some(track => track.language === known)) return { ok: false, reason: 'language_mismatch' };
      const spot = await spotCheck(clipPath, rangeStart, end);
      if (!spot.ok) return { ok: false, reason: spot.reason };
      const language = known || spot.language;
      if (!language || (spot.language && spot.language !== language)) return { ok: false, reason: 'language_mismatch' };
      const track = manual.find(item => item.language === language);
      if (!track) return { ok: false, reason: 'language_mismatch' };
      const coverage = captionCoverage(track.cues, rangeStart, end);
      if (coverage < CAPTION_MIN_COVERAGE) return { ok: false, reason: 'low_coverage', coverage };
      const captionWords = wordSet(cuesInRange(track.cues, spot.from - 5, spot.to + 5).map(cue => cue.text).join(' '));
      let shared = 0;
      for (const word of spot.words) if (captionWords.has(word)) shared++;
      const agreement = shared / spot.words.size;
      if (agreement < CAPTION_SPOT_MIN_AGREEMENT) return { ok: false, reason: 'spot_disagrees', coverage, agreement };
      return { ok: true, track, language, coverage, agreement, end, cues: cuesInRange(track.cues, rangeStart, end) };
    };

    /** No voice recognised: the platform's own captions, labelled honestly, when they cover enough. */
    const captionFallback = ({ title, rangeStart, rangeEnd, duration, via, partial, reason }) => {
      if (!captions || !captions.tracks.length) return null;
      const known = baseLanguage(requestedLanguage) || captions.audioLanguage || null;
      const pick = pickFallbackCaptions(captions, { known, rangeStart, rangeEnd });
      if (!pick) return null;
      const name = languageName(pick.track.language);
      const what = pick.track.kind === 'manual' ? `los subtítulos que publicó la plataforma (${name})` : `los subtítulos automáticos de la plataforma (${name}), que pueden tener errores`;
      const cover = pick.coverage < CAPTION_MIN_COVERAGE ? ` Cubren cerca del ${Math.round(pick.coverage * 100)} % del tramo.` : '';
      const note = `Nota: no pude reconocer la voz del audio; esto son ${what}.${cover}`;
      return deliverText({ title, rangeStart, rangeEnd: rangeEnd != null ? rangeEnd : pick.end, duration, via, partial,
        segments: cuesInRange(pick.track.cues, rangeStart, rangeEnd != null ? rangeEnd : pick.end), offset: 0,
        language: pick.track.language, sourceLabel: pick.track.kind === 'manual' ? 'subtítulos de la plataforma' : 'subtítulos automáticos de la plataforma',
        note, extra: { method: 'platform_captions', model: null, transcriptSource: 'platform_captions', fallback: true, asrFailure: reason || null,
          captions: { language: pick.track.language, kind: pick.track.kind, coverage: Math.round(pick.coverage * 1000) / 1000 } } });
    };

    // 4–5. Transcribe the clip and deliver it (shared by every acquisition path).
    const finish = async ({ clipPath, title, rangeStart, rangeEnd, duration, sectioned, via, partial = null, cappedEnd = false }) => {
      // A stream of unknown length was cut at the per-call cap, not at its
      // real end: measure the clip before deciding (a 5-minute clip is not
      // a 12-hour recording). Unmeasured, it is never handed off.
      let measured = null;
      if (cappedEnd && durable.enabled) {
        try { measured = Number(await probeDuration(clipPath, { signal })) || null; } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          measured = null;
        }
        if (measured > 0) rangeEnd = rangeStart + measured;
      }
      const clipName = `${safeTitle(title)}${sectioned ? ` ${fmtClock(rangeStart)}-${fmtClock(rangeEnd != null ? rangeEnd : rangeStart)}` : ''}.m4a`;
      const spanSec = cappedEnd && !(measured > 0) ? null
        : rangeEnd != null ? rangeEnd - rangeStart : (duration != null ? duration - rangeStart : null);
      // The recogniser's glossary: the title's proper nouns (accents kept)
      // and the names the captions spell.
      const glossary = glossaryFor(title, captions);
      const hints = glossary.length ? { terms: glossary } : null;
      let captionCheck = null;
      if (captions && !partial) {
        const knownEnd = rangeEnd != null ? rangeEnd : (spanSec != null ? rangeStart + spanSec : null);
        try { captionCheck = await verifyCaptions({ clipPath, rangeStart, rangeEnd: knownEnd }); } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          captionCheck = { ok: false, reason: 'check_failed' };
        }
        if (captionCheck.ok) {
          return deliverText({ title, rangeStart, rangeEnd: captionCheck.end, duration, via, segments: captionCheck.cues, offset: 0,
            language: captionCheck.language, sourceLabel: 'subtítulos de la plataforma',
            note: `Nota: usé los subtítulos que publicó la plataforma (${languageName(captionCheck.language)}); cubren el ${Math.round(captionCheck.coverage * 100)} % del tramo y coinciden con una muestra del audio.`,
            extra: { method: 'platform_captions', model: null, transcriptSource: 'platform_captions',
              captions: { language: captionCheck.language, kind: 'manual', coverage: Math.round(captionCheck.coverage * 1000) / 1000,
                agreement: Math.round(captionCheck.agreement * 1000) / 1000 } } });
        }
      }
      const captionReport = captionCheck ? { captionCheck: { reason: captionCheck.reason || null,
        ...(captionCheck.coverage != null ? { coverage: Math.round(captionCheck.coverage * 1000) / 1000 } : {}) } } : {};
      if (durable.enabled && !partial && spanSec != null && spanSec >= durable.minSeconds) {
        try {
          // The best platform track travels with the job: if the durable ASR
          // fails or finds no voice, the queue falls back on it (labelled).
          const fallbackPick = captions ? pickFallbackCaptions(captions, {
            known: baseLanguage(requestedLanguage) || captions.audioLanguage || null, rangeStart,
            rangeEnd: rangeEnd != null ? rangeEnd : rangeStart + spanSec }) : null;
          const linkCaptions = linkCaptionsRecord(fallbackPick, { rangeStart, rangeEnd: rangeEnd != null ? rangeEnd : rangeStart + spanSec });
          const handed = await durableImpl({ clipPath, title, url, rangeStart, rangeEnd, spanSec, sectioned,
            subtitles: Boolean(args.subtitles), language: args.language || null, hints, ctx, env,
            ...(linkCaptions ? { captions: linkCaptions } : {}) });
          if (handed && handed.ok) {
            const rangeLabel = `${fmtClock(rangeStart)} → ${fmtClock(rangeEnd != null ? rangeEnd : rangeStart + spanSec)}`;
            return {
              ok: true,
              deferred: true,
              title,
              source: url.href,
              host: url.hostname.replace(/^www\./, ''),
              range: { start: rangeStart, end: rangeEnd, label: rangeLabel },
              durationSeconds: duration,
              fileId: handed.fileId,
              delivery: handed.deliveryId,
              userMessage: handed.message,
              text: handed.message,
              via,
              ...captionReport,
              ...(discovery ? { discovery } : {}),
              ...(cookiesInfo ? { cookies: cookiesInfo } : {}),
              elapsedMs: Date.now() - startedAt,
            };
          }
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          // Fall through to the inline transcription below.
        }
        if (spanSec > inlineMaxSeconds) {
          return errorResult('media_too_long', `durable hand-off unavailable; ${fmtClock(spanSec)} > inline max ${fmtClock(inlineMaxSeconds)}`, { durationSeconds: duration, maxSeconds: inlineMaxSeconds, title });
        }
      }
      let result;
      try {
        result = await transcribeImpl(clipPath, 'audio/mp4', clipName, {
          signal,
          lane: 'interactive',
          ...(args.language ? { language: String(args.language) } : {}),
          ...(hints ? { hints } : {}),
          onProgress: ctx.onProgress,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return captionFallback({ title, rangeStart, rangeEnd, duration, via, partial, reason: 'transcription_failed' })
          || errorResult('transcription_failed', err && err.message, { title });
      }
      if (!result || result.ok === false) {
        const noSpeech = Boolean(result && result.status === 'no_speech');
        return captionFallback({ title, rangeStart, rangeEnd, duration, via, partial, reason: noSpeech ? 'no_speech' : 'transcription_failed' })
          || errorResult('transcription_failed', result && (result.reasonCode || result.status), { title, noSpeech });
      }
      let segments = Array.isArray(result.segments) ? result.segments : [];
      // The same cleanup as every stored transcript (contract C5): engine
      // credits, sign-offs, loops and prompt echoes never reach the answer.
      let cleanup = null;
      const fmt = formatModule();
      if (fmt && segments.length) {
        try {
          const cleaned = fmt.cleanSegmentsDetailed(segments, { promptTerms: glossary.length ? glossary : null, keepSuspect: true });
          cleanup = cleaned.cleanup;
          if (cleaned.segments.length) segments = cleaned.segments;
          else {
            return captionFallback({ title, rangeStart, rangeEnd, duration, via, partial, reason: 'no_speech' })
              || errorResult('transcription_failed', 'no_speech', { title, noSpeech: true });
          }
        } catch (_) { cleanup = null; }
      }
      return deliverText({ title, rangeStart, rangeEnd, duration, via, partial, segments, offset: rangeStart,
        plain: cleanup && cleanup.removed ? segments.map(seg => String(seg.text || '').trim()).join(' ') : String(result.transcript || result.text || '').trim(),
        language: result.language || null,
        extra: { method: result.method || null, model: result.model || null, ...captionReport,
          ...(cleanup && cleanup.removed ? { cleaned: cleanup.removed } : {}),
          ...(result.quality && typeof result.quality === 'object' && result.quality.level ? { quality: { level: result.quality.level, score: result.quality.score ?? null } } : {}) } });
    };

    // Last rung («rastrear el audio»): play the recording in a browser and
    // record what it plays. Covers players with no downloadable stream
    // (MediaSource/blob, tokenised segments, iframes). Returns a finish()
    // payload, or null when it could not record anything.
    let lastCapture = null;
    const tryCapture = async (why) => {
      // One capture per call: defaultCapture already falls back from the
      // computer to the headless browser.
      if (!captureImpl || lastCapture) return null;
      const rangeStart = start != null ? start : 0;
      const span = end != null ? end - rangeStart : maxSeconds;
      const budgetMs = toolDeadline - Date.now() - TRANSCRIBE_RESERVE_MS;
      let rate = mediaCapture.pickCaptureRate(Math.min(span, maxSeconds), budgetMs, captureMaxRate);
      let captureEnd = end;
      let budgetCut = false;
      if (rate == null) {
        if (end != null) {
          // An explicit range longer than the call can play: ask for parts.
          lastCapture = { why, reason: 'over_time_budget' };
          discovery = { ...(discovery || {}), capture: lastCapture };
          return null;
        }
        // Open range of unknown length: record what fits and say so.
        rate = captureMaxRate;
        captureEnd = rangeStart + Math.floor((budgetMs / 1000) * rate * 0.9);
        budgetCut = true;
      }
      const outPath = path.join(workDir, 'capture.webm');
      let cap;
      try {
        cap = await captureImpl(url.href, ctx, {
          start: rangeStart, end: captureEnd, rate, maxSeconds, timeoutMs: budgetMs, outPath,
          cookies: cookiesText ? mediaDiscovery.parseNetscapeCookies(cookiesText) : [], dnsCheck, env, signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        cap = { ok: false, reason: 'capture_failed', detail: String((err && err.message) || err).slice(0, 200) };
      }
      lastCapture = { why, reason: cap.reason || null, browser: cap.browser || null, seconds: cap.seconds || 0, rate, stopped: cap.stopped || null, ...(cap.detail ? { detail: cap.detail } : {}) };
      discovery = { ...(discovery || {}), capture: lastCapture };
      if (!cap.ok) return null;
      // Played at `rate` × with pitch preserved: slow the file back so the
      // transcript's timestamps follow the recording's own clock.
      const clipPath = path.join(workDir, 'clip.m4a');
      const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', outPath, '-t', String(Math.max(1, cap.seconds / rate) + 1)];
      if (rate !== 1) ffArgs.push('-filter:a', `atempo=${(1 / rate).toFixed(4)}`);
      ffArgs.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', clipPath);
      try {
        const ff = await run(ffmpeg, ffArgs, { signal, timeoutMs: Math.max(60_000, toolDeadline - Date.now()), cwd: workDir });
        if (ff.code !== 0) { lastCapture.reason = 'convert_failed'; lastCapture.detail = lastLine(ff.stderr); return null; }
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        lastCapture.reason = 'convert_failed';
        return null;
      }
      const complete = cap.stopped === 'media_ended' || (cap.stopped === 'range_end' && !budgetCut);
      return {
        clipPath,
        title: cap.title || target.titleHint || url.hostname,
        rangeStart,
        rangeEnd: rangeStart + cap.seconds,
        duration: null,
        sectioned: start != null || end != null,
        via: `${cap.browser || 'browser'}+capture`,
        partial: complete ? null : (budgetCut && cap.stopped === 'range_end' ? 'time_budget' : cap.stopped || 'incomplete'),
      };
    };
    const captureOr = async (why, failure) => {
      const clip = await tryCapture(why);
      if (clip) return finish(clip);
      if (failure && discovery) failure.discovery = discovery;
      return failure;
    };

    // 2. Probe — yt-dlp first; the browser when yt-dlp does not know the page.
    let probe = await probeWith(target);
    if (!probe.ok && discoveryEnabled && DISCOVERY_ELIGIBLE.has(probe.code)) {
      const browserCookies = cookiesText ? mediaDiscovery.parseNetscapeCookies(cookiesText) : [];
      let disc;
      try {
        disc = await discoverImpl(url.href, { cookies: browserCookies, timeoutMs: Math.min(discoveryTimeoutMs, timeoutMs), dnsCheck, env, signal });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        disc = { ok: false, reason: 'discovery_failed', detail: String((err && err.message) || err).slice(0, 200) };
      }
      discovery = {
        reason: disc.reason || null,
        candidates: Array.isArray(disc.candidates) ? disc.candidates.length : 0,
        loginWall: Boolean(disc.loginWall),
        elapsedMs: disc.elapsedMs || null,
        ...(disc.detail ? { detail: disc.detail } : {}),
      };
      const pickSafe = async (found) => {
        for (const c of Array.isArray(found && found.candidates) ? found.candidates : []) {
          try { assertSafeUrl(c.url); await dnsCheck(new URL(c.url).hostname); return c; } catch (_) { /* skip unsafe */ }
        }
        return null;
      };
      let candidate = await pickSafe(disc);
      let viaBrowser = 'browser';
      let clip = null;
      // The chat computer's Chrome keeps the user's own sign-ins (they log in
      // there once, the profile persists): a recording behind a login is read
      // from INSIDE that browser — same tab logic, the user's real session.
      if (!candidate && computer && (await safeAvailable(computer, ctx))) {
        let comp = null;
        try {
          comp = await computer.discover(url.href, ctx, { timeoutMs: Math.max(discoveryTimeoutMs, COMPUTER_DISCOVERY_TIMEOUT_MS), dnsCheck, env, signal });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          comp = { disc: { ok: false, reason: 'computer_unavailable', detail: String((err && err.message) || err).slice(0, 200) } };
        }
        const cdisc = (comp && comp.disc) || { ok: false, reason: 'computer_unavailable' };
        discovery.computer = { reason: cdisc.reason || null, candidates: Array.isArray(cdisc.candidates) ? cdisc.candidates.length : 0, loginWall: Boolean(cdisc.loginWall), elapsedMs: cdisc.elapsedMs || null };
        candidate = await pickSafe(cdisc);
        if (candidate) {
          disc = cdisc;
          viaBrowser = 'computer';
        } else if (comp && comp.session && !cdisc.loginWall && cdisc.reason === 'no_media_found' && (clip = await tryCapture('no_stream_in_computer'))) {
          return finish(clip);
        } else if (comp && comp.session && cdisc.reason !== 'computer_unavailable' && cdisc.reason !== 'browser_unavailable'
          && (cdisc.loginWall || !lastCapture || lastCapture.reason === 'login_wall')) {
          // Show the page in the computer panel so the user can sign in there.
          try { if (typeof computer.show === 'function') await computer.show(comp.session, url.href, ctx); } catch (_) { /* the panel event below still opens it */ }
          if (ctx && typeof ctx.onEvent === 'function') {
            try { ctx.onEvent({ type: 'computer_navigate', url: url.href, tool: 'transcribe_url' }); } catch (_) { /* UI plumbing never fails the tool */ }
          }
          return errorResult('media_login_in_computer', cdisc.detail || cdisc.reason || 'no media in the computer browser', {
            discovery,
            computerLogin: { url: url.href, host: url.hostname },
            ...(cookiesInfo ? { cookies: cookiesInfo } : {}),
          });
        }
      }
      if (candidate) {
        if (disc.cookiesNetscape) { cookiesText = cookieJar.mergeNetscapeCookies(cookiesText, disc.cookiesNetscape); await writeCookies(); }
        target = { href: candidate.url, referer: url.href, userAgent: disc.userAgent || mediaDiscovery.DESKTOP_UA, via: `${viaBrowser}+yt-dlp`, direct: false, titleHint: disc.title || null, kind: candidate.kind };
        discovery.picked = { kind: candidate.kind, host: (() => { try { return new URL(candidate.url).hostname; } catch (_) { return null; } })() };
        probe = await probeWith(target);
        if (!probe.ok) {
          // yt-dlp refused the stream itself — ffmpeg reads HLS/DASH/MP4 directly.
          discovery.ytdlpOnCandidate = probe.code;
          target.via = `${viaBrowser}+ffmpeg`;
          target.direct = true;
          probe = { ok: true, info: { title: disc.title || null, duration: null } };
        }
      } else if (disc.loginWall) {
        return errorResult('media_login_required', disc.detail || 'login wall after browser discovery', { discovery, ...(cookiesInfo ? { cookies: cookiesInfo } : {}) });
      } else {
        return captureOr('no_stream_found', errorResult(probe.code === 'media_download_failed' && disc.reason === 'no_media_found' ? 'media_unsupported_url' : probe.code, probe.detail, { discovery, ...(cookiesInfo ? { cookies: cookiesInfo } : {}) }));
      }
    } else if (!probe.ok) {
      return captureOr('ytdlp_failed', errorResult(probe.code, probe.detail, cookiesInfo ? { cookies: cookiesInfo } : {}));
    }

    const info = probe.info;
    try { captions = await fetchCaptions(target, info); } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      captions = null;
    }
    // null/undefined duration = unknown (a discovered live stream); 0 is unknown too.
    const duration = info && info.duration != null && Number.isFinite(Number(info.duration)) && Number(info.duration) > 0 ? Number(info.duration) : null;
    const title = (info && (info.title || info.fulltitle)) || target.titleHint || url.hostname;
    const rangeStart = start != null ? start : 0;
    let rangeEnd = end != null ? end : duration;
    if (duration != null && rangeStart >= duration) return errorResult('invalid_range', `start ${fmtClock(rangeStart)} beyond duration ${fmtClock(duration)}`, { durationSeconds: duration });
    if (duration != null && rangeEnd != null && rangeEnd > duration) rangeEnd = duration;
    const span = rangeEnd != null ? rangeEnd - rangeStart : null;
    if (span != null && span > maxSeconds) {
      return errorResult('media_too_long', `requested ${fmtClock(span)} > max ${fmtClock(maxSeconds)}`, { durationSeconds: duration, maxSeconds, title });
    }
    let cappedEnd = false;
    if (span == null && duration == null && end == null) {
      // Unknown duration and no end: cap at maxSeconds from start.
      rangeEnd = rangeStart + maxSeconds;
      cappedEnd = true;
    }

    // 3. Download the section as audio, then trim precisely.
    const clipPath = path.join(workDir, 'clip.m4a');
    const sectioned = start != null || end != null;
    if (target.direct) {
      // ffmpeg straight from the discovered stream, with the page's headers and
      // the session cookies that apply to that host. One pass: seek + encode.
      const headers = [`Referer: ${target.referer}`, `User-Agent: ${target.userAgent}`];
      const hostCookies = mediaDiscovery.cookiesForHost(cookiesText ? mediaDiscovery.parseNetscapeCookies(cookiesText) : [], new URL(target.href).hostname);
      if (hostCookies.length) headers.push(`Cookie: ${hostCookies.map((c) => `${c.name}=${c.value}`).join('; ')}`);
      const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-headers', `${headers.join('\r\n')}\r\n`];
      if (rangeStart > 0) ffArgs.push('-ss', String(rangeStart));
      ffArgs.push('-i', target.href);
      const limit = rangeEnd != null ? rangeEnd - rangeStart : maxSeconds;
      ffArgs.push('-t', String(limit), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', clipPath);
      try {
        const ff = await run(ffmpeg, ffArgs, { signal, timeoutMs, cwd: workDir });
        if (ff.code !== 0) return captureOr('stream_unreadable', errorResult('media_download_failed', lastLine(ff.stderr), { title, discovery }));
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return captureOr('stream_unreadable', errorResult(err && err.code === 'ENOENT' ? 'ffmpeg_failed' : 'media_download_failed', err && err.message, { title, discovery }));
      }
    } else {
      const rawTemplate = path.join(workDir, 'source.%(ext)s');
      // `--fixup never`: we re-encode right after, so yt-dlp's own ffmpeg
      // remux pass (FixupM3u8 etc.) is wasted work and one more way to fail.
      const dlArgs = [...ytBase(), ...headerArgs(target), '--no-progress', '--quiet', '--fixup', 'never', '-f', 'bestaudio/best', '-o', rawTemplate];
      if (sectioned && rangeEnd != null) dlArgs.push('--download-sections', `*${rangeStart}-${rangeEnd}`, '--force-keyframes-at-cuts');
      dlArgs.push('--', target.href);
      const sourceFiles = async () => (await fsImpl.promises.readdir(workDir)).filter((f) => f.startsWith('source.') && !/\.(part|ytdl)$/i.test(f));
      // Did yt-dlp cut the section itself (ffmpeg reading the stream) or did we
      // get the whole recording and must trim locally?
      let cutBySections = sectioned && rangeEnd != null;
      try {
        let dl = await run(ytdlp, dlArgs, { signal, timeoutMs, cwd: workDir });
        if (dl.code !== 0 && !(await sourceFiles()).length && cutBySections) {
          // The sectioned download needs ffmpeg to read the stream over the
          // network (HLS + -ss); when that path fails (headers the demuxer
          // drops, a CDN that refuses byte ranges…) fetch the whole recording
          // with yt-dlp's own downloader and trim locally. Bounded by the
          // per-call cap on the DURATION, so a 2 h class still fits.
          const sectionedError = lastLine(dl.stderr) || 'sectioned download failed';
          const whole = dlArgs.filter((a, i, all) => !(a === '--download-sections' || a === '--force-keyframes-at-cuts' || all[i - 1] === '--download-sections'));
          const retry = await run(ytdlp, whole, { signal, timeoutMs, cwd: workDir });
          dl = retry;
          if (retry.code === 0 || (await sourceFiles()).length) { cutBySections = false; discovery = { ...(discovery || {}), fullDownloadFallback: sectionedError }; }
        }
        // A non-zero exit AFTER the media landed (a post-processing hiccup) is
        // not a download failure: the file is what we need.
        if (dl.code !== 0 && !(await sourceFiles()).length) return captureOr('download_failed', errorResult(classifyDownloadFailure(dl.stderr), lastLine(dl.stderr), { title, discovery }));
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return captureOr('download_failed', errorResult(classifyDownloadFailure('', err), err && err.message, { title, discovery }));
      }
      const files = await sourceFiles();
      if (!files.length) return captureOr('download_failed', errorResult('media_download_failed', 'yt-dlp produced no file', { title, discovery }));
      const sourcePath = path.join(workDir, files[0]);
      // With --download-sections the file already starts at rangeStart: trim
      // relative to the clip; otherwise trim absolute times.
      const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', sourcePath];
      if (!cutBySections && (start != null || end != null)) {
        if (start != null) ffArgs.push('-ss', String(rangeStart));
        if (rangeEnd != null) ffArgs.push('-to', String(rangeEnd));
      } else if (cutBySections && span != null) {
        ffArgs.push('-t', String(span));
      }
      ffArgs.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', clipPath);
      try {
        const ff = await run(ffmpeg, ffArgs, { signal, timeoutMs, cwd: workDir });
        if (ff.code !== 0) return errorResult('ffmpeg_failed', lastLine(ff.stderr), { title });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return errorResult('ffmpeg_failed', err && err.message, { title });
      }
    }

    return finish({ clipPath, title, rangeStart, rangeEnd, duration, sectioned, via: target.via, cappedEnd });
  } finally {
    await cleanup();
  }
}

const inputSchema = z.object({
  url: z.string().min(8).max(4_000).describe('Absolute http(s) URL of the video, audio or recording (YouTube, Vimeo, public Drive links, direct .mp4/.mp3 files…)'),
  start: z.union([z.string(), z.number()]).optional().describe('Where to start: seconds (90) or "mm:ss" / "hh:mm:ss" ("1:30"). Omit for the beginning.'),
  end: z.union([z.string(), z.number()]).optional().describe('Where to stop: seconds or "mm:ss" / "hh:mm:ss" ("10:00"). Omit for the end.'),
  language: z.string().min(2).max(8).optional().describe('ISO language code of the speech when known (es, en…)'),
  subtitles: z.boolean().optional().describe('Also deliver an .srt subtitle file'),
}).strict();

function buildTranscribeUrlTool(deps = {}) {
  return {
    name: 'transcribe_url',
    description: [
      'Transcribe the audio of a video / audio / class recording given its LINK, whole or only from one timecode to another ("del minuto 1:30 al 10:00").',
      'WHEN TO USE: the user pastes a URL of a video, podcast, lecture, meeting or audio and asks for a transcription, subtitles, a summary of what is said, or what is said at a given minute. Pass start/end exactly as the user asked (convert "minuto 1.5" to "1:30").',
      'WHEN NOT TO USE: the user attached the audio file itself (the attachment is already transcribed); a web page with text (use web_fetch).',
      'It handles platform links (yt-dlp) AND player pages (a headless browser opens the page with the user\'s saved cookies, presses play and grabs the real stream). If the user attached a cookies.txt in this turn it is used and saved for later links of that site.',
      'If the page is behind a login it is also opened INSIDE the chat computer\'s browser, which keeps the user\'s own sign-ins.',
      'When no stream can be downloaded (MediaSource/blob players, tokenised segments, iframes), it PLAYS the recording in that browser and records the audio it plays (via ends in "+capture"); this can take as long as the requested range. `partial` (time_budget / stalled) means it stopped early: tell the user which part (range) was transcribed and offer the rest.',
      'Ranges: "del minuto 60 al 1:20" means 1:00:00 → 1:20:00 — pass hh:mm:ss when past the hour.',
      'Long recordings (20 min or more, up to 12 h) are queued: the result is ok:true with deferred:true — relay userMessage as is (the transcript, TXT/Word/SRT files and a notification arrive in this chat when it finishes); never call the tool again for it and never say the transcription failed.',
      'Results are structured: ok:false with code "media_login_in_computer" means the recording is now open in the chat computer waiting for the user to sign in — relay userMessage and, when the user says they are signed in («listo»), call transcribe_url AGAIN with the same url and range (that retry is expected). "media_login_required" means the link needs the user\'s own session — relay userMessage: attach the video/audio file, or attach a cookies.txt of that site once; "media_too_long" means ask for a range. `cookies.saved:true` means the session was stored: say so. Otherwise never retry the same URL more than once per failure.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    timeoutMs: toolTimeoutMs(deps.env || process.env),
    humanDescription: (args = {}) => {
      let host = 'un enlace';
      try { host = new URL(String(args.url)).hostname.replace(/^www\./, ''); } catch (_) { /* keep */ }
      const s = parseTimecode(args.start); const e = resolveRangeEnd(s, parseTimecode(args.end), args.end);
      const range = s != null || e != null ? ` (${s != null ? fmtClock(s) : 'inicio'} → ${e != null ? fmtClock(e) : 'fin'})` : '';
      return `Transcribiendo el audio de ${host}${range}`;
    },
    execute: async (args, ctx) => executeTranscribeUrl(args, ctx, deps),
  };
}

module.exports = {
  buildTranscribeUrlTool,
  executeTranscribeUrl,
  loadAttachedCookies,
  DISCOVERY_ELIGIBLE,
  parseTimecode,
  resolveRangeEnd,
  defaultComputer,
  defaultCapture,
  toolTimeoutMs,
  fmtClock,
  fmtSrtTime,
  classifyDownloadFailure,
  buildTimestampedText,
  buildSrt,
  runCommand,
  TranscribeUrlError,
  USER_MESSAGES,
  MAX_TEXT_CHARS,
  DEFAULT_MAX_SECONDS,
  DEFAULT_DURABLE_MIN_SECONDS,
  DEFAULT_DURABLE_MAX_SECONDS,
  durableConfig,
  defaultDurableHandoff,
  handOffMediaFile,
  // contract C7: platform captions and glossary
  displayTitle,
  titleTerms,
  captionTerms,
  glossaryFor,
  parseCaptionText,
  captionCoverage,
  cuesInRange,
  listCaptionTracks,
  captionKindFor,
  pickFallbackCaptions,
  linkCaptionsRecord,
  recordLinkCaptions,
  readLinkCaptions,
  captionBasesToFetch,
  CAPTION_MIN_COVERAGE,
};
