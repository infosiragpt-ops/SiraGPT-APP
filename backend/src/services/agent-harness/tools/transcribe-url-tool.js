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
const mediaDiscovery = require('./media-discovery');
const cookieJar = require('./cookie-jar-store');
const mediaCapture = require('./media-capture');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_SECONDS = 3 * 60 * 60;
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
  const maxSeconds = Number(env.TRANSCRIBE_URL_MAX_SECONDS) > 0 ? Number(env.TRANSCRIBE_URL_MAX_SECONDS) : DEFAULT_MAX_SECONDS;
  const discoveryEnabled = String(env.TRANSCRIBE_URL_BROWSER_DISCOVERY || '1') !== '0';
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

    // 4–5. Transcribe the clip and deliver it (shared by every acquisition path).
    const finish = async ({ clipPath, title, rangeStart, rangeEnd, duration, sectioned, via, partial = null }) => {
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
        via,
        ...(partial ? { partial } : {}),
        ...(discovery ? { discovery } : {}),
        ...(cookiesInfo ? { cookies: cookiesInfo } : {}),
        elapsedMs: Date.now() - startedAt,
      };
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
    if (span == null && duration == null && end == null) {
      // Unknown duration and no end: cap at maxSeconds from start.
      rangeEnd = rangeStart + maxSeconds;
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

    return finish({ clipPath, title, rangeStart, rangeEnd, duration, sectioned, via: target.via });
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
};
