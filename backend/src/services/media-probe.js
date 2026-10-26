'use strict';

/**
 * media-probe — what a media file carries, in ONE ffprobe call.
 *
 *   probeMediaStreams(filePath, opts) → { ok, durationSec, formatName, formatStartTimeSec,
 *     audio[], subtitles[], video[], hasAudio, hasVideo, hasTextSubtitles }
 *   chooseAudioStream(probe, { language }) → { streamOrdinal, index, reason } | null
 *   extractSubtitleSegments(filePath, streamOrdinal, opts)
 *     → { ok, segments: [{ start, end, text }], codec }
 *
 * Contract C1 of the «transcription never fails» plan. Video is no longer a
 * blind audio container: the transcriber picks the right audio track
 * (language, disposition, commentary/music titles — never loudness: music is
 * not silence and the dialogue track is often the quieter one), a file with
 * no audio track is recognised as such instead of failing the decode three
 * times, and a text subtitle track (subrip / ass / ssa / mov_text / webvtt)
 * can stand in for or cross-check ASR.
 *
 * Production rules: every call is bounded in time and output, cancellable
 * through the caller's AbortSignal, never throws, and never logs file
 * contents. A missing ffprobe/ffmpeg binary is reported once (WARN) and the
 * caller degrades to today's behaviour.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const PROBE_MAX_BUFFER = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const SUBTITLE_TIMEOUT_MS = 120_000;
const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const STDERR_LINE_MAX = 8 * 1024;
const FILTERS_TIMEOUT_MS = 10_000;

// Codecs ffmpeg decodes to TEXT (it can re-encode them as SRT). Bitmap
// tracks (PGS, VobSub, DVB) need OCR and are never treated as text.
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text',
  'microdvd', 'subviewer', 'subviewer1', 'sami', 'realtext', 'mpl2', 'jacosub', 'pjs', 'stl', 'vplayer',
]);
const BITMAP_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext', 'arib_caption',
]);

// Secondary audio by title: commentary, audio description and the
// non-dialogue beds (music & effects, OBS «Desktop Audio», game audio).
const COMMENT_TITLE_RE = /\b(?:commentary|comentarios?|comentario del director|director'?s? (?:commentary|cut audio)|audio ?comentario)\b/i;
const DESCRIPTION_TITLE_RE = /\b(?:audio ?descrip(?:tion|ci[oó]n)|descriptive|described|descripci[oó]n de audio|audiodescripci[oó]n|visually impaired|\bAD\b)\b/i;
const MUSIC_TITLE_RE = /\b(?:music|m[uú]sica|m ?& ?e|music (?:and|&) effects|instrumental|soundtrack|banda sonora|bgm|karaoke|sfx|effects|efectos|desktop audio|system audio|audio del sistema|game audio|audio del juego|ambient|ambiente|background|fondo musical)\b/i;

// ISO 639-2 (B and T) and common names → ISO 639-1. Unknown three-letter
// codes are kept as-is so two tags still compare equal.
const ISO639_2_TO_1 = new Map(Object.entries({
  spa: 'es', eng: 'en', por: 'pt', fra: 'fr', fre: 'fr', ita: 'it', deu: 'de', ger: 'de', cat: 'ca',
  glg: 'gl', eus: 'eu', baq: 'eu', que: 'qu', aym: 'ay', grn: 'gn', gug: 'gn', jpn: 'ja', zho: 'zh',
  chi: 'zh', kor: 'ko', rus: 'ru', ara: 'ar', hin: 'hi', nld: 'nl', dut: 'nl', pol: 'pl', tur: 'tr',
  swe: 'sv', nor: 'no', nob: 'nb', nno: 'nn', dan: 'da', fin: 'fi', ell: 'el', gre: 'el', heb: 'he',
  ukr: 'uk', ces: 'cs', cze: 'cs', ron: 'ro', rum: 'ro', hun: 'hu', vie: 'vi', tha: 'th', ind: 'id',
  msa: 'ms', may: 'ms', fil: 'tl', tgl: 'tl', cym: 'cy', wel: 'cy', gle: 'ga', isl: 'is', ice: 'is',
  bul: 'bg', hrv: 'hr', srp: 'sr', slk: 'sk', slo: 'sk', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et',
  fas: 'fa', per: 'fa', urd: 'ur', ben: 'bn', tam: 'ta', tel: 'te', swa: 'sw', afr: 'af', lat: 'la',
}));
const LANGUAGE_NAMES = new Map(Object.entries({
  spanish: 'es', espanol: 'es', castellano: 'es', english: 'en', ingles: 'en', portuguese: 'pt',
  portugues: 'pt', french: 'fr', frances: 'fr', italian: 'it', italiano: 'it', german: 'de', aleman: 'de',
  catalan: 'ca', quechua: 'qu', aymara: 'ay', japanese: 'ja', japones: 'ja', chinese: 'zh', chino: 'zh',
  korean: 'ko', coreano: 'ko', russian: 'ru', ruso: 'ru', arabic: 'ar', arabe: 'ar', dutch: 'nl',
}));
const NO_LANGUAGE = new Set(['und', 'mul', 'zxx', 'mis', 'qaa', 'unknown', 'none']);

const warnedOnce = new Set();
function warnOnce(logger, key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  try { (logger || console).warn(message); } catch (_) { /* logging is best-effort */ }
}

