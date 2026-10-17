'use strict';

/**
 * Local Whisper engine — ffmpeg + whisper.cpp, with optional Python
 * faster-whisper fallback. No paid API. No OpenRouter.
 *
 * Config:
 *   FFMPEG_PATH / WHISPER_CPP_BIN / WHISPER_CPP_MODEL
 *   LOCAL_WHISPER_MODEL (faster-whisper / openai-whisper name, default base)
 *   LOCAL_WHISPER_TIMEOUT_MS (default 180000)
 *   WHISPER_CPP_BEAM_SIZE (default 5 for media up to 10 min, 2 for longer
 *   media: a 5-hour lecture decodes ~2x faster with a negligible accuracy cost)
 *
 * whisper.cpp runs WITH timestamp decoding (no `-nt`): segment offsets in the
 * JSON output are real and decoding seeks on segment ends instead of hard
 * 30 s windows. An unknown language is passed as `-l auto` — whisper-cli
 * otherwise assumes English.
 *
 * Flags are never trusted, they are feature-detected: `whisper-cli -h` is
 * read once per binary (memoized) and only what it lists is used.
 *   -ojf (full JSON with token probabilities) → every segment gets a
 *     `confidence` (geometric mean of its text tokens' p), so local output
 *     finally carries the quality signal cloud verbose_json already has;
 *   --vad + --vad-model (whisper.cpp ≥ 1.7.6, Silero) → only with
 *     WHISPER_CPP_VAD=1 and a readable model (WHISPER_CPP_VAD_MODEL, else
 *     /usr/local/share/whisper/ggml-silero-v5.1.2.bin);
 *   -mc N (max text context) → only when the transcriber asks for it
 *     (options.maxContext, a re-decode after a repetition loop).
 * A binary whose help cannot be read keeps today's exact arguments (one WARN).
 * options.audioFilter (an ffmpeg -af chain the transcriber builds for an
 * alternative hypothesis: loudness / dynamic normalisation, high-pass) is
 * applied to the WAV decode only when given.
 * The Python fallback (not installed in production) is remembered as missing
 * for an hour after an import error or a missing interpreter, so a failed
 * whisper.cpp run stops spawning a doomed python process every time.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');
const { buildUntrustedChildEnv } = require('../utils/untrusted-child-env');

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_BEAM_SIZE = 5;
const LONG_MEDIA_BEAM_SIZE = 2;
const LONG_MEDIA_SECONDS = 600;
const MAX_PROMPT_CHARS = 1000;
const PYTHON_SCRIPT = path.join(__dirname, '../../scripts/local-whisper.py');
const HELP_TIMEOUT_MS = 10_000;
const HELP_MAX_BUFFER = 512 * 1024;
// A `whisper-cli -h` that failed for any reason but a binary that cannot run
// is read again after this (a timeout under load must not disable -ojf/-mc
// for the life of the process).
const HELP_RETRY_MS = 5 * 60_000;
const PERMANENT_HELP_ERRORS = new Set(['ENOENT', 'EACCES', 'ENOEXEC']);
const VAD_MODEL_CANDIDATES = Object.freeze([
  '/usr/local/share/whisper/ggml-silero-v5.1.2.bin',
  '/usr/local/share/whisper/ggml-silero-v6.2.0.bin',
]);
const PYTHON_MISSING_MEMO_MS = 60 * 60 * 1000;
// An ffmpeg -af chain the transcriber builds itself (filter names, numbers,
// = : , . _ -): anything else is ignored, never passed to ffmpeg.
const SAFE_AUDIO_FILTER_RE = /^[a-z][a-z0-9=:,._-]{0,300}$/i;
const EMPTY_CAPABILITIES = Object.freeze({
  outputJsonFull: false, vad: false, maxContext: false, suppressNst: false, detectLanguage: false, carryInitialPrompt: false,
});

function envOf(options) {
  return options.env || process.env;
}

function ffmpegPath(options) {
  return options.ffmpegPath || envOf(options).FFMPEG_PATH || 'ffmpeg';
}

function pythonPath(options) {
  return options.pythonPath || envOf(options).LOCAL_WHISPER_PYTHON || 'python3';
}

function modelName(options) {
  return options.model || envOf(options).LOCAL_WHISPER_MODEL || 'base';
}

function timeoutMs(options) {
  const raw = Number.parseInt(options.timeoutMs || envOf(options).LOCAL_WHISPER_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Two concurrent STT workers share host cores; explicit overrides remain supported. */
