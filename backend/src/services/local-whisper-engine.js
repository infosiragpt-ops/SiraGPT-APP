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
 */

const { spawn } = require('child_process');
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

function buildWhisperCppArgs({ modelPath, wavPath, outBase, language, threads, prompt, beamSize }) {
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-otxt',
    '-oj',
    '-of', outBase,
    '--no-prints',
    '-ng',
    '-t', String(threads ?? 1),
    '-l', whisperLanguageArg(language),
  ];
  const beam = Number(beamSize);
  if (Number.isFinite(beam) && beam >= 1) args.push('-bs', String(Math.floor(beam)));
  const initialPrompt = cleanPrompt(prompt);
  if (initialPrompt) args.push('--prompt', initialPrompt);
  return args;
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
    child.once('close', (code) => {
      const stderrText = Buffer.concat(stderr).toString('utf8').slice(-2000);
      if (code !== 0) {
        const err = new Error('local whisper process failed');
        err.code = 'LOCAL_WHISPER_FAILED';
        err.exitCode = code;
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

async function convertToWav(inputPath, wavPath, options = {}) {
  await runProcess(ffmpegPath(options), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', inputPath,
    // Video containers: keep the audio track only (a WAV muxer cannot hold
    // video/subtitle/data streams and ffmpeg would fail instead).
    '-vn', '-sn', '-dn',
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
  const segments = rows.map((row) => ({
    start: seconds(row.offsets?.from, row.timestamps?.from),
    end: seconds(row.offsets?.to, row.timestamps?.to),
    text: String(row.text || '').trim(),
  })).filter((row) => row.text);
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
  const args = buildWhisperCppArgs({
    modelPath,
    wavPath,
    outBase,
    language,
    threads: resolveThreadCount(options),
    prompt: options.prompt,
    beamSize: resolveBeamSize(options),
  });

  await runProcess(bin, args, scopedOptions);
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
    throw err;
  }
  const forced = whisperLanguageArg(language);
  return {
    text,
    segments: json.segments,
    language: (forced !== 'auto' ? forced : null) || json.language || null,
    model: path.basename(modelPath),
    engine: 'whisper.cpp',
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
        return await transcribeWithPython(wavPath, options.language, options);
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
  describeLocalWhisperAvailability,
  logAvailabilityOnce,
  resetAvailabilityLog,
  defaultThreadCount,
  whisperTimeoutForWav,
  transcribeLocal,
  convertToWav,
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