function stripAccents(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** 'spa' / 'es-419' / 'Español' → 'es'; 'und' / '' → null. */
function normalizeLanguage(value) {
  const raw = stripAccents(value).trim().toLowerCase();
  if (!raw || NO_LANGUAGE.has(raw)) return null;
  if (LANGUAGE_NAMES.has(raw)) return LANGUAGE_NAMES.get(raw);
  const base = raw.split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  if (NO_LANGUAGE.has(base)) return null;
  if (base.length === 2) return base;
  return ISO639_2_TO_1.get(base) || base;
}

function isTextSubtitleCodec(codec) {
  return TEXT_SUBTITLE_CODECS.has(String(codec || '').toLowerCase());
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A missing start is unknown, not zero. Negative starts occur with codec
// priming and must remain signed so callers can align tracks to the container.
function finiteStartTime(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? round3(n) : null;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function tagOf(stream, key) {
  const tags = stream && typeof stream.tags === 'object' && stream.tags ? stream.tags : {};
  if (tags[key] != null) return String(tags[key]);
  const wanted = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === wanted && v != null) return String(v);
  return null;
}

// Matroska writes per-stream durations as a tag «00:01:02.500000000».
function clockToSeconds(value) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(value || '').trim());
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function streamDuration(stream, isMatroska) {
  const direct = finitePositive(stream && stream.duration);
  if (direct) return round3(direct);
  const tagged = clockToSeconds(tagOf(stream, 'DURATION'));
  if (!tagged) return null;
  // FFmpeg's Matroska DURATION tag is the last packet's end timestamp.
  // An audio track starting at 8s and ending at 10s spans 2s, not 10s.
  // Direct stream.duration is already a span and is never offset again.
  const start = isMatroska ? finiteStartTime(stream && stream.start_time) : null;
  const duration = tagged - (start ?? 0);
  return duration > 0 ? round3(duration) : null;
}

function flag(stream, key) {
  const d = stream && typeof stream.disposition === 'object' && stream.disposition ? stream.disposition : {};
  return Number(d[key]) === 1;
}

function parseRate(value) {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(value || '').trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] == null ? 1 : Number(m[2]);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
}