function defaultThreadCount() {
  let cores = 1;
  try { cores = Math.max(1, (os.cpus() || []).length || 1); } catch (_) { cores = 1; }
  return Math.max(1, Math.min(4, Math.floor(cores / 2) || 1));
}

function resolveThreadCount(options) {
  const env = envOf(options);
  const raw = options.threads ?? env.WHISPER_CPP_THREADS ?? env.WHISPER_THREADS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultThreadCount();
}

/**
 * whisper.cpp runtime budget scales with the audio: a 16 kHz mono 16-bit WAV
 * holds 32 000 bytes per second. Base model on a few threads runs several
 * times faster than real time; 2.5 s of budget per audio second plus a
 * minute of headroom covers slow hosts without letting a 2-hour lecture die
 * at the old fixed 3-minute limit. LOCAL_WHISPER_TIMEOUT_MS is a floor.
 */
function whisperTimeoutForWav(wavBytes, options = {}) {
  const seconds = Math.max(0, Number(wavBytes) || 0) / 32000;
  const scaled = Math.ceil(seconds * 2500) + 60_000;
  return Math.max(timeoutMs(options), scaled);
}

/**
 * Beam width for whisper.cpp. Explicit `options.beamSize` or
 * WHISPER_CPP_BEAM_SIZE (1-10) wins; otherwise 5 for clips up to 10 minutes
 * and 2 for long media (the whole recording's length, not the segment's).
 */
function resolveBeamSize(options = {}) {
  const raw = options.beamSize ?? envOf(options).WHISPER_CPP_BEAM_SIZE;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(10, n);
  const media = Number(options.mediaDurationSeconds ?? options.durationSeconds) || 0;
  return media > LONG_MEDIA_SECONDS ? LONG_MEDIA_BEAM_SIZE : DEFAULT_BEAM_SIZE;
}

/** ISO code for whisper.cpp, or 'auto' (whisper-cli assumes English without -l). */
function whisperLanguageArg(language) {
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]{1,8})*$/i.exec(String(language || '').trim());
  if (!match) return 'auto';
  return match[1].toLowerCase();
}

/** One line, no control characters, capped: it travels as a single argv entry. */
function cleanPrompt(prompt) {
  const text = String(prompt || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_PROMPT_CHARS) : '';
}

/**
 * whisper-cli argv. `capabilities` (from whisperCliCapabilities) gates every
 * optional flag: without it the arguments are exactly today's.
 *   -ojf only when listed; --vad --vad-model only when listed AND a model is
 *   given; -mc only when listed AND maxContext is a non-negative integer.
 */
function buildWhisperCppArgs({ modelPath, wavPath, outBase, language, threads, prompt, beamSize, capabilities = null, vadModel = null, maxContext = null }) {
  const caps = capabilities || EMPTY_CAPABILITIES;
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-otxt',
    '-oj',
    ...(caps.outputJsonFull ? ['-ojf'] : []),
    '-of', outBase,
    '--no-prints',
    '-ng',
    '-t', String(threads ?? 1),
    '-l', whisperLanguageArg(language),
  ];
  const beam = Number(beamSize);
  if (Number.isFinite(beam) && beam >= 1) args.push('-bs', String(Math.floor(beam)));
  if (caps.maxContext && Number.isInteger(maxContext) && maxContext >= 0) args.push('-mc', String(maxContext));
  if (caps.vad && typeof vadModel === 'string' && vadModel) args.push('--vad', '--vad-model', vadModel);
  const initialPrompt = cleanPrompt(prompt);
  if (initialPrompt) args.push('--prompt', initialPrompt);
  return args;
}

