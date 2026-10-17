'use strict';

/**
 * ocr-input — turn whatever image the user sent into upright PNG/JPEG pages
 * every OCR rung can read, and probe the local OCR toolchain once.
 *
 * Why
 * ---
 * The prebuilt sharp in the Alpine image decodes HEIF only for AVIF, has no
 * BMP/JP2/ICO loader and reads page 1 of a multi-page TIFF. iPhone HEIC
 * photos, scanner BMPs and fax TIFFs therefore failed every Tesseract variant
 * and reached the vision APIs as `data:image/heic|bmp|tiff`, which they
 * reject. Pages scanned sideways had no orientation detection at all.
 *
 * `normalizeImageInput(input, opts)` →
 *   { ok, pages:[{ page, buffer, mime, width, height, rotation, source,
 *                  format, exifOrientation, osd, preRotation?,
 *                  orientationHint? }],
 *     unreadablePages:[{ page, error }],
 *     format, totalPages, truncatedPages, warnings, error? }
 *
 * - Sniffs the real format from magic bytes (mime/name are only hints).
 * - EXIF orientation applied once (sharp `.rotate()`); `rotation` is the
 *   clockwise rotation applied in total (EXIF + OSD).
 * - HEIC/HEIF through `heif-dec` (libheif-tools; `heif-convert` on older
 *   libheif), ffmpeg as second decoder. BMP/ICO/JP2/JXL through ffmpeg.
 *   The pixel cap holds BEFORE any external decode (decompression bombs):
 *   HEIF sizes come from the file's `ispe` boxes (unknown → heif-dec is
 *   skipped), ffmpeg gets an ffprobe size check plus `-max_pixels`; over the
 *   cap the result is `image_too_large`, never a multi-GB frame.
 * - Every TIFF page, capped (`SIRAGPT_OCR_TIFF_MAX_PAGES`) with the overflow
 *   reported in `truncatedPages` instead of silently dropped; a page that
 *   cannot be decoded is listed in `unreadablePages` under its own number.
 * - 90/180/270° orientation through the native `tesseract --psm 0` OSD when
 *   the CLI and `osd.traineddata` exist; a confident verdict
 *   (`SIRAGPT_OCR_OSD_MIN_CONFIDENCE`, 14) rotates the page and keeps the
 *   pre-rotation copy so the engine can fall back to it; a weaker one only
 *   becomes `orientationHint`, an alternate the engine may try.
 * - Pages are bounded by area (`SIRAGPT_OCR_INPUT_MAX_AREA`, 50 MP), never
 *   by the long side alone, so long scroll captures keep their resolution.
 * - A clean JPEG/PNG in the right orientation passes through byte-identical
 *   (today's behaviour for the common case), trailers after the JPEG EOI
 *   (Samsung SEFT, Motion Photo MP4) included.
 *
 * Production rules: every external call is feature-detected (memoised),
 * bounded in time (SIGKILL), cancellable through `signal`, and its temp files
 * are removed. Missing tools degrade to today's behaviour with ONE warning
 * line per process. Never throws: failures are `{ ok:false, error }` and the
 * caller keeps the raw input. Logs never contain image or text content.
 *
 * The module also hosts the pixel primitives the OCR variants need (Sauvola
 * binarisation, CLAHE, Laplacian-variance blur metric) — written as
 * cooperative loops that yield to the event loop, because the media and OCR
 * work run inside the web process — and the local tessdata resolution that
 * keeps tesseract.js off the CDN.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FALSY = new Set(['0', 'false', 'off', 'no']);

function lower(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function envInt(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(env[name] || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

function envNumber(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

// Encoders' own ceiling on a side (JPEG stores 16-bit dimensions).
const HARD_MAX_SIDE = 65_000;

function inputConfig(env = process.env) {
  const maxPixels = envInt(env, 'SIRAGPT_OCR_INPUT_MAX_PIXELS', 150_000_000, { min: 1_000_000 });
  const osdMinConfidence = envNumber(env, 'SIRAGPT_OCR_OSD_MIN_CONFIDENCE', 14, { min: 0, max: 100 });
  return {
    maxInputBytes: envInt(env, 'SIRAGPT_OCR_INPUT_MAX_BYTES', 150 * 1024 * 1024, { min: 1024 * 1024 }),
    maxPixels,
    // Pages are bounded by AREA, not by the long side: a 1080×14000 scroll
    // capture (15 MP) keeps its native resolution so the tiled pass can
    // read its small glyphs. Past the area cap the page is scaled by
    // sqrt(cap/area), never below `minShortSide` on its short side.
    maxArea: Math.min(maxPixels, envInt(env, 'SIRAGPT_OCR_INPUT_MAX_AREA', 50_000_000, { min: 4_000_000 })),
    minShortSide: envInt(env, 'SIRAGPT_OCR_INPUT_MIN_SHORT_SIDE', 1200, { min: 200, max: 10_000 }),
    // Optional explicit cap on the long side (unset or 0 = only the encoder
    // ceiling).
    maxSide: Number(env.SIRAGPT_OCR_INPUT_MAX_SIDE) > 0
      ? envInt(env, 'SIRAGPT_OCR_INPUT_MAX_SIDE', 0, { min: 1000, max: HARD_MAX_SIDE })
      : 0,
    maxPages: envInt(env, 'SIRAGPT_OCR_TIFF_MAX_PAGES', 30, { min: 1, max: 500 }),
    maxOutputBytes: envInt(env, 'SIRAGPT_OCR_INPUT_MAX_OUTPUT_BYTES', 200 * 1024 * 1024, { min: 8 * 1024 * 1024 }),
    decodeTimeoutMs: envInt(env, 'SIRAGPT_OCR_DECODE_TIMEOUT_MS', 30_000, { min: 1000, max: 300_000 }),
    probeTimeoutMs: 5000,
    osdEnabled: !FALSY.has(lower(env.SIRAGPT_OCR_OSD)),
    osdTimeoutMs: envInt(env, 'SIRAGPT_OCR_OSD_TIMEOUT_MS', 8000, { min: 500, max: 60_000 }),
    osdBudgetMs: envInt(env, 'SIRAGPT_OCR_OSD_BUDGET_MS', 60_000, { min: 1000, max: 600_000 }),
    // Tesseract calls ~15 "reasonably confident" (OCRmyPDF rotates at 14).
    // At or above it the page is rotated (the pre-rotation copy stays as the
    // alternate); between the hint level and it, the page stays upright and
    // the OSD rotation is only an alternate hypothesis the engine may try.
    osdMinConfidence,
    osdHintConfidence: Math.min(osdMinConfidence, envNumber(env, 'SIRAGPT_OCR_OSD_HINT_CONFIDENCE', 2, { min: 0, max: 100 })),
    osdMaxSide: 1600,
    blurThreshold: envNumber(env, 'SIRAGPT_OCR_BLUR_THRESHOLD', 100, { min: 0, max: 1_000_000 }),
    tmpDir: env.SIRAGPT_OCR_TMP_DIR || os.tmpdir(),
    heifDecBin: env.SIRAGPT_HEIF_DEC_BIN || '',
    ffmpegBin: env.FFMPEG_PATH || 'ffmpeg',
    // ffprobe next to an absolute ffmpeg, like audio-transcriber.
    ffprobeBin: env.FFPROBE_PATH
      || (env.FFMPEG_PATH && path.isAbsolute(env.FFMPEG_PATH) ? path.join(path.dirname(env.FFMPEG_PATH), 'ffprobe') : 'ffprobe'),
    tesseractBin: env.SIRAGPT_TESSERACT_BIN || 'tesseract',
    tessdataDir: env.SIRAGPT_TESSDATA_DIR || '',
    tessdataCacheDir: env.SIRAGPT_TESSDATA_CACHE_DIR || path.join(os.tmpdir(), 'siragpt-tessdata-cache'),
    localTessdata: !FALSY.has(lower(env.SIRAGPT_OCR_LOCAL_TESSDATA)),
  };
}

// ── One-line-per-process warnings ─────────────────────────────────────────

const warned = new Set();
function warnOnce(key, message, logger = console) {
  if (warned.has(key)) return;
  warned.add(key);
  try { logger.warn(`[ocr-input] ${message}`); } catch { /* logging must never break OCR */ }
}