function intOrNull(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanTitle(value) {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}

function emptyProbe(reason) {
  return {
    ok: false,
    error: 'probe_failed',
    reason: reason || 'probe_failed',
    durationSec: null,
    formatName: null,
    formatStartTimeSec: null,
    audio: [],
    subtitles: [],
    video: [],
    hasAudio: false,
    hasVideo: false,
    hasTextSubtitles: false,
  };
}

/** Pure: ffprobe JSON (object or string) → the C1 probe shape. */
function parseProbeJson(json) {
  let data = json;
  if (typeof json === 'string' || Buffer.isBuffer(json)) {
    try { data = JSON.parse(String(json)); } catch (_) { return emptyProbe('invalid_json'); }
  }
  if (!data || typeof data !== 'object') return emptyProbe('invalid_json');
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const format = data.format && typeof data.format === 'object' ? data.format : {};
  const formatName = format.format_name ? String(format.format_name).slice(0, 80) : null;
  const isMatroska = Boolean(formatName && formatName.split(',').some((name) => /^(?:matroska|webm)$/i.test(name.trim())));
  const formatStartTimeSec = finiteStartTime(format.start_time);
  const audio = [];
  const subtitles = [];
  const video = [];
  for (const stream of streams) {
    if (!stream || typeof stream !== 'object') continue;
    const type = String(stream.codec_type || '').toLowerCase();
    const index = Number.isInteger(stream.index) ? stream.index : Number.parseInt(stream.index, 10);
    if (!Number.isInteger(index) || index < 0) continue;
    const codec = stream.codec_name ? String(stream.codec_name).toLowerCase() : null;
    const languageTag = tagOf(stream, 'language');
    const title = cleanTitle(tagOf(stream, 'title'));
    if (type === 'audio') {
      audio.push({
        index,
        streamOrdinal: audio.length,
        codec,
        // Sample-entry tag ('mp4a', 'enca', 'drms'…): lets the engine spot a
        // protected track before it tries to decode it.
        codecTag: stream.codec_tag_string && !/^\[/.test(String(stream.codec_tag_string))
          ? String(stream.codec_tag_string).slice(0, 16) : null,
        channels: intOrNull(stream.channels),
        channelLayout: stream.channel_layout ? String(stream.channel_layout).slice(0, 40) : null,
        sampleRate: intOrNull(stream.sample_rate),
        language: normalizeLanguage(languageTag),
        languageTag: languageTag ? languageTag.slice(0, 16) : null,
        title,
        isDefault: flag(stream, 'default'),
        isComment: flag(stream, 'comment') || Boolean(title && COMMENT_TITLE_RE.test(title)),
        isVisualImpaired: flag(stream, 'visual_impaired') || flag(stream, 'descriptions')
          || Boolean(title && DESCRIPTION_TITLE_RE.test(title)),
        isHearingImpaired: flag(stream, 'hearing_impaired'),
        isMusic: flag(stream, 'karaoke') || Boolean(title && MUSIC_TITLE_RE.test(title)),
        durationSec: streamDuration(stream, isMatroska),
        startTimeSec: finiteStartTime(stream.start_time),
      });
    } else if (type === 'subtitle') {
      subtitles.push({
        index,
        streamOrdinal: subtitles.length,
        codec,
        language: normalizeLanguage(languageTag),
        languageTag: languageTag ? languageTag.slice(0, 16) : null,
        title,
        isDefault: flag(stream, 'default'),
        isForced: flag(stream, 'forced'),
        isHearingImpaired: flag(stream, 'hearing_impaired'),
        textBased: isTextSubtitleCodec(codec),
      });
    } else if (type === 'video') {
      video.push({
        index,
        streamOrdinal: video.length,
        codec,
        width: intOrNull(stream.width),
        height: intOrNull(stream.height),
        attachedPic: flag(stream, 'attached_pic') || flag(stream, 'still_image'),
        fps: parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate),
        durationSec: streamDuration(stream, isMatroska),
        startTimeSec: finiteStartTime(stream.start_time),
      });
    }
  }
  const formatDuration = finitePositive(format.duration);
  const streamMax = [...audio, ...video].reduce((max, stream) => {
    if (!stream.durationSec) return max;
    const offset = stream.startTimeSec != null && formatStartTimeSec != null
      ? Math.max(0, stream.startTimeSec - formatStartTimeSec) : 0;
    return Math.max(max, round3(stream.durationSec + offset));
  }, 0);
  const durationSec = formatDuration ? round3(formatDuration) : (streamMax > 0 ? streamMax : null);
  return {
    ok: true,
    durationSec,
    formatName,
    formatStartTimeSec,
    audio,
    subtitles,
    video,
    hasAudio: audio.length > 0,
    // Cover art in an mp3/m4a is a «video» stream but no picture to read.
    hasVideo: video.some((v) => !v.attachedPic),
    hasTextSubtitles: subtitles.some((s) => s.textBased),
  };
}

// An absolute path can never be parsed as an ffmpeg protocol («concat:»,
// «http:») or an option («-i»).
function inputArg(filePath) {
  return path.resolve(String(filePath));
}

/**
 * Run a media binary with hard limits. Never rejects. stdout is kept up to
 * `maxStdoutBytes` (the child is killed past it), stderr is streamed line by
 * line to `onStderrLine` and only a small tail is kept.
 */
function runMediaCommand(bin, args, {
  signal, timeoutMs = 60_000, maxStdoutBytes = PROBE_MAX_BUFFER, onStderrLine = null, spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    const result = {
      code: null, signal: null, stdout: Buffer.alloc(0), stdoutTruncated: false,
      stderrTail: '', timedOut: false, aborted: false, missing: false, error: null,
    };
    if (signal && signal.aborted) { result.aborted = true; resolve(result); return; }
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      result.missing = err && err.code === 'ENOENT';
      result.error = (err && err.code) || 'spawn_failed';
      resolve(result);
      return;
    }
    const chunks = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let partialLine = '';
    let settled = false;
    let timer = null;
    const kill = () => { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } };
    const onAbort = () => { result.aborted = true; kill(); };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (partialLine && typeof onStderrLine === 'function') {
        try { onStderrLine(partialLine); } catch (_) { /* parser errors never crash */ }
      }
      result.stdout = Buffer.concat(chunks, stdoutBytes);
      result.stderrTail = stderrTail;
      resolve(result);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => { result.timedOut = true; kill(); }, timeoutMs);
    }
    child.on('error', (err) => {
      result.missing = Boolean(err && err.code === 'ENOENT');
      result.error = (err && err.code) || 'spawn_failed';
      finish();
    });
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (result.stdoutTruncated) return;
        const room = maxStdoutBytes - stdoutBytes;
        if (chunk.length > room) {
          if (room > 0) { chunks.push(chunk.subarray(0, room)); stdoutBytes += room; }
          result.stdoutTruncated = true;
          kill();
          return;
        }
        chunks.push(chunk);
        stdoutBytes += chunk.length;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding && child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
        if (typeof onStderrLine !== 'function') return;
        const parts = (partialLine + text).split(/\r?\n|\r/);
        partialLine = parts.pop() || '';
        if (partialLine.length > STDERR_LINE_MAX) partialLine = partialLine.slice(0, STDERR_LINE_MAX);
        for (const line of parts) {
          try { onStderrLine(line.length > STDERR_LINE_MAX ? line.slice(0, STDERR_LINE_MAX) : line); } catch (_) { /* never crash */ }
        }
      });
    }
    child.on('close', (code, sig) => {
      result.code = code;
      result.signal = sig || null;
      finish();
    });
  });
}