/** What a `whisper-cli -h` text lists (flags this build accepts). Pure. */
function parseWhisperHelp(text) {
  const help = String(text || '');
  if (!/-m\b|--model|usage/i.test(help)) return { ...EMPTY_CAPABILITIES };
  const has = (re) => re.test(help);
  return {
    outputJsonFull: has(/(?:^|\s)(?:-ojf|--output-json-full)(?=[\s,]|$)/m),
    vad: has(/(?:^|\s)--vad(?=[\s,]|$)/m) && has(/(?:^|\s)--vad-model(?=[\s,]|$)/m),
    maxContext: has(/(?:^|\s)(?:-mc|--max-context)(?=[\s,]|$)/m),
    suppressNst: has(/(?:^|\s)(?:-sns|--suppress-nst)(?=[\s,]|$)/m),
    detectLanguage: has(/(?:^|\s)(?:-dl|--detect-language)(?=[\s,]|$)/m),
    carryInitialPrompt: has(/(?:^|\s)--carry-initial-prompt(?=[\s,]|$)/m),
  };
}

function normalizeCapabilities(value) {
  const out = { ...EMPTY_CAPABILITIES };
  for (const key of Object.keys(EMPTY_CAPABILITIES)) out[key] = value?.[key] === true;
  return out;
}

const capabilityMemo = new Map();
const injectedCapabilityMemo = new WeakMap();
let capabilityWarned = false;

function warnCapabilitiesOnce(reason, logImpl) {
  if (capabilityWarned) return;
  capabilityWarned = true;
  try { (logImpl || console.warn)(`[local-whisper] could not read whisper-cli -h (${reason}); using the base arguments only`); } catch { /* best-effort */ }
}

/**
 * The flags a whisper-cli binary accepts, read from `-h` ONCE per binary
 * (memoized; injectable: options.whisperCapabilities = { outputJsonFull, vad,
 * maxContext, … } or options.whisperHelp = '<help text>', or
 * options.whisperHelpImpl(bin, args) → { stdout, stderr }). Never throws: a
 * help that cannot be read is «no optional flag» (today's arguments). Only a
 * help that was read, or a binary that cannot run (ENOENT / EACCES), is
 * remembered for the process; any other failure (timeout, EAGAIN under load)
 * is read again after HELP_RETRY_MS (options.now injects the clock).
 */
async function whisperCliCapabilities(bin, options = {}) {
  if (options.whisperCapabilities && typeof options.whisperCapabilities === 'object') return normalizeCapabilities(options.whisperCapabilities);
  if (typeof options.whisperHelp === 'string') return parseWhisperHelp(options.whisperHelp);
  if (!bin) return { ...EMPTY_CAPABILITIES };
  const injected = typeof options.whisperHelpImpl === 'function' ? options.whisperHelpImpl : null;
  const memo = injected ? (injectedCapabilityMemo.get(injected) || new Map()) : capabilityMemo;
  if (injected && !injectedCapabilityMemo.has(injected)) injectedCapabilityMemo.set(injected, memo);
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const known = memo.get(bin);
  if (known && !(known.retryAt != null && clock() >= known.retryAt)) return known.pending;
  const entry = { pending: null, retryAt: null };
  entry.pending = (async () => {
    const run = injected || ((command, args) => new Promise((resolve, reject) => {
      execFile(command, args, {
        timeout: HELP_TIMEOUT_MS, maxBuffer: HELP_MAX_BUFFER, windowsHide: true,
        env: buildUntrustedChildEnv({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG }),
      }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
    }));
    try {
      const out = await run(bin, ['-h']);
      return parseWhisperHelp(`${out?.stdout || ''}\n${out?.stderr || ''}`);
    } catch (err) {
      // Some builds print the usage and exit non-zero: the text still counts.
      const text = `${err?.stdout || ''}\n${err?.stderr || ''}`;
      if (/usage|options:/i.test(text)) return parseWhisperHelp(text);
      warnCapabilitiesOnce(err?.code || 'failed', options.logImpl);
      if (!PERMANENT_HELP_ERRORS.has(err?.code)) entry.retryAt = clock() + HELP_RETRY_MS;
      return { ...EMPTY_CAPABILITIES };
    }
  })();
  memo.set(bin, entry);
  return entry.pending;
}

function resetCapabilityMemo() {
  capabilityMemo.clear();
  capabilityWarned = false;
}

function vadRequested(options = {}) {
  return /^(?:1|true|on|yes)$/i.test(String(envOf(options).WHISPER_CPP_VAD || '').trim());
}

/** A readable Silero model: options.vadModelPath, WHISPER_CPP_VAD_MODEL, then the bundled paths. */
function vadModelPath(options = {}) {
  const env = envOf(options);
  const candidates = [options.vadModelPath, env.WHISPER_CPP_VAD_MODEL, ...VAD_MODEL_CANDIDATES]
    .filter((p) => typeof p === 'string' && p.includes('/'));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && accessible(candidate, fs.constants.R_OK, options.accessImpl)) return candidate;
  }
  return null;
}

