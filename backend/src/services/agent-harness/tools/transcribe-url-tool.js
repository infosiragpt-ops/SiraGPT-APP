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
 * Limits: TRANSCRIBE_URL_MAX_SECONDS (default 3 h of audio per call — ask for
 * a range beyond that), TRANSCRIBE_URL_TIMEOUT_MS (default 20 min),
 * TRANSCRIBE_URL_YTDLP (binary, default `yt-dlp`), FFMPEG_PATH.
 * Fully injectable (`deps.runCommand`, `deps.transcribe`, `deps.saveArtifact`,
 * `deps.dnsCheck`, `deps.fs`) so the tests run without network or binaries.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { z } = require('zod');
const { assertSafeUrl } = require('./web-fetch-tool');
const { buildUntrustedChildEnv } = require('../../../utils/untrusted-child-env');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_SECONDS = 3 * 60 * 60;
const MAX_TEXT_CHARS = 60_000;
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 60_000;

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
  media_login_required: 'El enlace pide iniciar sesión (cuenta institucional, video privado o contenido con acceso restringido), así que no puedo descargar el audio desde aquí. Opciones: descarga el audio o la grabación desde la plataforma y adjúntalo en el chat, o abre la grabación en la computadora de este chat con tu sesión iniciada y avísame.',
  media_unsupported_url: 'Ese enlace no apunta a un video o audio que pueda descargar (no es una página de medios ni un archivo de audio/video). Pásame el enlace directo del video o adjunta el archivo.',
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