async function defaultProbeExec(bin, args, { signal, timeoutMs, maxBuffer }) {
  const res = await runMediaCommand(bin, args, { signal, timeoutMs, maxStdoutBytes: maxBuffer });
  return res;
}

/**
 * ONE ffprobe call (`-show_streams -show_format`, JSON, 4 MB cap). A late
 * audio PID in a TS/.mts capture needs the larger probe window. Never throws:
 * failures come back as `{ ok: false, error: 'probe_failed', reason }`.
 *
 * `exec(bin, args, { signal, timeoutMs, maxBuffer })` is injectable; it may
 * resolve `{ stdout, code?, timedOut?, aborted?, missing?, stdoutTruncated? }`
 * or reject with a child_process-style error.
 */
async function probeMediaStreams(filePath, {
  signal, timeoutMs = PROBE_TIMEOUT_MS, ffprobe = 'ffprobe', exec = null, logger = console,
} = {}) {
  if (!filePath) return emptyProbe('missing_path');
  if (signal && signal.aborted) return emptyProbe('aborted');
  const args = [
    '-v', 'error',
    '-probesize', '100M', '-analyzeduration', '100M',
    '-show_streams', '-show_format',
    '-of', 'json',
    inputArg(filePath),
  ];
  let res;
  try {
    res = await (exec || defaultProbeExec)(ffprobe, args, { signal, timeoutMs, maxBuffer: PROBE_MAX_BUFFER });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      warnOnce(logger, `probe-missing:${ffprobe}`, `[media-probe] ${ffprobe} not available — streams are not probed (degraded)`);
      return emptyProbe('ffprobe_missing');
    }
    if ((signal && signal.aborted) || (err && err.name === 'AbortError')) return emptyProbe('aborted');
    if (err && err.killed) return emptyProbe('timeout');
    if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return emptyProbe('output_too_large');
    // execFile rejects on a non-zero exit but still hands over stdout.
    if (err && err.stdout) res = { stdout: err.stdout, code: typeof err.code === 'number' ? err.code : 1 };
    else return emptyProbe('unreadable');
  }
  if (!res) return emptyProbe('unreadable');
  if (res.missing) {
    warnOnce(logger, `probe-missing:${ffprobe}`, `[media-probe] ${ffprobe} not available — streams are not probed (degraded)`);
    return emptyProbe('ffprobe_missing');
  }
  if (res.aborted || (signal && signal.aborted)) return emptyProbe('aborted');
  if (res.timedOut) return emptyProbe('timeout');
  if (res.stdoutTruncated) return emptyProbe('output_too_large');
  const stdout = res.stdout == null ? '' : String(res.stdout);
  if (!stdout.trim()) return emptyProbe(typeof res.code === 'number' && res.code !== 0 ? 'unreadable' : 'empty_output');
  const parsed = parseProbeJson(stdout);
  if (!parsed.ok) return parsed;
  // ffprobe can exit non-zero after printing the streams of a damaged file:
  // keep what it saw, the caller still gets the right shape.
  if (parsed.audio.length === 0 && parsed.video.length === 0 && parsed.subtitles.length === 0
    && typeof res.code === 'number' && res.code !== 0) {
    return emptyProbe('unreadable');
  }
  return parsed;
}