let vadWarned = false;
function warnVadOnce(reason, logImpl) {
  if (vadWarned) return;
  vadWarned = true;
  try { (logImpl || console.warn)(`[local-whisper] WHISPER_CPP_VAD=1 ignored: ${reason}`); } catch { /* best-effort */ }
}

function candidateBins(options) {
  const env = envOf(options);
  return [
    options.whisperBin,
    env.WHISPER_CPP_BIN,
    '/usr/local/bin/whisper-cli',
    path.join(os.homedir(), '.local/bin/whisper-cli'),
    'whisper-cli',
    'whisper-cpp',
  ].filter(Boolean);
}

function candidateModels(options) {
  const env = envOf(options);
  return [
    options.modelPath,
    env.WHISPER_CPP_MODEL,
    '/usr/local/share/whisper/ggml-base.bin',
    '/usr/local/share/whisper/ggml-base-q5_1.bin',
    path.join(os.homedir(), '.local/share/whisper/ggml-base.bin'),
    path.join(os.homedir(), '.cache/whisper/ggml-base.bin'),
  ].filter(Boolean);
}

function firstExistingFile(paths) {
  for (const candidate of paths) {
    if (typeof candidate === 'string' && candidate.includes('/') && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function accessible(filePath, mode, accessImpl) {
  try { (accessImpl || fs.accessSync)(filePath, mode); return true; } catch { return false; }
}

function currentUid() {
  try { return typeof process.getuid === 'function' ? process.getuid() : null; } catch { return null; }
}

/**
 * Why the local engine can (or cannot) run, without spawning anything.
 * Prod 2026-09-28: the model file existed but was `-rw------- root` while the
 * backend runs as uid 100, and the only log line was «local whisper
 * unavailable». `reason` names the real cause so Admin → Logs shows it.
 *
 * @returns {{ ok: boolean, code: string|null, reason: string|null, bin: string|null, model: string|null, ffmpeg: string }}
 */
function describeLocalWhisperAvailability(options = {}) {
  const access = options.accessImpl || null;
  const uid = currentUid();
  const who = uid == null ? 'this process' : `uid ${uid}`;
  const ffmpeg = ffmpegPath(options);
  const bins = candidateBins(options);
  const models = candidateModels(options);
  const binExisting = firstExistingFile(bins);
  const binUsable = bins.find((p) => typeof p === 'string' && p.includes('/') && fs.existsSync(p) && accessible(p, fs.constants.X_OK, access)) || null;
  const modelExisting = firstExistingFile(models);
  const modelUsable = models.find((p) => typeof p === 'string' && p.includes('/') && fs.existsSync(p) && accessible(p, fs.constants.R_OK, access)) || null;
  const out = { ok: false, code: null, reason: null, bin: binUsable || binExisting, model: modelUsable || modelExisting, ffmpeg };
  if (!binExisting) {
    return { ...out, code: 'binary_missing', reason: `whisper-cli binary missing (${bins[0] || 'whisper-cli'})` };
  }
  if (!binUsable) {
    return { ...out, code: 'binary_not_executable', reason: `whisper-cli not executable by ${who} (${binExisting})` };
  }
  if (!modelExisting) {
    return { ...out, code: 'model_missing', reason: `model missing (${models[0] || 'ggml-base.bin'})` };
  }
  if (!modelUsable) {
    return { ...out, code: 'model_not_readable', reason: `model not readable by ${who} (${modelExisting})` };
  }
  if (path.isAbsolute(ffmpeg) && !fs.existsSync(ffmpeg)) {
    return { ...out, code: 'ffmpeg_missing', reason: `ffmpeg missing (${ffmpeg})` };
  }
  return { ...out, ok: true };
}

// The reason is logged once per process: every audio job repeats the same
// diagnosis and the transcriber already logs the per-job failure line.
let availabilityLogged = false;
function logAvailabilityOnce(reason, logImpl) {
  if (availabilityLogged || !reason) return;
  availabilityLogged = true;
  try { (logImpl || console.warn)(`[local-whisper] unavailable: ${reason}`); } catch { /* logging is best-effort */ }
}
function resetAvailabilityLog() { availabilityLogged = false; }

function unavailableError(reason, cause) {
  const err = new Error(`local whisper unavailable: ${reason}`);
  err.code = 'LOCAL_WHISPER_UNAVAILABLE';
  err.reason = reason;
  if (cause) err.cause = cause;
  return err;
}

function runProcess(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const limitMs = timeoutMs(options);
  const env = buildUntrustedChildEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  });

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error('local whisper cancelled');
      err.code = 'LOCAL_WHISPER_ABORTED';
      reject(err);
      return;
    }

    let child;
    let settled = false;
    const stdout = [];
    const stderr = [];

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.('abort', onAbort);
      clearTimeout(timer);
      fn(value);
    };

    const onAbort = () => {
      try { child?.kill('SIGKILL'); } catch { /* ignore */ }
      const err = new Error('local whisper cancelled');
      err.code = 'LOCAL_WHISPER_ABORTED';
      finish(reject, err);
    };

    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* ignore */ }
      const err = new Error('local whisper timed out');
      err.code = 'LOCAL_WHISPER_TIMEOUT';
      finish(reject, err);
    }, limitMs);
    timer.unref?.();

    try {
      child = spawnImpl(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      const err = new Error('local whisper tool could not start');
      err.code = 'LOCAL_WHISPER_UNAVAILABLE';
      err.cause = error;
      finish(reject, err);
      return;
    }

    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      const err = new Error('local whisper tool is unavailable');
      err.code = error?.code === 'ENOENT' ? 'LOCAL_WHISPER_UNAVAILABLE' : 'LOCAL_WHISPER_SPAWN';
      err.cause = error;
      finish(reject, err);
    });
    child.once('close', (code, signal) => {
      const stderrText = Buffer.concat(stderr).toString('utf8').slice(-2000);
      if (code !== 0) {
        const err = new Error('local whisper process failed');
        err.code = 'LOCAL_WHISPER_FAILED';
        err.exitCode = code;
        // A SIGKILL we did not send (our timeout and abort settle first) is the
        // kernel's OOM killer: the transcriber treats repeats as deterministic.
        err.signal = signal || null;
        err.diagnostics = stderrText;
        finish(reject, err);
        return;
      }
      finish(resolve, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: stderrText,
      });
    });
  });
}