// ── Bounded child processes ───────────────────────────────────────────────

/**
 * Run a binary without a shell. Resolves { code, signal, stdout, stderr,
 * timedOut, aborted, error } — never rejects. SIGKILL on timeout or abort;
 * output beyond `maxBuffer` is dropped (the process keeps running to its
 * own end or the timeout). `input` is written to stdin when given.
 */
function runCommand(bin, args = [], {
  timeoutMs = 10_000,
  signal,
  input,
  maxBuffer = 1024 * 1024,
  env,
  encoding = 'utf8',
} = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true, error: 'aborted' });
      return;
    }
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env || process.env,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: err && err.code ? err.code : 'spawn_failed' });
      return;
    }
    const out = [];
    const errOut = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;

    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, timeoutMs));
    const onAbort = () => { aborted = true; kill(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const stdoutBuf = Buffer.concat(out);
      const stderrBuf = Buffer.concat(errOut);
      resolve({
        code,
        signal: sig || null,
        stdout: encoding === 'buffer' ? stdoutBuf : stdoutBuf.toString('utf8'),
        stderr: stderrBuf.toString('utf8'),
        timedOut,
        aborted,
        error: spawnError || (timedOut ? 'timeout' : aborted ? 'aborted' : null),
      });
    };

    child.stdout.on('data', (chunk) => {
      if (outBytes + chunk.length <= maxBuffer) { out.push(chunk); outBytes += chunk.length; }
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes + chunk.length <= 64 * 1024) { errOut.push(chunk); errBytes += chunk.length; }
    });
    child.on('error', (err) => {
      spawnError = (err && err.code) || 'spawn_failed';
      finish(null, null);
    });
    child.on('close', (code, sig) => finish(code, sig));
    child.stdin.on('error', () => { /* EPIPE when the binary exits early */ });
    if (input !== undefined && input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function isMissingBinary(result) {
  return result && (result.error === 'ENOENT' || result.error === 'EACCES' || result.error === 'spawn_failed');
}

// ── Capability probes (memoised per process) ──────────────────────────────

const probeCache = new Map();

function memo(key, fn) {
  if (!probeCache.has(key)) {
    probeCache.set(key, Promise.resolve().then(fn).catch(() => ({ available: false, reason: 'probe_failed' })));
  }
  return probeCache.get(key);
}

function resetProbeCache() {
  probeCache.clear();
  tessdataMemo = null;
  cacheDirMemo = undefined;
  warned.clear();
}

/** heif-dec (libheif ≥1.17) or heif-convert (older libheif-tools). */
function probeHeifDecoder({ exec = runCommand, env = process.env } = {}) {
  const cfg = inputConfig(env);
  const candidates = cfg.heifDecBin ? [cfg.heifDecBin] : ['heif-dec', 'heif-convert'];
  return memo(`heif:${candidates.join(',')}`, async () => {
    for (const bin of candidates) {
      const res = await exec(bin, ['--version'], { timeoutMs: cfg.probeTimeoutMs, maxBuffer: 64 * 1024 });
      if (isMissingBinary(res) || res.timedOut) continue;
      const output = `${res.stdout || ''}\n${res.stderr || ''}`;
      if (res.code === 0 || /heif/i.test(output)) {
        const version = (output.match(/(\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
        return { available: true, bin, version };
      }
    }
    return { available: false, reason: 'heif_decoder_missing' };
  });
}

function probeFfmpeg({ exec = runCommand, env = process.env } = {}) {
  const cfg = inputConfig(env);
  return memo(`ffmpeg:${cfg.ffmpegBin}`, async () => {
    const res = await exec(cfg.ffmpegBin, ['-hide_banner', '-version'], { timeoutMs: cfg.probeTimeoutMs, maxBuffer: 256 * 1024 });
    if (res.code === 0) {
      const version = (String(res.stdout).match(/ffmpeg version (\S+)/) || [])[1] || null;
      return { available: true, bin: cfg.ffmpegBin, version };
    }
    return { available: false, reason: isMissingBinary(res) ? 'ffmpeg_missing' : 'ffmpeg_unusable' };
  });
}

function probeTesseractCli({ exec = runCommand, env = process.env } = {}) {
  const cfg = inputConfig(env);
  return memo(`tesseract:${cfg.tesseractBin}`, async () => {
    const res = await exec(cfg.tesseractBin, ['--version'], { timeoutMs: cfg.probeTimeoutMs, maxBuffer: 256 * 1024 });
    const output = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!isMissingBinary(res) && !res.timedOut && (res.code === 0 || /tesseract\s+\d/i.test(output))) {
      const version = (output.match(/tesseract\s+v?(\d+\.\d+(?:\.\d+)?)/i) || [])[1] || null;
      return { available: true, bin: cfg.tesseractBin, version };
    }
    return { available: false, reason: 'tesseract_cli_missing' };
  });
}

const TESSDATA_DIR_CANDIDATES = [
  '/usr/share/tessdata',
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/local/share/tessdata',
];

let tessdataMemo = null;

/**
 * First directory holding `*.traineddata` files. Synchronous (one readdir
 * per candidate, once per process). Returns { dir, languages:[...] } or
 * { dir:null, languages:[] }.
 */
function probeTessdata({ env = process.env, fsImpl = fs, refresh = false } = {}) {
  if (tessdataMemo && !refresh) return tessdataMemo;
  const cfg = inputConfig(env);
  const dirs = [];
  if (cfg.tessdataDir) dirs.push(cfg.tessdataDir);
  if (env.TESSDATA_PREFIX) {
    dirs.push(env.TESSDATA_PREFIX, path.join(env.TESSDATA_PREFIX, 'tessdata'));
  }
  dirs.push(...TESSDATA_DIR_CANDIDATES);
  let found = { dir: null, languages: [] };
  for (const dir of dirs) {
    try {
      const languages = fsImpl.readdirSync(dir)
        .filter((name) => name.endsWith('.traineddata'))
        .map((name) => name.slice(0, -'.traineddata'.length))
        .sort();
      if (languages.length > 0) { found = { dir, languages }; break; }
    } catch { /* not there */ }
  }
  tessdataMemo = found;
  return found;
}

function splitLanguages(language) {
  return String(language || '')
    .split('+')
    .map((lang) => lang.trim())
    .filter((lang) => /^[A-Za-z0-9_-]+$/.test(lang));
}

/**
 * Local tessdata for a tesseract.js language string («spa+eng»): the dir
 * when EVERY requested language has a readable `<lang>.traineddata` there,
 * otherwise null (the caller keeps today's CDN download).
 */
function resolveLocalTessdata(language, { env = process.env, fsImpl = fs } = {}) {
  const cfg = inputConfig(env);
  if (!cfg.localTessdata) return null;
  const langs = splitLanguages(language);
  if (langs.length === 0) return null;
  const { dir, languages } = probeTessdata({ env, fsImpl });
  if (!dir) return null;
  for (const lang of langs) {
    if (!languages.includes(lang)) return null;
    try { fsImpl.accessSync(path.join(dir, `${lang}.traineddata`), fs.constants.R_OK); } catch { return null; }
  }
  return { dir, languages: langs };
}

let cacheDirMemo;

/**
 * A writable directory for tesseract.js' download cache. The process cwd
 * (/app) is root-owned in the runner image, so without this every worker
 * re-downloaded the language data. Returns the path, or null when nothing
 * writable exists (today's behaviour).
 */
function tessdataCacheDir({ env = process.env, fsImpl = fs } = {}) {
  if (cacheDirMemo !== undefined) return cacheDirMemo;
  const cfg = inputConfig(env);
  try {
    fsImpl.mkdirSync(cfg.tessdataCacheDir, { recursive: true });
    fsImpl.accessSync(cfg.tessdataCacheDir, fs.constants.W_OK | fs.constants.R_OK);
    cacheDirMemo = cfg.tessdataCacheDir;
  } catch {
    cacheDirMemo = null;
  }
  return cacheDirMemo;
}

/** OSD needs the native CLI AND osd.traineddata. */
async function probeOsd({ exec = runCommand, env = process.env, fsImpl = fs } = {}) {
  const cfg = inputConfig(env);
  if (!cfg.osdEnabled) return { available: false, reason: 'osd_disabled' };
  const { dir, languages } = probeTessdata({ env, fsImpl });
  if (!dir || !languages.includes('osd')) return { available: false, reason: 'osd_data_missing' };
  const cli = await probeTesseractCli({ exec, env });
  if (!cli.available) return { available: false, reason: cli.reason };
  return { available: true, bin: cli.bin, tessdataDir: dir };
}

/** Capability summary (for logs and the admin report). No secrets. */
async function getOcrInputCapabilities({ exec = runCommand, env = process.env, fsImpl = fs } = {}) {
  const [heif, ffmpeg, tesseractCli, osd] = await Promise.all([
    probeHeifDecoder({ exec, env }),
    probeFfmpeg({ exec, env }),
    probeTesseractCli({ exec, env }),
    probeOsd({ exec, env, fsImpl }),
  ]);
  const tessdata = probeTessdata({ env, fsImpl });
  return {
    heif: { available: !!heif.available, bin: heif.bin || null, version: heif.version || null },
    ffmpeg: { available: !!ffmpeg.available, version: ffmpeg.version || null },
    tesseractCli: { available: !!tesseractCli.available, version: tesseractCli.version || null },
    tessdata: { dir: tessdata.dir, languages: tessdata.languages },
    osd: { available: !!osd.available, reason: osd.available ? null : osd.reason },
    tessdataCacheDir: tessdataCacheDir({ env, fsImpl }),
  };
}

// ── Format sniffing ───────────────────────────────────────────────────────

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1', 'miaf']);

const EXTENSION_FORMATS = {
  jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', png: 'png', gif: 'gif', webp: 'webp',
  tif: 'tiff', tiff: 'tiff', bmp: 'bmp', dib: 'bmp', heic: 'heic', heif: 'heic', hif: 'heic',
  avif: 'avif', svg: 'svg', jp2: 'jp2', j2k: 'jp2', jpx: 'jp2', jxl: 'jxl', ico: 'ico',
};

const MIME_FORMATS = {
  'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/pjpeg': 'jpeg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/tiff': 'tiff', 'image/tif': 'tiff',
  'image/bmp': 'bmp', 'image/x-bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/heic': 'heic',
  'image/heif': 'heic', 'image/heic-sequence': 'heic', 'image/heif-sequence': 'heic',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/jp2': 'jp2', 'image/jpx': 'jp2',
  'image/jxl': 'jxl', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};

function ascii(buf, start, end) {
  return buf.slice(start, Math.min(end, buf.length)).toString('latin1');
}

/**
 * Real image format from magic bytes; `mime`/`name` only break ties for
 * formats without a signature. Returns one of: jpeg png gif webp tiff bmp
 * heic avif svg jp2 jxl ico pdf unknown.
 */
function sniffImageFormat(head, { mime, name } = {}) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(ascii(buf, 0, 6))) return 'gif';
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 4) {
    const sig = ascii(buf, 0, 4);
    if (sig === 'II*\u0000' || sig === 'MM\u0000*' || sig === 'II+\u0000' || sig === 'MM\u0000+') return 'tiff';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  if (buf.length >= 12 && buf.readUInt32BE(0) === 0x0000000c && ascii(buf, 4, 8) === 'jP  ') return 'jp2';
  if (buf.length >= 12 && buf.readUInt32BE(0) === 0x0000000c && ascii(buf, 4, 8) === 'JXL ') return 'jxl';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x0a) return 'jxl';
  if (buf.length >= 4 && ascii(buf, 0, 4) === '%PDF') return 'pdf';
  if (buf.length >= 12 && ascii(buf, 4, 8) === 'ftyp') {
    const boxSize = Math.min(buf.readUInt32BE(0) || buf.length, buf.length);
    const brands = [ascii(buf, 8, 12)];
    for (let off = 16; off + 4 <= boxSize; off += 4) brands.push(ascii(buf, off, off + 4));
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
    if (brands.some((b) => GENERIC_HEIF_BRANDS.has(b))) return 'heic';
  }
  const text = ascii(buf, 0, 1024).replace(/^﻿/, '').trimStart();
  if (/^<\?xml[\s\S]*<svg[\s>]/i.test(text) || /^<svg[\s>]/i.test(text)) return 'svg';
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (ext && EXTENSION_FORMATS[ext[1]]) return EXTENSION_FORMATS[ext[1]];
  const fromMime = MIME_FORMATS[String(mime || '').toLowerCase().split(';')[0].trim()];
  return fromMime || 'unknown';
}