async function executeTranscribeUrl(args = {}, ctx = {}, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.runCommand || runCommand;
  const transcribeImpl = deps.transcribe || ((...a) => require('../../audio-transcriber').transcribe(...a));
  const saveArtifactImpl = deps.saveArtifact || ((...a) => require('../../agents/task-tools').saveArtifact(...a));
  const dnsCheck = deps.dnsCheck || (async (hostname) => require('../../connectors/web-fetch').resolveAndAssertSafe(hostname));
  const fsImpl = deps.fs || fs;
  const ytdlp = env.TRANSCRIBE_URL_YTDLP || 'yt-dlp';
  const ffmpeg = env.FFMPEG_PATH || 'ffmpeg';
  const timeoutMs = Number(env.TRANSCRIBE_URL_TIMEOUT_MS) > 0 ? Number(env.TRANSCRIBE_URL_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const maxSeconds = Number(env.TRANSCRIBE_URL_MAX_SECONDS) > 0 ? Number(env.TRANSCRIBE_URL_MAX_SECONDS) : DEFAULT_MAX_SECONDS;
  const signal = ctx.signal || null;
  const startedAt = Date.now();

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
  const end = parseTimecode(args.end);
  if ((args.start != null && args.start !== '' && start == null) || (args.end != null && args.end !== '' && end == null)) {
    return errorResult('invalid_range', 'start/end must be seconds or mm:ss / hh:mm:ss');
  }
  if (start != null && end != null && end <= start) return errorResult('invalid_range', 'end <= start');

  const workDir = await fsImpl.promises.mkdtemp(path.join(deps.tmpDir || os.tmpdir(), 'sira-transcribe-'));
  const cleanup = async () => { try { await fsImpl.promises.rm(workDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ } };
  try {
    // 2. Probe
    let info = null;
    try {
      const probe = await run(ytdlp, ['--dump-single-json', '--no-playlist', '--no-warnings', '--skip-download', '--', url.href], { signal, timeoutMs: Math.min(timeoutMs, PROBE_TIMEOUT_MS), cwd: workDir });
      if (probe.code !== 0) return errorResult(classifyDownloadFailure(probe.stderr), probe.stderr.trim().split('\n').pop());
      try { info = JSON.parse(probe.stdout); } catch (_) { info = null; }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return errorResult(classifyDownloadFailure('', err), err && err.message);
    }
    const duration = info && Number.isFinite(Number(info.duration)) ? Number(info.duration) : null;
    const title = (info && (info.title || info.fulltitle)) || url.hostname;
    const rangeStart = start != null ? start : 0;
    let rangeEnd = end != null ? end : duration;
    if (duration != null && rangeStart >= duration) return errorResult('invalid_range', `start ${fmtClock(rangeStart)} beyond duration ${fmtClock(duration)}`, { durationSeconds: duration });
    if (duration != null && rangeEnd != null && rangeEnd > duration) rangeEnd = duration;
    const span = rangeEnd != null ? rangeEnd - rangeStart : null;
    if (span != null && span > maxSeconds) {
      return errorResult('media_too_long', `requested ${fmtClock(span)} > max ${fmtClock(maxSeconds)}`, { durationSeconds: duration, maxSeconds, title });
    }
    if (span == null && duration == null && end == null) {
      // Unknown duration and no end: cap at maxSeconds from start.
      rangeEnd = rangeStart + maxSeconds;
    }

    // 3. Download the section as audio, then trim precisely.
    const rawTemplate = path.join(workDir, 'source.%(ext)s');
    const dlArgs = ['--no-playlist', '--no-warnings', '--no-progress', '--quiet', '-f', 'bestaudio/best', '-o', rawTemplate];
    const sectioned = start != null || end != null;
    if (sectioned && rangeEnd != null) dlArgs.push('--download-sections', `*${rangeStart}-${rangeEnd}`, '--force-keyframes-at-cuts');
    dlArgs.push('--', url.href);
    try {
      const dl = await run(ytdlp, dlArgs, { signal, timeoutMs, cwd: workDir });
      if (dl.code !== 0) return errorResult(classifyDownloadFailure(dl.stderr), dl.stderr.trim().split('\n').pop(), { title });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return errorResult(classifyDownloadFailure('', err), err && err.message, { title });
    }
    const files = (await fsImpl.promises.readdir(workDir)).filter((f) => f.startsWith('source.'));
    if (!files.length) return errorResult('media_download_failed', 'yt-dlp produced no file', { title });
    const sourcePath = path.join(workDir, files[0]);
    const clipPath = path.join(workDir, 'clip.m4a');
    // With --download-sections the file already starts at rangeStart: trim
    // relative to the clip; without it, trim absolute times.
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', sourcePath];
    if (!sectioned && (start != null || end != null)) {
      if (start != null) ffArgs.push('-ss', String(rangeStart));
      if (rangeEnd != null) ffArgs.push('-to', String(rangeEnd));
    } else if (sectioned && span != null) {
      ffArgs.push('-t', String(span));
    }
    ffArgs.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', clipPath);
    try {
      const ff = await run(ffmpeg, ffArgs, { signal, timeoutMs, cwd: workDir });
      if (ff.code !== 0) return errorResult('ffmpeg_failed', ff.stderr.trim().split('\n').pop(), { title });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return errorResult(err && err.code === 'ENOENT' ? 'ffmpeg_failed' : 'ffmpeg_failed', err && err.message, { title });
    }

    // 4. Transcribe
    const clipName = `${safeTitle(title)}${sectioned ? ` ${fmtClock(rangeStart)}-${fmtClock(rangeEnd != null ? rangeEnd : rangeStart)}` : ''}.m4a`;
    let result;
    try {
      result = await transcribeImpl(clipPath, 'audio/mp4', clipName, {
        signal,
        ...(args.language ? { language: String(args.language) } : {}),
        onProgress: ctx.onProgress,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return errorResult('transcription_failed', err && err.message, { title });
    }
    if (!result || result.ok === false) {
      return errorResult(result && result.status === 'no_speech' ? 'transcription_failed' : 'transcription_failed', result && (result.reasonCode || result.status), { title, noSpeech: Boolean(result && result.status === 'no_speech') });
    }
    const segments = Array.isArray(result.segments) ? result.segments : [];
    const offset = rangeStart;
    const transcript = String(result.transcript || result.text || '').trim();
    const body = segments.length >= 2 ? buildTimestampedText(segments, { offset }) : transcript;
    const rangeLabel = `${fmtClock(rangeStart)} → ${fmtClock(rangeEnd != null ? rangeEnd : rangeStart + (duration || 0))}`;
    const header = `Transcripción de «${title}» (${url.hostname.replace(/^www\./, '')}) · ${rangeLabel}${result.language ? ` · idioma: ${result.language}` : ''}\n\n`;
    const fullText = header + body;

    // 5. Deliver
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

    const truncated = body.length > MAX_TEXT_CHARS;
    return {
      ok: true,
      title,
      source: url.href,
      host: url.hostname.replace(/^www\./, ''),
      range: { start: rangeStart, end: rangeEnd, label: rangeLabel },
      durationSeconds: duration,
      method: result.method || null,
      model: result.model || null,
      language: result.language || null,
      segments: segments.length,
      text: truncated ? `${body.slice(0, MAX_TEXT_CHARS)}\n… [transcripción recortada en la respuesta; el archivo adjunto tiene el texto completo]` : body,
      truncated,
      artifact,
      ...(srtArtifact ? { srtArtifact } : {}),
      elapsedMs: Date.now() - startedAt,
    };
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
      'Results are structured: ok:false with code "media_login_required" means the link needs the user\'s own session (offer: attach the audio, or open it on the chat computer logged in); "media_too_long" means ask for a range. Never retry the same URL more than once per failure.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => {
      let host = 'un enlace';
      try { host = new URL(String(args.url)).hostname.replace(/^www\./, ''); } catch (_) { /* keep */ }
      const s = parseTimecode(args.start); const e = parseTimecode(args.end);
      const range = s != null || e != null ? ` (${s != null ? fmtClock(s) : 'inicio'} → ${e != null ? fmtClock(e) : 'fin'})` : '';
      return `Transcribiendo el audio de ${host}${range}`;
    },
    execute: async (args, ctx) => executeTranscribeUrl(args, ctx, deps),
  };
}

module.exports = {
  buildTranscribeUrlTool,
  executeTranscribeUrl,
  parseTimecode,
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
};