function isSecondaryAudio(stream) {
  return Boolean(stream && (stream.isComment || stream.isVisualImpaired || stream.isMusic));
}

const CHOICE_REASONS = ['language_match', 'default_disposition', 'not_secondary', 'more_channels', 'lowest_index'];

/**
 * Pick the audio track to transcribe. Preference, in order: the requested
 * language, the default disposition, not commentary / audio description /
 * music by title or disposition, more channels, the lowest index. Loudness is
 * never measured. Returns null ONLY when the probe lists no audio stream —
 * callers check `probe.ok` before reading null as «no audio track».
 */
function chooseAudioStream(probe, { language } = {}) {
  const audio = probe && Array.isArray(probe.audio) ? probe.audio.filter((a) => a && Number.isInteger(a.streamOrdinal)) : [];
  if (audio.length === 0) return null;
  const want = normalizeLanguage(language);
  const ranked = audio.map((a) => ({
    a,
    keys: [
      want && a.language === want ? 1 : 0,
      a.isDefault ? 1 : 0,
      isSecondaryAudio(a) ? 0 : 1,
      Number(a.channels) || 0,
      -(Number.isInteger(a.index) ? a.index : a.streamOrdinal),
    ],
  }));
  ranked.sort((x, y) => {
    for (let i = 0; i < x.keys.length; i += 1) {
      if (x.keys[i] !== y.keys[i]) return y.keys[i] - x.keys[i];
    }
    return 0;
  });
  const winner = ranked[0];
  let reason = 'only_stream';
  if (ranked.length > 1) {
    const runner = ranked[1];
    const at = winner.keys.findIndex((value, i) => value !== runner.keys[i]);
    reason = at >= 0 ? CHOICE_REASONS[at] : 'lowest_index';
  }
  return {
    streamOrdinal: winner.a.streamOrdinal,
    index: winner.a.index,
    reason,
    language: winner.a.language || null,
  };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/** Strip ASS override blocks, HTML tags and ASS escapes from one cue. */
function cleanSubtitleText(value) {
  return String(value || '')
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\\[Nn]/g, ' ')
    .replace(/\\h/g, ' ')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function srtClock(h, m, s, ms) {
  const frac = String(ms || '0').padEnd(3, '0').slice(0, 3);
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(frac) / 1000;
}

const SRT_TIMING_RE = /(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;

/**
 * Pure SRT parser. `{ dropLast }` discards the final block (used when the
 * stream was cut at the byte cap, so the last cue may be incomplete).
 * Identical consecutive cues (roll-up captions) merge into one.
 */
function parseSrt(text, { dropLast = false } = {}) {
  const blocks = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  if (dropLast && blocks.length > 0) blocks.pop();
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => SRT_TIMING_RE.test(line));
    if (at < 0) continue;
    const m = SRT_TIMING_RE.exec(lines[at]);
    const start = srtClock(m[1], m[2], m[3], m[4]);
    const end = srtClock(m[5], m[6], m[7], m[8]);
    const textValue = cleanSubtitleText(lines.slice(at + 1).join(' '));
    if (!textValue || !Number.isFinite(start)) continue;
    cues.push({ start: round3(start), end: round3(Math.max(start, Number.isFinite(end) ? end : start)), text: textValue });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text === cue.text && cue.start - prev.end <= 1) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    merged.push({ ...cue });
  }
  return merged;
}

