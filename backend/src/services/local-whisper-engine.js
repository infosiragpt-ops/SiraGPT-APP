'use strict';

/**
 * Local Whisper engine — ffmpeg + whisper.cpp, with optional Python
 * faster-whisper fallback. No paid API. No OpenRouter.
 *
 * Config:
 *   FFMPEG_PATH / WHISPER_CPP_BIN / WHISPER_CPP_MODEL
 *   LOCAL_WHISPER_MODEL (faster-whisper / openai-whisper name, default base)
 *   LOCAL_WHISPER_TIMEOUT_MS (default 180000)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');
const { buildUntrustedChildEnv } = require('../utils/untrusted-child-env');

const DEFAULT_TIMEOUT_MS = 180_000;
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

/** Default worker threads: up to 8, never more than the host exposes. */
function defaultThreadCount() {
  let cores = 1;
  try { cores = Math.max(1, (os.cpus() || []).length || 1); } catch (_) { cores = 1; }
  return Math.max(1, Math.min(8, cores));
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

function buildWhisperCppArgs({ modelPath, wavPath, outBase, language, threads }) {
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-otxt',
    '-oj',
    '-of', outBase,
    '-nt',
    '--no-prints',
    '-ng',
    '-t', String(threads ?? 1),
  ];
  if (language) args.push('-l', language);
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
  if (!raw) return { text: '', segments: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: '', segments: [] };
  }
  const rows = Array.isArray(parsed.transcription) ? parsed.transcription : [];
  const segments = rows.map((row) => ({
    start: 0,
    end: 0,
    text: String(row.text || '').trim(),
  })).filter((row) => row.text);
  const text = String(parsed.text || segments.map((s) => s.text).join(' ')).trim();
  return { text, segments, language: parsed.result?.language || parsed.language || null };
}

async function readIfExists(filePath) {
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function transcribeWithWhisperCpp(wavPath, language, options = {}) {
  const wavStat = await fsPromises.stat(wavPath).catch(() => null);
  const scopedOptions = { ...options, timeoutMs: whisperTimeoutForWav(wavStat ? wavStat.size : 0, options) };
  const bin = options.whisperBin || firstExistingFile(candidateBins(options)) || candidateBins(options)[0];
  const modelPath = firstExistingFile(candidateModels(options));
  if (!bin) {
    const err = new Error('whisper.cpp binary not found');
    err.code = 'LOCAL_WHISPER_UNAVAILABLE';
    throw err;
  }
  if (!modelPath) {
    const err = new Error('whisper.cpp model not found');
    err.code = 'LOCAL_WHISPER_UNAVAILABLE';
    throw err;
  }

  const outBase = path.join(path.dirname(wavPath), 'transcript');
  const args = buildWhisperCppArgs({
    modelPath,
    wavPath,
    outBase,
    language,
    threads: resolveThreadCount(options),
  });

  const spawned = await runProcess(bin, args, scopedOptions);
  const txt = (await readIfExists(`${outBase}.txt`)).trim();
  const json = parseWhisperCppJson(await readIfExists(`${outBase}.json`));
  const text = txt || json.text || String(spawned.stdout || '').trim();
  if (!text) {
    const err = new Error('whisper.cpp returned empty transcript');
    err.code = 'LOCAL_WHISPER_EMPTY';
    throw err;
  }
  return {
    text,
    segments: json.segments,
    language: language || json.language || null,
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
  if (language) args.push('--language', language);
  await runProcess(pythonPath(options), args, options);
  const raw = await readIfExists(outPath);
  if (!raw) {
    const err = new Error('python whisper returned no output');
    err.code = 'LOCAL_WHISPER_EMPTY';
    throw err;
  }
  const parsed = JSON.parse(raw);
  const text = String(parsed.text || '').trim();
  if (!text) {
    const err = new Error('python whisper returned empty transcript');
    err.code = 'LOCAL_WHISPER_EMPTY';
    throw err;
  }
  return {
    text,
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    language: parsed.language || language || null,
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
    await convertToWav(filePath, wavPath, options);
    try {
      return await transcribeWithWhisperCpp(wavPath, options.language, options);
    } catch (cppErr) {
      if (cppErr?.code === 'LOCAL_WHISPER_ABORTED') throw cppErr;
      try {
        return await transcribeWithPython(wavPath, options.language, options);
      } catch (pyErr) {
        if (pyErr?.code === 'LOCAL_WHISPER_ABORTED') throw pyErr;
        const err = new Error('local whisper unavailable');
        err.code = 'LOCAL_WHISPER_UNAVAILABLE';
        err.cause = pyErr || cppErr;
        throw err;
      }
    }
  } finally {
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  defaultThreadCount,
  whisperTimeoutForWav,
  transcribeLocal,
  convertToWav,
  transcribeWithWhisperCpp,
  transcribeWithPython,
  candidateBins,
  candidateModels,
  resolveThreadCount,
  buildWhisperCppArgs,
};