/**
 * Decoding to WAV scales with the input: a whole-file run of a long recording
 * must not die at the 3-minute floor (100 ms per audio second, like the
 * segmentation pass).
 */
function conversionTimeoutMs(options = {}) {
  const seconds = Number(options.mediaDurationSeconds ?? options.durationSeconds) || 0;
  return Math.max(timeoutMs(options), Math.ceil(seconds * 100));
}

/**
 * `-map 0:a:N` for the audio track the transcriber chose (media-probe's
 * chooseAudioStream, or the caller's options.audioStreamOrdinal); nothing
 * when none was given, so ffmpeg keeps its default stream as before.
 */
function audioStreamMapArgs(ordinal) {
  const n = typeof ordinal === 'number' ? ordinal : (typeof ordinal === 'string' && /^\d+$/.test(ordinal.trim()) ? Number(ordinal) : NaN);
  return Number.isInteger(n) && n >= 0 && n < 64 ? ['-map', `0:a:${n}`] : [];
}

/**
 * Input options that go with a mapped track: media-probe's stream-discovery
 * window. An ordinal only names the same track under the same window — in an
 * MPEG-PS/VOB whose audio starts late, ffmpeg's default 5 MB / 5 s window
 * lists the tracks in another order (`0:a:1` silently decodes the other one)
 * or not at all. Nothing when no track is mapped (today's decode).
 */
function audioStreamProbeArgs(ordinal) {
  return audioStreamMapArgs(ordinal).length ? ['-probesize', '100M', '-analyzeduration', '100M'] : [];
}

/** `-af <chain>` for an alternative-hypothesis decode; nothing for anything else. */
function audioFilterArgs(filter) {
  return typeof filter === 'string' && SAFE_AUDIO_FILTER_RE.test(filter) ? ['-af', filter] : [];
}