// «Stream #0:3 -> #0:0 (subrip (srt) -> subrip (srt))» → 'subrip'.
const MAPPING_RE = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))? -> #\d+:\d+ \((\w+)/;

/**
 * Text subtitle track → timed segments (`ffmpeg -map 0:s:N -f srt pipe:1`).
 * Never throws. Bitmap tracks are refused without running ffmpeg when the
 * caller passes the probed `codec`.
 */
async function extractSubtitleSegments(filePath, streamOrdinal, {
  signal, timeoutMs = SUBTITLE_TIMEOUT_MS, maxBytes = SUBTITLE_MAX_BYTES, ffmpeg = 'ffmpeg',
  codec = null, run = null, logger = console,
} = {}) {
  const knownCodec = codec ? String(codec).toLowerCase() : null;
  const fail = (error, extra = {}) => ({ ok: false, error, segments: [], codec: knownCodec, ...extra });
  const ordinal = Number(streamOrdinal);
  if (!filePath) return fail('missing_path');
  if (!Number.isInteger(ordinal) || ordinal < 0) return fail('invalid_stream');
  if (knownCodec && !isTextSubtitleCodec(knownCodec)) {
    return fail(BITMAP_SUBTITLE_CODECS.has(knownCodec) ? 'bitmap_subtitles' : 'unsupported_codec');
  }
  if (signal && signal.aborted) return fail('aborted');
  const cap = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : SUBTITLE_MAX_BYTES;
  let mappedCodec = null;
  const args = [
    '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'info',
    '-i', inputArg(filePath),
    '-map', `0:s:${ordinal}`,
    '-f', 'srt', 'pipe:1',
  ];
  const res = await (run || runMediaCommand)(ffmpeg, args, {
    signal,
    timeoutMs,
    maxStdoutBytes: cap,
    onStderrLine: (line) => {
      if (mappedCodec) return;
      const m = MAPPING_RE.exec(line);
      if (m) mappedCodec = m[1].toLowerCase();
    },
  });
  const outCodec = knownCodec || mappedCodec || null;
  if (res.missing) {
    warnOnce(logger, `ffmpeg-missing:${ffmpeg}`, `[media-probe] ${ffmpeg} not available — subtitle tracks are not read (degraded)`);
    return fail('ffmpeg_missing');
  }
  if (res.aborted || (signal && signal.aborted)) return fail('aborted');
  if (outCodec && !isTextSubtitleCodec(outCodec)) {
    return { ok: false, error: BITMAP_SUBTITLE_CODECS.has(outCodec) ? 'bitmap_subtitles' : 'unsupported_codec', segments: [], codec: outCodec };
  }
  const cut = Boolean(res.stdoutTruncated || res.timedOut);
  const segments = parseSrt(res.stdout ? res.stdout.toString('utf8') : '', { dropLast: cut });
  if (segments.length === 0) {
    if (res.timedOut) return { ok: false, error: 'timeout', segments: [], codec: outCodec };
    if (/matches no streams|Stream map .* matches no/i.test(res.stderrTail || '')) {
      return { ok: false, error: 'stream_not_found', segments: [], codec: outCodec };
    }
    if (res.code === 0) return { ok: true, segments: [], codec: outCodec, empty: true };
    return { ok: false, error: 'subtitle_extract_failed', segments: [], codec: outCodec };
  }
  const out = { ok: true, segments, codec: outCodec };
  if (cut) {
    out.truncated = true;
    out.reason = res.timedOut ? 'timeout' : 'max_bytes';
  }
  return out;
}

let filtersMemo = null;
// A non-definitive answer (timeout, EAGAIN, a killed run) is kept this long,
// so a loaded host is not asked on every video, nor forgotten for the
// life of the process.
const FILTERS_TRANSIENT_MEMO_MS = 60_000;

function parseFilterListing(stdout) {
  const filters = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*[.A-Z|]{2,4}\s+([a-z0-9_]+)\s+\S+->\S+/.exec(line);
    if (m) filters.add(m[1]);
  }
  return filters;
}