const SHARP_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp', 'tiff', 'avif', 'svg']);
const FFMPEG_FORMATS = new Set(['bmp', 'ico', 'jp2', 'jxl']);
const PASS_THROUGH_FORMATS = new Set(['jpeg', 'png']);
const LOSSLESS_FORMATS = new Set(['png', 'gif', 'bmp', 'ico', 'svg']);

function mimeForFormat(format) {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

/**
 * Walk a JPEG's marker structure: segments by their length, entropy-coded
 * data up to the next real marker, until EOI. Returns 'complete' (EOI after
 * a scan), 'truncated' (the bytes end before EOI) or 'unknown' (not a
 * well-formed marker stream). Data AFTER the EOI is ignored on purpose:
 * Samsung photos carry a SEFT trailer and Google Motion Photos append an
 * MP4 — both are complete images. Linear, native `indexOf` over the scan.
 */
function jpegCompleteness(buf) {
  const n = buf.length;
  if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 'unknown';
  let pos = 2;
  let sawScan = false;
  for (let guard = 0; guard < 200_000; guard += 1) {
    if (pos >= n) return 'truncated';
    if (buf[pos] !== 0xff) return 'unknown';
    let m = pos + 1;
    while (m < n && buf[m] === 0xff) m += 1; // fill bytes
    if (m >= n) return 'truncated';
    const marker = buf[m];
    pos = m + 1;
    if (marker === 0xd9) return sawScan ? 'complete' : 'unknown'; // EOI
    // Standalone markers: SOI, TEM, RSTn.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > n) return 'truncated';
    const length = buf.readUInt16BE(pos);
    if (length < 2) return 'unknown';
    if (pos + length > n) return 'truncated';
    pos += length;
    if (marker !== 0xda) continue;
    // SOS: entropy-coded data until a marker that is neither a stuffed
    // 0xFF00 nor a restart marker (progressive files repeat SOS).
    sawScan = true;
    for (;;) {
      const ff = buf.indexOf(0xff, pos);
      if (ff < 0 || ff + 1 >= n) return 'truncated';
      const next = buf[ff + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { pos = ff + 2; continue; }
      if (next === 0xff) { pos = ff + 1; continue; }
      pos = ff;
      break;
    }
  }
  return 'unknown';
}

/** PNG chunk walk: 'complete' at IEND, 'truncated' when a chunk runs past the end. */
function pngCompleteness(buf) {
  const n = buf.length;
  if (n < 8 || buf.readUInt32BE(0) !== 0x89504e47) return 'unknown';
  let pos = 8;
  for (let guard = 0; guard < 1_000_000; guard += 1) {
    if (pos + 8 > n) return 'truncated';
    const length = buf.readUInt32BE(pos);
    if (length > 0x7fffffff) return 'unknown';
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > n) return 'truncated';
    if (type === 'IEND') return 'complete';
    pos = end;
  }
  return 'unknown';
}

// A truncated upload is decoded with failOn:'none' and re-encoded so
// downstream sharp calls see a clean image. Real truncation comes from the
// structure walk; only a stream the walk cannot follow falls back to the
// old tail check (JPEG ends in EOI, PNG in IEND).
function looksTruncated(format, buffer) {
  if (!buffer || buffer.length < 16) return false;
  if (format === 'jpeg') {
    const verdict = jpegCompleteness(buffer);
    if (verdict !== 'unknown') return verdict === 'truncated';
    return !buffer.slice(-16).includes(Buffer.from([0xff, 0xd9]));
  }
  if (format === 'png') {
    const verdict = pngCompleteness(buffer);
    if (verdict !== 'unknown') return verdict === 'truncated';
    return !buffer.slice(-16).includes(Buffer.from('IEND', 'latin1'));
  }
  return false;
}

/**
 * Scale (≤ 1) that keeps a page inside the area cap without taking its
 * short side under `minShortSide`, and inside the long-side ceiling
 * (`maxSide` when set, the encoder ceiling otherwise). 1 = untouched.
 */
function fitScale(width, height, bounds = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return 1;
  let scale = 1;
  const maxArea = Number(bounds.maxArea) > 0 ? Number(bounds.maxArea) : Infinity;
  if (w * h > maxArea) {
    scale = Math.sqrt(maxArea / (w * h));
    const floor = Math.min(1, (Number(bounds.minShortSide) || 0) / Math.min(w, h));
    if (scale < floor) scale = floor;
  }
  const sideCap = Number(bounds.maxSide) > 0 ? Math.min(Number(bounds.maxSide), HARD_MAX_SIDE) : HARD_MAX_SIDE;
  const longest = Math.max(w, h);
  if (longest * scale > sideCap) scale = sideCap / longest;
  return Math.min(1, scale);
}

const EXIF_ROTATION = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('aborted');
    err.code = 'ABORT_ERR';
    throw err;
  }
}