async function convertToWav(inputPath, wavPath, options = {}) {
  await runProcess(ffmpegPath(options), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...audioStreamProbeArgs(options.audioStreamOrdinal),
    '-i', inputPath,
    ...audioStreamMapArgs(options.audioStreamOrdinal),
    // Video containers: keep the audio track only (a WAV muxer cannot hold
    // video/subtitle/data streams and ffmpeg would fail instead).
    '-vn', '-sn', '-dn',
    ...audioFilterArgs(options.audioFilter),
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    wavPath,
  ], options);
  const stat = await fsPromises.stat(wavPath).catch(() => null);
  if (!stat || !stat.size) {
    const err = new Error('ffmpeg produced an empty wav');
    err.code = 'LOCAL_WHISPER_FFMPEG';
    throw err;
  }
}

const SPECIAL_TOKEN_RE = /^(?:\[_[A-Z]+_?\d*\]|\[_[A-Z_]+\d*\]|<\|[^|]*\|>)$/;

/** { confidence, minP } from -ojf tokens (geometric mean of p), or null without usable tokens. */
function tokenConfidence(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  let count = 0;
  let logSum = 0;
  let minP = 1;
  for (const token of tokens) {
    const text = String(token?.text ?? '').trim();
    const p = Number(token?.p);
    if (!text || SPECIAL_TOKEN_RE.test(text) || !Number.isFinite(p) || p <= 0) continue;
    const bounded = Math.min(1, p);
    count++;
    logSum += Math.log(bounded);
    if (bounded < minP) minP = bounded;
  }
  if (!count) return null;
  return { confidence: Math.round(Math.exp(logSum / count) * 1000) / 1000, minP: Math.round(minP * 1000) / 1000 };
}