/**
 * Pure: one `ffmpeg -filters` run → the capability answer.
 *   definitive: a missing binary (ENOENT) → { available:false }, or a clean
 *     exit with a parsed listing → { available:true, filters }.
 *   anything else (timeout, other spawn error, abort, truncated output, a
 *     non-zero exit, an unparseable listing) → { available:true,
 *     filters:null, definitive:false, reason }: the filter set is UNKNOWN,
 *     so callers try (a missing binary or filter shows up when they run it)
 *     instead of trusting a partial set.
 */
function classifyFiltersRun(res) {
  if (!res || typeof res !== 'object') return { available: true, filters: null, definitive: false, reason: 'no_answer' };
  if (res.missing) return { available: false, filters: new Set(), definitive: true, reason: 'missing' };
  let reason = null;
  if (res.aborted) reason = 'aborted';
  else if (res.timedOut) reason = 'timeout';
  else if (res.error) reason = 'spawn_error';
  else if (res.stdoutTruncated) reason = 'truncated';
  else if (res.code !== 0) reason = `exit_${res.code == null ? 'signal' : res.code}`;
  if (!reason) {
    const filters = parseFilterListing(res.stdout);
    if (filters.size > 0) return { available: true, filters, definitive: true };
    reason = 'unparsed';
  }
  return { available: true, filters: null, definitive: false, reason };
}

/**
 * Memoized `ffmpeg -filters`: { available, filters: Set<string>|null,
 * definitive, reason? }. Only definitive answers are kept for the life of
 * the process (a missing binary is reported once); a non-definitive one is
 * kept FILTERS_TRANSIENT_MEMO_MS and logged as «did not answer». Callers
 * degrade (interval frame sampling when `select`/`showinfo` are absent) and
 * treat `filters: null` as unknown. An injected `run` (tests) is neither
 * memoized nor served from the memo unless `memoize: true`.
 */
function detectFfmpegFilters({
  ffmpeg = 'ffmpeg', run = null, logger = console, refresh = false, memoize = !run, now = Date.now,
} = {}) {
  if (memoize && !refresh && filtersMemo && filtersMemo.bin === ffmpeg && now() < filtersMemo.expiresAt) {
    return filtersMemo.promise;
  }
  const entry = { bin: ffmpeg, promise: null, expiresAt: Infinity };
  entry.promise = (async () => {
    let res;
    try {
      res = await (run || runMediaCommand)(ffmpeg, ['-hide_banner', '-nostdin', '-filters'], {
        timeoutMs: FILTERS_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024,
      });
    } catch (err) {
      res = { error: (err && err.code) || 'run_failed', missing: Boolean(err && err.code === 'ENOENT') };
    }
    const answer = classifyFiltersRun(res);
    if (!answer.available) {
      warnOnce(logger, `ffmpeg-filters:${ffmpeg}`, `[media-probe] ${ffmpeg} not available — video frames are not read (degraded)`);
    } else if (!answer.definitive) {
      try {
        (logger || console).warn(`[media-probe] ${ffmpeg} -filters did not answer (${answer.reason}) — filter set unknown, asking again in ${Math.round(FILTERS_TRANSIENT_MEMO_MS / 1000)} s`);
      } catch (_) { /* logging is best-effort */ }
      entry.expiresAt = now() + FILTERS_TRANSIENT_MEMO_MS;
    }
    return answer;
  })();
  if (memoize) filtersMemo = entry;
  return entry.promise;
}

function resetMediaProbeMemo() {
  filtersMemo = null;
  warnedOnce.clear();
}

module.exports = {
  probeMediaStreams,
  chooseAudioStream,
  extractSubtitleSegments,
  // Helpers shared with video-onscreen-text and the capability report.
  parseProbeJson,
  parseSrt,
  cleanSubtitleText,
  normalizeLanguage,
  isTextSubtitleCodec,
  isSecondaryAudio,
  runMediaCommand,
  detectFfmpegFilters,
  classifyFiltersRun,
  resetMediaProbeMemo,
  TEXT_SUBTITLE_CODECS,
  BITMAP_SUBTITLE_CODECS,
  PROBE_MAX_BUFFER,
  SUBTITLE_MAX_BYTES,
};