async function withTempDir(tmpRoot, fn) {
  const dir = await fsp.mkdtemp(path.join(tmpRoot || os.tmpdir(), 'sira-ocr-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readHead(filePath, bytes = 4096) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Encode one decoded page. Lossless sources, greyscale scans and small
 * images become PNG; large photos JPEG q92 (4:4:4 keeps glyph edges) with
 * alpha flattened onto white so transparent text does not turn black.
 * `bounds` ({ maxArea, minShortSide, maxSide }) decides the size (fitScale).
 */
async function encodePage(sharpImpl, input, {
  page = 0,
  format,
  bounds = {},
  maxPixels,
  density,
  failOn = 'warning',
}) {
  const options = { limitInputPixels: maxPixels, failOn };
  if (format === 'tiff') options.page = page;
  if (density) options.density = density;
  const meta = await sharpImpl(input, options).metadata();
  let pipeline = sharpImpl(input, options).rotate();
  const exifRotation = EXIF_ROTATION[meta.orientation] || 0;
  let w = meta.width || 0;
  let h = meta.height || 0;
  if (exifRotation === 90 || exifRotation === 270) [w, h] = [h, w];
  const scale = fitScale(w, h, bounds);
  if (scale < 1) {
    const tw = Math.max(1, Math.floor(w * scale));
    const th = Math.max(1, Math.floor(h * scale));
    pipeline = pipeline.resize(tw, th, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
    w = tw;
    h = th;
  }
  const grey = (meta.channels || 3) <= 2;
  const usePng = LOSSLESS_FORMATS.has(format) || grey || (w * h) <= 1_500_000;
  let buffer;
  if (usePng) {
    buffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  } else {
    buffer = await pipeline
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }
  const outMeta = await sharpImpl(buffer).metadata().catch(() => null);
  return {
    buffer,
    mime: usePng ? 'image/png' : 'image/jpeg',
    width: (outMeta && outMeta.width) || w,
    height: (outMeta && outMeta.height) || h,
    exifOrientation: meta.orientation || null,
    exifRotation,
    pages: meta.pages || 1,
  };
}

// ── OSD (orientation) ─────────────────────────────────────────────────────

function parseOsd(stdout) {
  const text = String(stdout || '');
  const rotate = text.match(/Rotate:\s*(\d+)/i);
  const confidence = text.match(/Orientation confidence:\s*([\d.]+)/i);
  if (!rotate) return null;
  const value = Number(rotate[1]) % 360;
  if (![0, 90, 180, 270].includes(value)) return null;
  return {
    rotate: value,
    confidence: confidence ? Number(confidence[1]) : 0,
    script: (text.match(/Script:\s*([^\n]+)/i) || [])[1]?.trim() || null,
  };
}

/**
 * Orientation of a page through `tesseract stdin stdout --psm 0 -l osd`.
 * `rotate` is the CLOCKWISE rotation that makes the page upright.
 * Returns { ok, rotate, confidence, script } or { ok:false, reason }.
 */
async function detectOrientation(buffer, {
  exec = runCommand,
  env = process.env,
  signal,
  sharpImpl,
  fsImpl = fs,
} = {}) {
  const cfg = inputConfig(env);
  try {
    const osd = await probeOsd({ exec, env, fsImpl });
    if (!osd.available) return { ok: false, reason: osd.reason };
    const sharp = sharpImpl || require('sharp');
    const meta = await sharp(buffer).metadata();
    if (Math.min(meta.width || 0, meta.height || 0) < 150 || Math.max(meta.width || 0, meta.height || 0) < 300) {
      return { ok: false, reason: 'osd_image_too_small' };
    }
    throwIfAborted(signal);
    const probeImage = await sharp(buffer)
      .resize(cfg.osdMaxSide, cfg.osdMaxSide, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .png()
      .toBuffer();
    const args = ['--tessdata-dir', osd.tessdataDir, 'stdin', 'stdout', '--psm', '0', '-l', 'osd'];
    const res = await exec(osd.bin, args, {
      input: probeImage,
      timeoutMs: cfg.osdTimeoutMs,
      signal,
      maxBuffer: 64 * 1024,
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    });
    if (res.aborted) return { ok: false, reason: 'aborted' };
    if (res.timedOut) return { ok: false, reason: 'osd_timeout' };
    const parsed = parseOsd(res.stdout) || parseOsd(res.stderr);
    if (!parsed) {
      const tooFew = /too few characters/i.test(`${res.stderr || ''}${res.stdout || ''}`);
      return { ok: false, reason: tooFew ? 'osd_too_few_characters' : 'osd_unparsed' };
    }
    return { ok: true, ...parsed };
  } catch (err) {
    if (err && err.code === 'ABORT_ERR') return { ok: false, reason: 'aborted' };
    return { ok: false, reason: 'osd_failed' };
  }
}

// ── External decoders ─────────────────────────────────────────────────────

const NUMBERED_OUTPUT_RE = /^out(?:-(\d+))?\.png$/;

async function collectDecodedPngs(dir) {
  const names = (await fsp.readdir(dir)).filter((name) => NUMBERED_OUTPUT_RE.test(name));
  names.sort((a, b) => Number((a.match(NUMBERED_OUTPUT_RE) || [])[1] || 0) - Number((b.match(NUMBERED_OUTPUT_RE) || [])[1] || 0));
  return names.map((name) => path.join(dir, name));
}

// ffmpeg/ffprobe refuse a frame over `-max_pixels` with this line.
const MAX_PIXELS_EXCEEDED_RE = /exceeds specified max pixel count/i;

/** `-max_pixels` is a C int in ffmpeg. */
function maxPixelsArg(cfg) {
  return String(Math.min(cfg.maxPixels, 2_147_483_647));
}

// HEIF `meta` boxes are small (item info, locations, properties): a larger
// one is not read, and its size counts as unknown.
const HEIF_META_MAX_BYTES = 4 * 1024 * 1024;
const HEIF_MAX_TOP_LEVEL_BOXES = 64;

/** ISO-BMFF box header at `offset` of `buf` (within `end`), or null. */
function boxAt(buf, offset, end) {
  if (offset + 8 > end) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header || offset + size > end) return null;
  return { type, start: offset + header, end: offset + size };
}

function childBoxes(buf, start, end) {
  const out = [];
  for (let offset = start, n = 0; offset < end && n < 4096; n += 1) {
    const box = boxAt(buf, offset, end);
    if (!box) break;
    out.push(box);
    offset = box.end;
  }
  return out;
}

/**
 * Largest image size declared by a HEIF file's `ispe` properties (every
 * image item has one: primary, grid, tiles, thumbnails — heif-dec decodes
 * every top-level image, so the largest bounds the work). Reads only box
 * headers and the `meta` box. Returns { width, height, pixels } or null
 * when the sizes cannot be read. Never throws.
 */
async function readHeifImageSize(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const { size: fileSize } = await handle.stat();
    const read = async (position, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    };
    let offset = 0;
    for (let n = 0; n < HEIF_MAX_TOP_LEVEL_BOXES && offset + 8 <= fileSize; n += 1) {
      const head = await read(offset, 16);
      if (head.length < 8) return null;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) {
        if (head.length < 16) return null;
        size = Number(head.readBigUInt64BE(8));
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < 8 || offset + size > fileSize) return null;
      if (type === 'meta') {
        if (size > HEIF_META_MAX_BYTES) return null;
        const meta = await read(offset, size);
        const top = boxAt(meta, 0, meta.length);
        if (!top) return null;
        // `meta` is a FullBox: 4 bytes of version/flags before its children.
        const iprp = childBoxes(meta, top.start + 4, top.end).find((b) => b.type === 'iprp');
        const ipco = iprp && childBoxes(meta, iprp.start, iprp.end).find((b) => b.type === 'ipco');
        if (!ipco) return null;
        let best = null;
        for (const box of childBoxes(meta, ipco.start, ipco.end)) {
          if (box.type !== 'ispe' || box.end - box.start < 12) continue;
          const width = meta.readUInt32BE(box.start + 4);
          const height = meta.readUInt32BE(box.start + 8);
          const pixels = width * height;
          if (!best || pixels > best.pixels) best = { width, height, pixels };
        }
        return best;
      }
      offset += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Pixel size of the largest video stream ffprobe sees, checked against the
 * cap before ffmpeg decodes anything. ffprobe may decode a frame to learn
 * the size, so it runs under `-max_pixels` too. Returns { tooLarge } |
 * { pixels } | { pixels: null } (unknown: ffprobe missing or silent — the
 * decode still runs under `-max_pixels`) | { aborted }.
 */
async function ffprobeImageSize(srcPath, { exec, signal, cfg }) {
  const res = await exec(cfg.ffprobeBin, [
    '-v', 'error', '-max_pixels', maxPixelsArg(cfg),
    '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
    `file:${srcPath}`,
  ], { timeoutMs: cfg.decodeTimeoutMs, signal, maxBuffer: 64 * 1024 });
  if (res.aborted) return { aborted: true };
  if (MAX_PIXELS_EXCEEDED_RE.test(String(res.stderr || ''))) return { tooLarge: true };
  let pixels = null;
  for (const line of String(res.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s*,\s*(\d+)/.exec(line);
    if (m) pixels = Math.max(pixels || 0, Number(m[1]) * Number(m[2]));
  }
  if (pixels !== null && pixels > cfg.maxPixels) return { tooLarge: true };
  return { pixels };
}

async function decodeWithHeifDec(srcPath, dir, { exec, env, signal, cfg, heifSize }) {
  const probe = await probeHeifDecoder({ exec, env });
  if (!probe.available) return { ok: false, reason: 'heif_decoder_missing' };
  // heif-dec has no pixel limit of its own: without the declared sizes the
  // file goes to ffmpeg, which decodes under `-max_pixels`.
  if (!heifSize) return { ok: false, reason: 'heif_size_unknown' };
  if (heifSize.pixels > cfg.maxPixels) return { ok: false, reason: 'image_too_large' };
  const res = await exec(probe.bin, [srcPath, path.join(dir, 'out.png')], {
    timeoutMs: cfg.decodeTimeoutMs, signal, maxBuffer: 64 * 1024,
  });
  if (res.aborted) return { ok: false, reason: 'aborted' };
  if (res.timedOut) return { ok: false, reason: 'heif_decode_timeout' };
  const files = await collectDecodedPngs(dir);
  if (files.length === 0) return { ok: false, reason: 'heif_decode_failed' };
  return { ok: true, files, source: 'heif-dec' };
}

async function decodeWithFfmpeg(srcPath, dir, { exec, env, signal, cfg }) {
  const probe = await probeFfmpeg({ exec, env });
  if (!probe.available) return { ok: false, reason: 'ffmpeg_missing' };
  const size = await ffprobeImageSize(srcPath, { exec, signal, cfg });
  if (size.aborted) return { ok: false, reason: 'aborted' };
  if (size.tooLarge) return { ok: false, reason: 'image_too_large' };
  // `-max_pixels` is an INPUT option (before -i): the decoder refuses an
  // oversized frame before allocating it.
  const res = await exec(probe.bin, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2',
    '-max_pixels', maxPixelsArg(cfg),
    '-i', `file:${srcPath}`, '-frames:v', '1', '-an', '-sn', '-dn', '-update', '1',
    path.join(dir, 'out.png'),
  ], { timeoutMs: cfg.decodeTimeoutMs, signal, maxBuffer: 64 * 1024 });
  if (res.aborted) return { ok: false, reason: 'aborted' };
  if (res.timedOut) return { ok: false, reason: 'ffmpeg_decode_timeout' };
  const files = await collectDecodedPngs(dir);
  if (res.code !== 0 && MAX_PIXELS_EXCEEDED_RE.test(String(res.stderr || ''))) return { ok: false, reason: 'image_too_large' };
  if (res.code !== 0 || files.length === 0) return { ok: false, reason: 'ffmpeg_decode_failed' };
  return { ok: true, files, source: 'ffmpeg' };
}

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Normalise an image (path or Buffer) into upright PNG/JPEG pages.
 * Options: { mime, name, signal, osd (default true), maxPages, exec,
 *   sharpImpl, env, logger, fsImpl }.
 *
 * Pages keep their SOURCE number (`page`): a TIFF page that cannot be
 * decoded is listed in `unreadablePages: [{ page, error }]` instead of
 * shifting the numbers of the pages after it; `truncatedPages` only counts
 * pages past the page/output cap.
 */
async function normalizeImageInput(input, opts = {}) {
  const env = opts.env || process.env;
  const cfg = inputConfig(env);
  const exec = opts.exec || runCommand;
  const logger = opts.logger || console;
  const fsImpl = opts.fsImpl || fs;
  const signal = opts.signal;
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages) || cfg.maxPages, 500));
  const warnings = [];
  const pages = [];
  const unreadablePages = [];
  const state = { format: null, totalPages: 0, truncatedPages: 0, outputBytes: 0 };

  const fail = (error) => ({
    ok: false, error, pages: [], unreadablePages: [], warnings, format: state.format, totalPages: 0, truncatedPages: 0,
  });
  const done = () => ({
    ok: true,
    pages,
    unreadablePages,
    format: state.format,
    totalPages: state.totalPages,
    truncatedPages: state.truncatedPages,
    warnings,
  });

  let sharp;
  try {
    sharp = opts.sharpImpl || require('sharp');
  } catch {
    return fail('sharp_unavailable');
  }

  const pushPage = (encoded, source, pageNumber) => {
    state.outputBytes += encoded.buffer.length;
    pages.push({
      page: pageNumber,
      buffer: encoded.buffer,
      mime: encoded.mime,
      width: encoded.width,
      height: encoded.height,
      rotation: encoded.exifRotation || 0,
      exifOrientation: encoded.exifOrientation || null,
      format: state.format,
      source,
      osd: null,
    });
  };

  // OSD on every page. A CONFIDENT non-zero verdict (≥ osdMinConfidence)
  // rotates the page and keeps the pre-rotation copy for the engine's
  // fallback read. A weaker one (≥ osdHintConfidence) leaves the page
  // upright and is recorded as `orientationHint`: the engine only tries
  // that rotation as an alternate hypothesis when the upright read is weak.
  const applyOrientation = async () => {
    if (opts.osd === false) return;
    // One OSD budget for the whole call: a 30-page TIFF must not spend
    // minutes on orientation before OCR starts.
    const osdDeadline = Date.now() + cfg.osdBudgetMs;
    for (const page of pages) {
      throwIfAborted(signal);
      if (Date.now() >= osdDeadline) { warnings.push('osd_budget'); break; }
      const verdict = await detectOrientation(page.buffer, { exec, env, signal, sharpImpl: sharp, fsImpl });
      if (!verdict.ok) {
        if (verdict.reason === 'aborted') throwIfAborted({ aborted: true });
        if (verdict.reason === 'osd_data_missing' || verdict.reason === 'tesseract_cli_missing') {
          warnOnce('osd', `orientation detection off (${verdict.reason}); sideways pages are read as they come`, logger);
        }
        continue;
      }
      page.osd = { rotate: verdict.rotate, confidence: verdict.confidence };
      if (verdict.rotate === 0) continue;
      if (verdict.confidence < cfg.osdMinConfidence) {
        if (verdict.confidence >= cfg.osdHintConfidence) {
          page.orientationHint = { rotate: verdict.rotate, confidence: verdict.confidence };
        }
        continue;
      }
      const jpeg = page.mime === 'image/jpeg';
      const rotated = await sharp(page.buffer)
        .rotate(verdict.rotate, { background: '#ffffff' })
        .toFormat(jpeg ? 'jpeg' : 'png', jpeg ? { quality: 92, chromaSubsampling: '4:4:4' } : {})
        .toBuffer();
      page.preRotation = { buffer: page.buffer, mime: page.mime, width: page.width, height: page.height };
      page.buffer = rotated;
      if (verdict.rotate !== 180) [page.width, page.height] = [page.height, page.width];
      page.rotation = (page.rotation + verdict.rotate) % 360;
      if (page.source === 'original') page.source = 'sharp';
      warnings.push(`osd_rotated_${verdict.rotate}`);
    }
  };

  // Formats sharp cannot open: decode to PNG with an external tool in a
  // private temp dir (always removed), then encode like any other page.
  const decodeViaTools = async (bytes, inputPath, decoders) => withTempDir(cfg.tmpDir, async (dir) => {
    let srcPath = inputPath;
    if (bytes) {
      srcPath = path.join(dir, `input.${state.format === 'unknown' ? 'bin' : state.format}`);
      await fsp.writeFile(srcPath, bytes);
    }
    let decoded = null;
    const reasons = [];
    // HEIF declares its sizes (`ispe`): over the cap, nothing is decoded.
    const heifSize = state.format === 'heic' ? await readHeifImageSize(srcPath) : null;
    if (heifSize && heifSize.pixels > cfg.maxPixels) return 'image_too_large';
    for (const decoder of decoders) {
      throwIfAborted(signal);
      const outDir = await fsp.mkdtemp(path.join(dir, 'd-'));
      const res = await decoder(srcPath, outDir, { exec, env, signal, cfg, heifSize });
      if (res.ok) { decoded = res; break; }
      if (res.reason === 'aborted') throwIfAborted({ aborted: true });
      if (res.reason === 'image_too_large') return 'image_too_large';
      reasons.push(res.reason);
    }
    if (reasons.includes('heif_size_unknown')) warnings.push('heif_size_unknown');
    if (reasons.includes('heif_decoder_missing')) {
      warnings.push('heif_decoder_missing');
      warnOnce('heif', 'heif-dec/heif-convert not found; HEIC/HEIF photos are decoded with ffmpeg when it can (install libheif-tools)', logger);
    }
    if (reasons.includes('ffmpeg_missing')) {
      warnings.push('ffmpeg_missing');
      warnOnce('ffmpeg', 'ffmpeg not found; BMP/ICO/JPEG 2000 images cannot be converted for OCR', logger);
    }
    if (!decoded) return state.format === 'heic' ? 'heic_decode_failed' : 'decode_failed';
    if (decoded.source === 'ffmpeg' && state.format === 'heic') warnings.push('heic_decoded_by_ffmpeg');
    state.totalPages = decoded.files.length;
    const readable = Math.min(decoded.files.length, maxPages);
    let attempted = 0;
    for (let i = 0; i < readable; i += 1) {
      throwIfAborted(signal);
      if (state.outputBytes > cfg.maxOutputBytes) { warnings.push('output_cap'); break; }
      attempted = i + 1;
      try {
        const pngBytes = await fsp.readFile(decoded.files[i]);
        const encoded = await encodePage(sharp, pngBytes, {
          format: state.format, bounds: cfg, maxPixels: cfg.maxPixels,
        });
        pushPage(encoded, decoded.source, i + 1);
      } catch (err) {
        if (err && err.code === 'ABORT_ERR') throw err;
        if (/pixel limit/i.test(String(err && err.message))) return 'image_too_large';
        warnings.push('page_decode_failed');
        unreadablePages.push({ page: i + 1, error: 'decode_failed' });
      }
    }
    if (decoded.files.length > attempted) {
      state.truncatedPages = decoded.files.length - attempted;
      warnings.push('page_cap');
    }
    return null;
  });

  // sharp-native formats (and unknown ones sharp may still know).
  const decodeViaSharp = async (bytes) => {
    let density;
    if (state.format === 'svg') {
      // Rasterise small vector art at a readable size: the 72 dpi default
      // turns a 300×100 viewBox into 300×100 px of tiny glyphs.
      const svgMeta = await sharp(bytes, { limitInputPixels: cfg.maxPixels }).metadata();
      const longest = Math.max(svgMeta.width || 0, svgMeta.height || 0) || 1;
      density = Math.max(72, Math.min(600, Math.round((72 * 2400) / longest)));
      warnings.push('svg_rasterized');
    }
    const meta = await sharp(bytes, { limitInputPixels: cfg.maxPixels, failOn: 'none' }).metadata();
    const sourcePages = state.format === 'tiff' ? Math.max(1, meta.pages || 1) : 1;
    state.totalPages = sourcePages;
    const readPages = Math.min(sourcePages, maxPages);
    const truncated = looksTruncated(state.format, bytes);
    if (truncated) warnings.push('truncated_image_repaired');
    let attempted = 0;
    for (let i = 0; i < readPages; i += 1) {
      throwIfAborted(signal);
      if (state.outputBytes > cfg.maxOutputBytes) { warnings.push('output_cap'); break; }
      attempted = i + 1;
      const passThrough = PASS_THROUGH_FORMATS.has(state.format) && sourcePages === 1
        && (meta.orientation || 1) === 1 && (meta.width || 0) > 0 && (meta.height || 0) > 0
        && fitScale(meta.width, meta.height, cfg) === 1 && !truncated;
      if (passThrough) {
        pushPage({
          buffer: bytes, mime: mimeForFormat(state.format), width: meta.width, height: meta.height,
          exifOrientation: meta.orientation || null, exifRotation: 0,
        }, 'original', i + 1);
        continue;
      }
      const encodeOpts = {
        page: i, format: state.format, bounds: cfg, maxPixels: cfg.maxPixels, density,
        failOn: truncated ? 'none' : 'warning',
      };
      let encoded;
      try {
        encoded = await encodePage(sharp, bytes, encodeOpts);
      } catch (err) {
        if (/pixel limit/i.test(String(err && err.message))) return 'image_too_large';
        try {
          // A recoverable decode warning: retry tolerant once.
          encoded = await encodePage(sharp, bytes, { ...encodeOpts, failOn: 'none' });
          warnings.push('decoded_with_errors');
        } catch {
          // An unreadable page keeps its number (and the pages after it
          // keep theirs); a single-page image with no readable page fails
          // as `decode_failed` below.
          warnings.push('page_decode_failed');
          unreadablePages.push({ page: i + 1, error: 'decode_failed' });
          continue;
        }
      }
      if (encoded.exifRotation) warnings.push('exif_rotated');
      pushPage(encoded, state.format === 'tiff' && sourcePages > 1 ? `sharp:tiff#${i + 1}` : 'sharp', i + 1);
    }
    if (sourcePages > attempted) {
      state.truncatedPages = sourcePages - attempted;
      warnings.push('page_cap');
    }
    return null;
  };

  try {
    throwIfAborted(signal);
    const isBuffer = Buffer.isBuffer(input);
    if (!isBuffer && (typeof input !== 'string' || !input)) return fail('invalid_input');
    let head;
    let byteLength;
    if (isBuffer) {
      head = input.slice(0, 4096);
      byteLength = input.length;
    } else {
      const stat = await fsp.stat(input);
      if (!stat.isFile()) return fail('invalid_input');
      byteLength = stat.size;
      if (byteLength > cfg.maxInputBytes) return fail('input_too_large');
      head = await readHead(input);
    }
    if (byteLength === 0) return fail('empty_input');
    if (byteLength > cfg.maxInputBytes) return fail('input_too_large');

    state.format = sniffImageFormat(head, { mime: opts.mime, name: opts.name || (isBuffer ? '' : input) });
    if (state.format === 'pdf') return fail('not_an_image');
    const inputPath = isBuffer ? null : path.resolve(input);

    let error = null;
    if (SHARP_FORMATS.has(state.format)) {
      const bytes = isBuffer ? input : await fsp.readFile(input);
      throwIfAborted(signal);
      try {
        error = await decodeViaSharp(bytes);
      } catch (err) {
        if (err && err.code === 'ABORT_ERR') throw err;
        error = /pixel limit/i.test(String(err && err.message)) ? 'image_too_large' : 'decode_failed';
      }
    } else if (state.format === 'heic') {
      error = await decodeViaTools(isBuffer ? input : null, inputPath, [decodeWithHeifDec, decodeWithFfmpeg]);
    } else if (FFMPEG_FORMATS.has(state.format)) {
      error = await decodeViaTools(isBuffer ? input : null, inputPath, [decodeWithFfmpeg]);
    } else {
      // Unknown signature: sharp first, ffmpeg as the last resort.
      const bytes = isBuffer ? input : await fsp.readFile(input);
      let sharpFailed = false;
      try {
        error = await decodeViaSharp(bytes);
        sharpFailed = !error && pages.length === 0;
      } catch (err) {
        if (err && err.code === 'ABORT_ERR') throw err;
        sharpFailed = true;
      }
      if (sharpFailed) {
        pages.length = 0;
        unreadablePages.length = 0;
        state.outputBytes = 0;
        state.truncatedPages = 0;
        warnings.length = 0;
        error = await decodeViaTools(isBuffer ? input : null, inputPath, [decodeWithFfmpeg]);
      }
    }
    if (error) return fail(error);
    if (pages.length === 0) return fail('decode_failed');
    await applyOrientation();
    return done();
  } catch (err) {
    if (err && err.code === 'ABORT_ERR') return fail('aborted');
    if (err && err.code === 'ENOENT') return fail('input_missing');
    return fail('normalize_failed');
  }
}

/**
 * Provider-safe copy of a page for the vision rungs: PNG/JPEG, long side
 * ≤ `maxSide`, ≤ `maxBytes`. Untouched when it already fits. Never throws.
 */
async function toVisionImage(input, {
  mime = 'image/png',
  maxSide = 3072,
  maxBytes = 8 * 1024 * 1024,
  sharpImpl,
} = {}) {
  const buffer = Buffer.isBuffer(input) ? input : (input && input.buffer);
  const sourceMime = (input && !Buffer.isBuffer(input) && input.mime) || mime;
  if (!Buffer.isBuffer(buffer)) return { buffer: null, mime: sourceMime, resized: false, error: 'invalid_input' };
  try {
    const sharp = sharpImpl || require('sharp');
    const meta = await sharp(buffer).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    const okMime = sourceMime === 'image/jpeg' || sourceMime === 'image/png';
    if (okMime && longest <= maxSide && buffer.length <= maxBytes) {
      return { buffer, mime: sourceMime, width: meta.width, height: meta.height, resized: false };
    }
    const photo = sourceMime === 'image/jpeg' || ((meta.width || 0) * (meta.height || 0)) > 1_500_000;
    const resize = (side) => sharp(buffer).resize(side, side, { fit: 'inside', withoutEnlargement: true });
    let side = maxSide;
    let out = photo
      ? await resize(side).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer()
      : await resize(side).png().toBuffer();
    let outMime = photo ? 'image/jpeg' : 'image/png';
    for (let attempt = 0; out.length > maxBytes && attempt < 4; attempt += 1) {
      side = Math.round(side * 0.75);
      out = await resize(side).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
      outMime = 'image/jpeg';
    }
    const outMeta = await sharp(out).metadata();
    return { buffer: out, mime: outMime, width: outMeta.width, height: outMeta.height, resized: true };
  } catch {
    return { buffer, mime: sourceMime, resized: false, error: 'vision_prepare_failed' };
  }
}

// ── Pixel primitives (cooperative: yield every few rows) ──────────────────

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
const ROWS_PER_SLICE_PIXELS = 250_000;

function rowsPerSlice(width) {
  return Math.max(8, Math.floor(ROWS_PER_SLICE_PIXELS / Math.max(1, width)));
}

/**
 * Sauvola binarisation: T = m · (1 + k · (s / R − 1)) over a (2r+1)² window
 * (k 0.3, R 128),
 * with running column sums (O(width) memory, O(pixels) time).
 * `data` is 1-channel 8-bit (or `channels` interleaved; channel 0 is used).
 */
async function sauvolaBinarize(data, width, height, { channels = 1, radius, k = 0.3, R = 128 } = {}) {
  const W = width;
  const H = height;
  const C = channels;
  const r = radius || Math.max(7, Math.min(40, Math.round(Math.min(W, H) / 80)));
  const colSum = new Float64Array(W);
  const colSq = new Float64Array(W);
  const out = Buffer.alloc(W * H);
  const addRow = (y, sign) => {
    const base = y * W * C;
    for (let x = 0; x < W; x += 1) {
      const v = data[base + x * C];
      colSum[x] += sign * v;
      colSq[x] += sign * v * v;
    }
  };
  for (let y = 0; y <= Math.min(r, H - 1); y += 1) addRow(y, 1);
  const slice = rowsPerSlice(W);
  for (let y = 0; y < H; y += 1) {
    const rows = Math.min(y + r, H - 1) - Math.max(y - r, 0) + 1;
    let s = 0;
    let q = 0;
    let x0 = 0;
    let x1 = -1;
    const base = y * W;
    for (let x = 0; x < W; x += 1) {
      const lo = x - r < 0 ? 0 : x - r;
      const hi = x + r > W - 1 ? W - 1 : x + r;
      while (x1 < hi) { x1 += 1; s += colSum[x1]; q += colSq[x1]; }
      while (x0 < lo) { s -= colSum[x0]; q -= colSq[x0]; x0 += 1; }
      const n = (hi - lo + 1) * rows;
      const mean = s / n;
      const variance = q / n - mean * mean;
      const sd = variance > 0 ? Math.sqrt(variance) : 0;
      const threshold = mean * (1 + k * (sd / R - 1));
      out[base + x] = data[(base + x) * C] > threshold ? 255 : 0;
    }
    if (y + r + 1 < H) addRow(y + r + 1, 1);
    if (y - r >= 0) addRow(y - r, -1);
    if (y % slice === slice - 1) await yieldToLoop();
  }
  return out;
}

/**
 * Contrast-limited adaptive histogram equalisation on a tile grid with
 * bilinear interpolation between tile mappings (the classic CLAHE; libvips'
 * per-pixel hist_local was ~2 s on a 6 MP page). 1-channel in, 1-channel out.
 */
async function claheGray(data, width, height, { channels = 1, tilesX, tilesY, clipLimit = 3 } = {}) {
  const W = width;
  const H = height;
  const C = channels;
  const tx = tilesX || Math.max(2, Math.min(16, Math.round(W / 256)));
  const ty = tilesY || Math.max(2, Math.min(16, Math.round(H / 256)));
  const tileW = Math.ceil(W / tx);
  const tileH = Math.ceil(H / ty);
  const luts = new Uint8Array(tx * ty * 256);
  const hist = new Uint32Array(256);
  for (let j = 0; j < ty; j += 1) {
    for (let i = 0; i < tx; i += 1) {
      hist.fill(0);
      const x0 = i * tileW;
      const y0 = j * tileH;
      const x1 = Math.min(W, x0 + tileW);
      const y1 = Math.min(H, y0 + tileH);
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      for (let y = y0; y < y1; y += 1) {
        const rowBase = y * W;
        for (let x = x0; x < x1; x += 1) hist[data[(rowBase + x) * C]] += 1;
      }
      const limit = Math.max(1, Math.floor((clipLimit * area) / 256));
      let excess = 0;
      for (let b = 0; b < 256; b += 1) {
        if (hist[b] > limit) { excess += hist[b] - limit; hist[b] = limit; }
      }
      const add = Math.floor(excess / 256);
      let remainder = excess - add * 256;
      for (let b = 0; b < 256; b += 1) {
        hist[b] += add;
        if (remainder > 0) { hist[b] += 1; remainder -= 1; }
      }
      let cdf = 0;
      const lutBase = (j * tx + i) * 256;
      for (let b = 0; b < 256; b += 1) {
        cdf += hist[b];
        luts[lutBase + b] = Math.min(255, Math.round((cdf * 255) / area));
      }
    }
    await yieldToLoop();
  }
  // Per-column interpolation weights.
  const cx0 = new Int32Array(W);
  const cx1 = new Int32Array(W);
  const ax = new Float32Array(W);
  for (let x = 0; x < W; x += 1) {
    const f = (x + 0.5) / tileW - 0.5;
    const lo = Math.max(0, Math.min(tx - 1, Math.floor(f)));
    cx0[x] = lo;
    cx1[x] = Math.min(tx - 1, lo + 1);
    ax[x] = Math.max(0, Math.min(1, f - lo));
  }
  const out = Buffer.alloc(W * H);
  const slice = rowsPerSlice(W);
  for (let y = 0; y < H; y += 1) {
    const f = (y + 0.5) / tileH - 0.5;
    const y0 = Math.max(0, Math.min(ty - 1, Math.floor(f)));
    const y1 = Math.min(ty - 1, y0 + 1);
    const ay = Math.max(0, Math.min(1, f - y0));
    const row0 = y0 * tx;
    const row1 = y1 * tx;
    const rowBase = y * W;
    for (let x = 0; x < W; x += 1) {
      const v = data[(rowBase + x) * C];
      const a = ax[x];
      const top = (1 - a) * luts[(row0 + cx0[x]) * 256 + v] + a * luts[(row0 + cx1[x]) * 256 + v];
      const bottom = (1 - a) * luts[(row1 + cx0[x]) * 256 + v] + a * luts[(row1 + cx1[x]) * 256 + v];
      out[rowBase + x] = Math.round((1 - ay) * top + ay * bottom);
    }
    if (y % slice === slice - 1) await yieldToLoop();
  }
  return out;
}

/** Variance (and mean) of the 4-neighbour Laplacian over interior pixels. */
async function laplacianVariance(data, width, height, { channels = 1 } = {}) {
  const W = width;
  const H = height;
  const C = channels;
  if (W < 3 || H < 3) return { variance: 0, mean: 0, samples: 0 };
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  const slice = rowsPerSlice(W);
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const c = data[(y * W + x) * C];
      const lap = data[(y * W + x - 1) * C] + data[(y * W + x + 1) * C]
        + data[((y - 1) * W + x) * C] + data[((y + 1) * W + x) * C] - 4 * c;
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
    if (y % slice === 0) await yieldToLoop();
  }
  const mean = sum / n;
  return { variance: Math.max(0, sumSq / n - mean * mean), mean, samples: n };
}

/**
 * Blur metric: Laplacian variance at a fixed analysis size (long side
 * ≤ 1024) so scores are comparable across resolutions. `blurry` when under
 * SIRAGPT_OCR_BLUR_THRESHOLD (100). Never throws.
 */
async function measureBlur(input, { env = process.env, sharpImpl, maxSide = 1024 } = {}) {
  const cfg = inputConfig(env);
  try {
    const sharp = sharpImpl || require('sharp');
    const { data, info } = await sharp(input)
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { variance } = await laplacianVariance(data, info.width, info.height, { channels: info.channels });
    return {
      ok: true,
      variance: Math.round(variance * 10) / 10,
      blurry: variance < cfg.blurThreshold,
      threshold: cfg.blurThreshold,
      width: info.width,
      height: info.height,
    };
  } catch {
    return { ok: false, variance: null, blurry: false, threshold: cfg.blurThreshold };
  }
}

module.exports = {
  inputConfig,
  normalizeImageInput,
  sniffImageFormat,
  toVisionImage,
  detectOrientation,
  parseOsd,
  measureBlur,
  sauvolaBinarize,
  claheGray,
  laplacianVariance,
  probeHeifDecoder,
  probeFfmpeg,
  probeTesseractCli,
  probeTessdata,
  probeOsd,
  resolveLocalTessdata,
  tessdataCacheDir,
  getOcrInputCapabilities,
  runCommand,
  resetProbeCache,
  _internals: { looksTruncated, jpegCompleteness, pngCompleteness, fitScale, encodePage, EXIF_ROTATION, warnOnce, readHeifImageSize },
};