function parseWhisperCppJson(raw) {
  const invalid = { text: '', segments: [], valid: false };
  if (!raw) return invalid;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (typeof parsed.text !== 'string' && !Array.isArray(parsed.transcription))
    || (parsed.text !== undefined && typeof parsed.text !== 'string')
    || (parsed.transcription !== undefined && !Array.isArray(parsed.transcription))) return invalid;
  const rows = Array.isArray(parsed.transcription) ? parsed.transcription : [];
  if (rows.some((row) => !row || typeof row.text !== 'string')) return invalid;
  const seconds = (offset, stamp) => {
    if (Number.isFinite(offset)) return Math.max(0, offset / 1000);
    const match = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(stamp || ''));
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`) : 0;
  };
  const segments = rows.map((row) => {
    const segment = {
      start: seconds(row.offsets?.from, row.timestamps?.from),
      end: seconds(row.offsets?.to, row.timestamps?.to),
      text: String(row.text || '').trim(),
    };
    // -ojf: token probabilities → the segment's confidence (geometric mean of
    // its text tokens' p, special tokens such as [_BEG_] / [_TT_42] ignored).
    const tokens = tokenConfidence(row.tokens);
    if (tokens) {
      segment.confidence = tokens.confidence;
      segment.minP = tokens.minP;
    }
    return segment;
  }).filter((row) => row.text);
  const text = String(parsed.text || segments.map((s) => s.text).join(' ')).trim();
  return { text, segments, language: parsed.result?.language || parsed.language || null, valid: true };
}

async function readIfExists(filePath) {
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function transcribeWithWhisperCpp(wavPath, language, options = {}) {
  const wavStat = await fsPromises.stat(wavPath).catch(() => null);
  const scopedOptions = { ...options, timeoutMs: whisperTimeoutForWav(wavStat ? wavStat.size : 0, options) };
  const bin = options.whisperBin || firstExistingFile(candidateBins(options)) || candidateBins(options)[0];
  const modelPath = firstExistingFile(candidateModels(options));
  if (!bin) {
    throw unavailableError(`whisper-cli binary missing (${candidateBins(options)[0] || 'whisper-cli'})`);
  }
  if (!modelPath) {
    throw unavailableError(`model missing (${candidateModels(options)[0] || 'ggml-base.bin'})`);
  }
  if (!accessible(modelPath, fs.constants.R_OK, options.accessImpl)) {
    const uid = currentUid();
    throw unavailableError(`model not readable by ${uid == null ? 'this process' : `uid ${uid}`} (${modelPath})`);
  }

  const outBase = path.join(path.dirname(wavPath), 'transcript');
  const capabilities = await whisperCliCapabilities(bin, options);
  let vadModel = null;
  if (vadRequested(options)) {
    if (!capabilities.vad) warnVadOnce('this whisper-cli has no --vad (whisper.cpp ≥ 1.7.6)', options.logImpl);
    else {
      vadModel = vadModelPath(options);
      if (!vadModel) warnVadOnce('no readable Silero model (WHISPER_CPP_VAD_MODEL)', options.logImpl);
    }
  }
  const maxContext = Number.isInteger(options.maxContext) && options.maxContext >= 0 ? options.maxContext : null;
  const args = buildWhisperCppArgs({
    modelPath,
    wavPath,
    outBase,
    language,
    threads: resolveThreadCount(options),
    prompt: options.prompt,
    beamSize: resolveBeamSize(options),
    capabilities,
    vadModel,
    maxContext,
  });

  const run = await runProcess(bin, args, scopedOptions);
  const txt = (await readIfExists(`${outBase}.txt`) || '').trim();
  const rawJson = await readIfExists(`${outBase}.json`);
  const json = parseWhisperCppJson(rawJson);
  if (rawJson !== null && !json.valid) {
    const err = new Error('whisper.cpp returned invalid output');
    err.code = 'LOCAL_WHISPER_INVALID_OUTPUT';
    throw err;
  }
  const text = txt || json.text;
  // A successful decoder with valid empty JSON found no speech. Missing
  // output (or stdout diagnostics alone) is not evidence of silence.
  if (!text && !json.valid) {
    const err = new Error('whisper.cpp returned no output');
    err.code = 'LOCAL_WHISPER_EMPTY';
    // whisper-cli exits 0 without output on an unknown `-l`: its words say so.
    err.diagnostics = String(run?.stderr || '').slice(-2000);
    throw err;
  }
  const forced = whisperLanguageArg(language);
  return {
    text,
    segments: json.segments,
    language: (forced !== 'auto' ? forced : null) || json.language || null,
    model: path.basename(modelPath),
    engine: 'whisper.cpp',
    ...(vadModel ? { vad: true } : {}),
  };
}

async function transcribeWithPython(wavPath, language, options = {}) {
  const outPath = path.join(path.dirname(wavPath), 'transcript-python.json');
  const args = [
    PYTHON_SCRIPT,
    '--audio', wavPath,
    '--output', outPath,
    '--model', modelName(options),
  ];
  const forced = whisperLanguageArg(language);
  if (forced !== 'auto') args.push('--language', forced);
  const wavStat = await fsPromises.stat(wavPath).catch(() => null);
  await runProcess(pythonPath(options), args, { ...options, timeoutMs: whisperTimeoutForWav(wavStat?.size || 0, options) });
  const raw = await readIfExists(outPath);
  if (!raw) {
    const err = new Error('python whisper returned no output');
    err.code = 'LOCAL_WHISPER_EMPTY';
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { /* invalid output is handled below */ }
  if (!parsed || typeof parsed.text !== 'string'
    || (parsed.segments !== undefined && (!Array.isArray(parsed.segments)
      || parsed.segments.some((row) => !row || typeof row.text !== 'string')))) {
    const err = new Error('python whisper returned invalid output');
    err.code = 'LOCAL_WHISPER_INVALID_OUTPUT';
    throw err;
  }
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const text = parsed.text.trim() || segments.map((row) => row.text.trim()).filter(Boolean).join(' ');
  return {
    text,
    segments,
    language: parsed.language || (forced !== 'auto' ? forced : null),
    model: parsed.model || modelName(options),
    engine: parsed.engine || 'faster-whisper',
  };
}

// The Python fallback is not installed in production (no faster-whisper on
// musl): remember an import error or a missing interpreter for an hour, per
// interpreter (and per injected spawn implementation, so tests stay apart).
const pythonMissing = new Map();
const injectedPythonMissing = new WeakMap();

function pythonMemoFor(options = {}) {
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : null;
  if (!spawnImpl) return pythonMissing;
  if (!injectedPythonMissing.has(spawnImpl)) injectedPythonMissing.set(spawnImpl, new Map());
  return injectedPythonMissing.get(spawnImpl);
}

function pythonFallbackKnownMissing(options = {}) {
  const entry = pythonMemoFor(options).get(pythonPath(options));
  return Boolean(entry && Date.now() - entry.at < PYTHON_MISSING_MEMO_MS);
}

function rememberPythonFailure(err, options = {}) {
  const diagnostics = String(err?.diagnostics || '');
  // scripts/local-whisper.py exits 2 exactly when no engine can be imported.
  const missingModule = err?.code === 'LOCAL_WHISPER_FAILED'
    && (err.exitCode === 2 || /No module named|ModuleNotFoundError|ImportError|local-whisper unavailable/i.test(diagnostics));
  const missingInterpreter = err?.code === 'LOCAL_WHISPER_UNAVAILABLE' && (!err?.cause?.code || err.cause.code === 'ENOENT');
  if (missingModule || missingInterpreter) pythonMemoFor(options).set(pythonPath(options), { at: Date.now() });
}

function resetPythonFallbackMemo() {
  pythonMissing.clear();
}

async function transcribeLocal(filePath, options = {}) {
  if (typeof options.transcribeLocal === 'function') {
    return options.transcribeLocal(filePath, options);
  }

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-local-whisper-'));
  const wavPath = path.join(tmpDir, 'audio.wav');
  try {
    try {
      await convertToWav(filePath, wavPath, { ...options, timeoutMs: conversionTimeoutMs(options) });
    } catch (err) {
      if (err.code === 'LOCAL_WHISPER_UNAVAILABLE') {
        const reason = `ffmpeg missing (${ffmpegPath(options)})`;
        logAvailabilityOnce(reason, options.logImpl);
        throw unavailableError(reason, err);
      }
      if (err.code === 'LOCAL_WHISPER_ABORTED' || err.code === 'LOCAL_WHISPER_TIMEOUT') throw err;
      throw Object.assign(new Error('Audio could not be decoded'), { code: 'AUDIO_DECODE_FAILED', cause: err });
    }
    try {
      return await transcribeWithWhisperCpp(wavPath, options.language, options);
    } catch (cppErr) {
      if (cppErr?.code === 'LOCAL_WHISPER_ABORTED') throw cppErr;
      try {
        if (pythonFallbackKnownMissing(options)) {
          throw Object.assign(new Error('python whisper fallback unavailable'), { code: 'LOCAL_WHISPER_UNAVAILABLE', remembered: true });
        }
        try {
          return await transcribeWithPython(wavPath, options.language, options);
        } catch (pyErr) {
          rememberPythonFailure(pyErr, options);
          throw pyErr;
        }
      } catch (pyErr) {
        if (pyErr?.code === 'LOCAL_WHISPER_ABORTED') throw pyErr;
        // Name the real cause (binary / model / permissions) instead of the
        // bare «local whisper unavailable» that hid an unreadable model file.
        let reason = cppErr?.reason || null;
        if (!reason) {
          const availability = describeLocalWhisperAvailability(options);
          reason = availability.ok
            ? `whisper.cpp ${cppErr?.code || 'failed'}${cppErr?.exitCode != null ? ` (exit ${cppErr.exitCode})` : ''}; python fallback ${pyErr?.code || 'failed'}`
            : availability.reason;
        }
        logAvailabilityOnce(reason, options.logImpl);
        const err = unavailableError(reason, pyErr || cppErr);
        err.cppError = cppErr;
        throw err;
      }
    }
  } finally {
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  parseWhisperCppJson,
  tokenConfidence,
  parseWhisperHelp,
  whisperCliCapabilities,
  resetCapabilityMemo,
  vadModelPath,
  vadRequested,
  audioFilterArgs,
  resetPythonFallbackMemo,
  pythonFallbackKnownMissing,
  describeLocalWhisperAvailability,
  logAvailabilityOnce,
  resetAvailabilityLog,
  defaultThreadCount,
  whisperTimeoutForWav,
  transcribeLocal,
  convertToWav,
  audioStreamMapArgs,
  audioStreamProbeArgs,
  transcribeWithWhisperCpp,
  transcribeWithPython,
  candidateBins,
  candidateModels,
  resolveThreadCount,
  resolveBeamSize,
  whisperLanguageArg,
  conversionTimeoutMs,
  buildWhisperCppArgs,
};
