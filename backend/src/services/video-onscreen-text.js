'use strict';

/**
 * video-onscreen-text — the text a video SHOWS (slides, whiteboard, code in
 * a screen recording, burned-in captions), with times.
 *
 *   extractOnScreenText(filePath, opts)
 *     → { ok, items: [{ start, end, text, confidence }], framesRead,
 *         framesSkipped, partial, reason? }
 *
 * Contract C2 of the «transcription never fails» plan. A video with no audio
 * track, or whose audio has no speech, still yields text instead of «no se
 * detectó voz».
 *
 * Pipeline (CPU-only, bounded, resumable):
 *   1. Candidate frames: ONE ffmpeg pass that decodes keyframes only
 *      (`-skip_frame nokey`), downscaled, with `select` scene detection and
 *      `showinfo` — it writes the candidate TIMESTAMP list, not images. When
 *      the scene filter finds nothing (or `select`/`showinfo` are missing),
 *      one frame every N seconds. When it finds some changes, the stretches
 *      between them are filled at that same cadence (a keyframe-only pass
 *      misses slide changes on a shared template, so the scene branch is never
 *      sparser than the fallback). Capped per hour and in total; scene frames
 *      win over filler frames.
 *   2. Each candidate is extracted alone by a keyframe seek (1280 px wide,
 *      PNG in memory — no temp files) and deduplicated against the last frame
 *      that was read: the 64-bit sharp dHash (Hamming ≤ 6) is only a cheap
 *      pre-filter (a 9×8 grid sees the slide template, not its text), and OCR
 *      is skipped only when a greyscale thumbnail (≤ 240 px) agrees too — no
 *      more than one pixel off by > 24 levels after a global brightness
 *      correction. One added bullet, a changed title or four typed lines of
 *      code change 50+ pixels; re-encoding noise of the same slide changes 0.
 *   3. OCR: Tesseract first through the injectable `ocr(buffer)`; a frame is
 *      escalated to GLM-OCR (local) only when its Tesseract read is weak, the
 *      escalation cap allows it and enough budget remains. The paid vision
 *      ladder is never used unless SIRAGPT_VIDEO_OCR_CLOUD=1. Escalated text
 *      is gated (loops, runaway length, no agreement with Tesseract).
 *   4. One checkpoint JSON per frame in `<checkpointDir>/onscreen/`, so a
 *      deploy or retry resumes where it stopped (the plan is checkpointed
 *      too: the detection pass never runs twice for the same file). A frame
 *      that was read also leaves its thumbnail (`f-NNNNN.thumb`, raw grey),
 *      so a resumed job dedupes exactly as the uninterrupted one would.
 *   5. Consecutive frames with near-identical text merge into one item; a
 *      build step (one more bullet) keeps the fuller read.
 *
 * The probe always runs unless the caller hands one over (`opts.probe`);
 * `opts.durationSec` only overrides the probed duration. Knobs (option, then
 * env): SIRAGPT_VIDEO_OCR_BUDGET_MS, _MAX_FRAMES, _MAX_FRAMES_PER_HOUR,
 * _SCENE_THRESHOLD (0.30 by contract; ~0.06 is what catches slide changes on
 * a shared template in a keyframe-only pass, the interval fill covers them
 * meanwhile), _FRAME_BUDGET_MS, _MAX_ESCALATIONS, _ESCALATE, _CLOUD.
 *
 * Honesty: a frame whose text exists but cannot be read becomes an item with
 * the text «[ilegible]», never a guess. Logs carry counts only, never text.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const mediaProbe = require('./media-probe');

const CHECKPOINT_VERSION = 1;
const ONSCREEN_DIRNAME = 'onscreen';
const ILLEGIBLE = '[ilegible]';
const MAX_ITEM_TEXT = 2000;
const MAX_DETECTED_TIMES = 20_000;
const FRAME_MAX_BYTES = 16 * 1024 * 1024;
// Fine dedupe fingerprint: greyscale thumbnail, long side ≤ 240 px.
const THUMB_MAX_SIDE = 240;

function numberFromEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env && env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pick(value, fallback) {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : fallback;
}

/** Effective knobs: explicit options win, then env, then defaults. */
function resolveOptions(opts = {}, env = process.env) {
  return {
    budgetMs: pick(opts.budgetMs, numberFromEnv(env, 'SIRAGPT_VIDEO_OCR_BUDGET_MS', 20 * 60 * 1000, { min: 1000, max: 6 * 3600 * 1000 })),
    maxFrames: Math.max(1, Math.floor(pick(opts.maxFrames, numberFromEnv(env, 'SIRAGPT_VIDEO_OCR_MAX_FRAMES', 240, { min: 1, max: 2000 })))),
    maxFramesPerHour: Math.max(1, Math.floor(pick(opts.maxFramesPerHour, numberFromEnv(env, 'SIRAGPT_VIDEO_OCR_MAX_FRAMES_PER_HOUR', 90, { min: 1, max: 3600 })))),
    sceneThreshold: Math.min(0.95, Math.max(0.01, pick(opts.sceneThreshold, numberFromEnv(env, 'SIRAGPT_VIDEO_OCR_SCENE_THRESHOLD', 0.30, { min: 0.01, max: 0.95 })))),
    sampleEverySec: Math.max(1, pick(opts.sampleEverySec, 30)),
    // Longest stretch without a frame in the scene branch. Default: the
    // interval-fallback cadence (never sparser than having found nothing).
    maxGapSec: opts.maxGapSec != null && Number.isFinite(Number(opts.maxGapSec)) ? Math.max(5, Number(opts.maxGapSec)) : null,
    minSpacingSec: Math.max(0, pick(opts.minSpacingSec, 1)),
    detectWidth: Math.max(64, Math.floor(pick(opts.detectWidth, 640))),
    frameWidth: Math.max(64, Math.floor(pick(opts.frameWidth, 1280))),
    frameBudgetMs: Math.max(500, pick(opts.frameBudgetMs, numberFromEnv(env, 'SIRAGPT_VIDEO_OCR_FRAME_BUDGET_MS', 6000, { min: 500, max: 120_000 }))),
    frameTimeoutMs: Math.max(1000, pick(opts.frameTimeoutMs, 30_000)),
    // Worker start-up (traineddata load) on top of the per-frame budget; an
    // OCR call that outlives both is abandoned (two in a row stop the job).
    ocrStartupGraceMs: Math.max(0, pick(opts.ocrStartupGraceMs, 20_000)),
    dedupeDistance: Math.max(0, Math.floor(pick(opts.dedupeDistance, 6))),
    dedupePixelThreshold: Math.max(1, Math.floor(pick(opts.dedupePixelThreshold, 24))),
    dedupeMaxChangedPixels: Math.max(0, Math.floor(pick(opts.dedupeMaxChangedPixels, 1))),
    lowConfidence: Math.min(1, Math.max(0, pick(opts.lowConfidence, 0.6))),
    minItemConfidence: Math.min(1, Math.max(0, pick(opts.minItemConfidence, 0.45))),
    mergeSimilarity: Math.min(1, Math.max(0.3, pick(opts.mergeSimilarity, 0.8))),
    maxEscalations: Math.max(0, Math.floor(pick(opts.maxEscalations, numberFromEnv(env, 'SIRAGPT_VIDEO_OCR_MAX_ESCALATIONS', 6, { min: 0, max: 500 })))),
    escalateMinRemainingMs: Math.max(0, pick(opts.escalateMinRemainingMs, 3 * 60 * 1000)),
    escalateTimeoutMs: Math.max(1000, pick(opts.escalateTimeoutMs, 120_000)),
    escalateEnabled: opts.escalate === false ? false : String(env.SIRAGPT_VIDEO_OCR_ESCALATE ?? '1') !== '0',
    cloudVision: opts.cloudVision != null ? Boolean(opts.cloudVision) : /^(1|true|on|yes)$/i.test(String(env.SIRAGPT_VIDEO_OCR_CLOUD || '')),
  };
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

// ── Frame planning (pure) ───────────────────────────────────────────────

/** Pick `k` items of a sorted array, evenly spread, keeping first and last. */
function evenlySample(list, k) {
  if (k <= 0) return [];
  if (list.length <= k) return list.slice();
  if (k === 1) return [list[0]];
  const out = [];
  const used = new Set();
  for (let i = 0; i < k; i += 1) {
    const idx = Math.round((i * (list.length - 1)) / (k - 1));
    if (!used.has(idx)) { used.add(idx); out.push(list[idx]); }
  }
  return out;
}

/**
 * Candidate timestamps → the frames to read: [{ t, kind: 'scene'|'interval'|'gap' }].
 * Scene frames come first within each hour bucket; filler frames only use
 * the room left by the per-hour cap; the total cap spreads frames evenly.
 *
 * The stretches between scene changes are filled at the interval-fallback
 * cadence (or `maxGapSec` when that is shorter): a keyframe-only scene pass
 * scores slide changes on a shared template at ~0.05, far under 0.30, so a
 * lecture whose only detected cut is camera → slides must still be sampled
 * as densely as one where nothing was detected.
 */
function planFrameTimes(sceneTimes, {
  durationSec = null, maxFrames = 240, maxFramesPerHour = 90, sampleEverySec = 30, maxGapSec = null, minSpacingSec = 1,
} = {}) {
  const duration = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : null;
  const inRange = (t) => Number.isFinite(t) && t >= 0 && (duration == null || t < duration);
  const scene = Array.from(new Set((sceneTimes || []).map(Number).filter(inRange).map(round3))).sort((a, b) => a - b);
  const meaningful = scene.filter((t) => t > 0.5);
  // The per-hour cap applies to each hour bucket (a 6-second clip still gets
  // its three slides); the total cap bounds a 10-hour recording.
  const totalCap = Math.max(1, maxFrames);
  const intervalCap = Math.max(1, Math.min(totalCap, duration ? Math.ceil(duration / 3600) * maxFramesPerHour : totalCap));
  const every = Math.max(1, Number(sampleEverySec) || 30);
  // One frame every `every` seconds, stretched so the caps cover the video.
  const step = duration ? Math.max(every, duration / intervalCap) : every;
  const explicitGap = Number(maxGapSec);
  const gapStep = maxGapSec != null && Number.isFinite(explicitGap) && explicitGap > 0 ? Math.min(explicitGap, step) : step;

  let frames;
  let fallback = null;
  if (meaningful.length === 0) {
    fallback = 'interval';
    frames = [];
    if (duration) {
      for (let t = 0; t < duration && frames.length < totalCap * 2; t += step) frames.push({ t: round3(t), kind: 'interval' });
    } else {
      frames.push({ t: 0, kind: 'interval' });
    }
  } else {
    frames = scene.map((t) => ({ t, kind: 'scene' }));
    if (frames[0].t > 0.5) frames.unshift({ t: 0, kind: 'gap' });
    // Undetected slide changes, long static stretches and long-GOP screen
    // recordings still get a frame every gapStep.
    const filled = [];
    const end = duration;
    for (let i = 0; i < frames.length; i += 1) {
      filled.push(frames[i]);
      const next = i + 1 < frames.length ? frames[i + 1].t : end;
      if (next == null) continue;
      for (let t = frames[i].t + gapStep; t < next - minSpacingSec; t += gapStep) filled.push({ t: round3(t), kind: 'gap' });
    }
    frames = filled;
  }

  // Minimum spacing: keyframes closer than this are the same picture.
  const spaced = [];
  for (const f of frames.sort((a, b) => a.t - b.t)) {
    const prev = spaced[spaced.length - 1];
    if (prev && f.t - prev.t < minSpacingSec) {
      if (prev.kind !== 'scene' && f.kind === 'scene') spaced[spaced.length - 1] = f;
      continue;
    }
    spaced.push(f);
  }

  // Per-hour cap: scene frames first, filler frames in the room left.
  const buckets = new Map();
  for (const f of spaced) {
    const hour = Math.floor(f.t / 3600);
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(f);
  }
  let capped = false;
  let selected = [];
  for (const hour of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const bucket = buckets.get(hour);
    if (bucket.length <= maxFramesPerHour) { selected.push(...bucket); continue; }
    capped = true;
    const primary = bucket.filter((f) => f.kind === 'scene');
    const filler = bucket.filter((f) => f.kind !== 'scene');
    const keepPrimary = evenlySample(primary, maxFramesPerHour);
    const keepFiller = evenlySample(filler, Math.max(0, maxFramesPerHour - keepPrimary.length));
    selected.push(...keepPrimary, ...keepFiller);
  }
  selected.sort((a, b) => a.t - b.t);
  if (selected.length > totalCap) {
    capped = true;
    selected = evenlySample(selected, totalCap);
  }
  return { frames: selected.map((f, i) => ({ i, t: f.t, kind: f.kind })), fallback, capped };
}

// ── Perceptual hash + text helpers (pure) ───────────────────────────────

/** 9×8 greyscale grid → 64-bit difference hash (hex) + mean luma. */
function hashFromGrid(raw) {
  let bits = '';
  let sum = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) sum += raw[y * 9 + x];
    for (let x = 0; x < 8; x += 1) bits += raw[y * 9 + x] > raw[y * 9 + x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  return { hash: hex, mean: Math.round(sum / 72) };
}

/** 64-bit difference hash (hex) + mean luma of a frame. */
async function dHash(buffer, sharpImpl = require('sharp')) {
  const raw = await sharpImpl(buffer).removeAlpha().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  return hashFromGrid(raw);
}

/** First channel of a raw buffer (sharp keeps 1 channel for greyscale). */
function singleChannel(data, channels) {
  if (!channels || channels === 1) return data;
  const out = Buffer.alloc(Math.floor(data.length / channels));
  for (let i = 0; i < out.length; i += 1) out[i] = data[i * channels];
  return out;
}

/**
 * Both dedupe fingerprints from one decode: the 64-bit dHash + mean (the
 * cheap pre-filter) and a greyscale thumbnail, long side ≤ 240 px, aspect
 * kept (a portrait phone recording keeps its line height).
 */
async function frameFingerprint(buffer, sharpImpl = require('sharp')) {
  const grey = sharpImpl(buffer).removeAlpha().greyscale();
  const [grid, thumb] = await Promise.all([
    grey.clone().resize(9, 8, { fit: 'fill' }).raw().toBuffer(),
    grey.clone().resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { hash, mean } = hashFromGrid(grid);
  const data = singleChannel(thumb.data, thumb.info && thumb.info.channels);
  return { hash, mean, thumb: { w: thumb.info.width, h: thumb.info.height, data } };
}

function hammingHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    while (x) { distance += x & 1; x >>= 1; }
  }
  return distance;
}

/**
 * Pixels of two same-size thumbnails that differ by more than `threshold`
 * grey levels once a global brightness drift (auto-exposure, a fade) is
 * taken out. Infinity when they cannot be compared.
 */
function thumbChangedPixels(a, b, { threshold = 24 } = {}) {
  if (!a || !b || !a.data || !b.data || a.w !== b.w || a.h !== b.h) return Infinity;
  const n = a.data.length;
  if (!n || n !== b.data.length || n !== a.w * a.h) return Infinity;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a.data[i]; sb += b.data[i]; }
  const offset = (sb - sa) / n;
  let changed = 0;
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(b.data[i] - a.data[i] - offset) > threshold) changed += 1;
  }
  return changed;
}

/** The cheap pre-filter: close 64-bit hashes AND close brightness (two flat frames hash alike). */
function isCoarseDuplicate(a, b, maxDistance = 6) {
  if (!a || !b || !a.hash || !b.hash) return false;
  if (Math.abs(Number(a.mean || 0) - Number(b.mean || 0)) > 40) return false;
  return hammingHex(a.hash, b.hash) <= maxDistance;
}

/**
 * Same picture, so OCR can be skipped. The 64-bit dHash only sees the slide
 * template: one more bullet, «Tema 1» → «Tema 1 (cont.)» or four typed lines
 * of code stay within Hamming 6. So a frame is a duplicate only when the
 * thumbnails agree too (≤ `maxChangedPixels` pixels off). Without both
 * thumbnails it is never a duplicate: an extra OCR call costs time, a
 * skipped one loses text. A number as `opts` is the old `maxDistance`.
 */
function isDuplicateFrame(a, b, opts = {}) {
  const o = typeof opts === 'number' ? { maxDistance: opts } : (opts || {});
  const maxDistance = Number.isFinite(Number(o.maxDistance)) ? Number(o.maxDistance) : 6;
  const maxChangedPixels = Number.isFinite(Number(o.maxChangedPixels)) ? Number(o.maxChangedPixels) : 1;
  const pixelThreshold = Number.isFinite(Number(o.pixelThreshold)) ? Number(o.pixelThreshold) : 24;
  if (!isCoarseDuplicate(a, b, maxDistance)) return false;
  return thumbChangedPixels(a.thumb, b.thumb, { threshold: pixelThreshold }) <= maxChangedPixels;
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n > 1 ? n / 100 : n);
}

function usefulChars(text) {
  const m = String(text || '').match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

function wordlikeTokens(text) {
  return (String(text || '').match(/[\p{L}]{3,}/gu) || []).length;
}

/** Drop Tesseract junk lines («| ~ =— ‘»); keep lines that look like text. */
function cleanOcrText(text) {
  const lines = String(text || '')
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      const alnum = usefulChars(line);
      if (alnum < 2) return false;
      const visible = line.replace(/\s/g, '').length || 1;
      return alnum / visible >= 0.5;
    });
  const joined = lines.join('\n').trim();
  return joined.length > MAX_ITEM_TEXT ? joined.slice(0, MAX_ITEM_TEXT) : joined;
}

function tokensOf(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function bigrams(text) {
  const s = tokensOf(text).join(' ');
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/**
 * 0..1 similarity of two OCR reads of (maybe) the same screen: the better of
 * token Jaccard and character-bigram Dice (OCR noise breaks whole tokens,
 * «Krebs»/«Krcbs»). Different numbers («Tema 1» → «Tema 2») are never the
 * same screen.
 */
function textSimilarity(a, b) {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  const jaccard = shared / (sa.size + sb.size - shared);
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) { total += n; if (gb.has(g)) inter += Math.min(n, gb.get(g)); }
  for (const n of gb.values()) total += n;
  const dice = total ? (2 * inter) / total : 0;
  const best = Math.max(jaccard, dice);
  const digits = (list) => list.filter((t) => /\d/.test(t)).map((t) => t.replace(/\D/g, '')).sort().join(',');
  return digits(ta) === digits(tb) ? best : Math.min(best, 0.5);
}

function trigramJaccard(a, b) {
  const grams = (s) => {
    const t = tokensOf(s).join(' ');
    const set = new Set();
    for (let i = 0; i < t.length - 2; i += 1) set.add(t.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

/** A repetition loop: few distinct tokens, or one line repeated over and over. */
function looksLikeLoop(text) {
  const tokens = tokensOf(text);
  if (tokens.length >= 12 && new Set(tokens).size / tokens.length < 0.25) return true;
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let run = 1;
  for (let i = 1; i < lines.length; i += 1) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return false;
}

/**
 * Gate for an escalated (GLM / vision) read: never accept a loop, a runaway
 * transcription far longer than the frame could hold, or text that shares
 * nothing with a substantial Tesseract read.
 */
function gateEscalatedText(candidate, tesseractText) {
  const text = cleanOcrText(candidate);
  if (!text || usefulChars(text) < 3 || /^OCR_EMPTY$/i.test(text)) return { ok: false, reason: 'empty' };
  if (looksLikeLoop(candidate)) return { ok: false, reason: 'loop' };
  const base = String(tesseractText || '');
  if (text.length > Math.max(600, base.length * 8 + 200)) return { ok: false, reason: 'runaway_length' };
  if (usefulChars(base) >= 20 && trigramJaccard(text, base) < 0.1) return { ok: false, reason: 'no_agreement' };
  return { ok: true, text };
}

// ── Default OCR adapters (lazy: tests never load tesseract) ─────────────

const TIMED_OUT = Symbol('timed_out');

/** Race a promise against `ms`; the loser is left to settle on its own. */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {}); // a late rejection after the timeout is not unhandled
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

async function defaultOcr(buffer, { budgetMs } = {}) {
  const engine = require('./ocr-engine');
  // runLocalImageOcr hands back the raw Tesseract read (text + 0-100
  // confidence) even when it is weak, which a short caption usually is;
  // extractFromImage in local mode is the fallback if it is ever renamed.
  if (engine && typeof engine.runLocalImageOcr === 'function') {
    const local = await engine.runLocalImageOcr(buffer, { localBudgetMs: budgetMs });
    const quality = (local && local.quality) || {};
    return { text: quality.text || '', confidence: Number(quality.confidence || 0) };
  }
  const result = await engine.extractFromImage(buffer, {
    mode: 'local', allowVision: false, analyze: false, mimeType: 'image/png', localBudgetMs: budgetMs,
  });
  return { text: (result && result.text) || '', confidence: Number(result && result.ocr && result.ocr.confidence) || 0 };
}

async function defaultEscalate(buffer, { tesseract, cloud } = {}) {
  const engine = require('./ocr-engine');
  const localQuality = { confidence: Math.round(normalizeConfidence(tesseract && tesseract.confidence) * 100) };
  let result = null;
  if (cloud && typeof engine.runVisionFallback === 'function') {
    result = await engine.runVisionFallback({ buffer, mimeType: 'image/png', localQuality });
  } else if (typeof engine.runOllamaOcrFallback === 'function') {
    result = await engine.runOllamaOcrFallback({ buffer, mimeType: 'image/png', localQuality });
  }
  if (result == null) return { unavailable: true };
  if (!result.text || !result.ocr || result.ocr.status !== 'vision_fallback') return { failed: true };
  return { text: result.text, engine: String(result.ocr.provider || (cloud ? 'vision' : 'glm-ocr')).slice(0, 60) };
}

// ── Checkpoints ─────────────────────────────────────────────────────────

async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, JSON.stringify(value));
}

async function readJson(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function frameFileName(i) {
  return `f-${String(i).padStart(5, '0')}.json`;
}

function thumbFileName(i) {
  return `f-${String(i).padStart(5, '0')}.thumb`;
}

/**
 * Checkpoint store under `<checkpointDir>/onscreen/`. A plan made with other
 * knobs (or for another file size) wipes the directory. Every failure turns
 * checkpointing off for the job; extraction itself never fails because of it.
 */
async function openCheckpoint(checkpointDir, key, { logger } = {}) {
  if (!checkpointDir) return null;
  const dir = path.join(path.resolve(String(checkpointDir)), ONSCREEN_DIRNAME);
  let broken = false;
  const disable = (err) => {
    if (!broken) {
      broken = true;
      try { (logger || console).warn(`[video-onscreen-text] checkpoints disabled for this job (${(err && err.code) || 'io_error'})`); } catch (_) { /* best-effort */ }
    }
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    const plan = await readJson(path.join(dir, 'plan.json'));
    if (plan && (plan.v !== CHECKPOINT_VERSION || plan.key !== key)) {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
    }
  } catch (err) {
    disable(err);
    return null;
  }
  return {
    dir,
    async readPlan() {
      if (broken) return null;
      const plan = await readJson(path.join(dir, 'plan.json'));
      if (!plan || plan.v !== CHECKPOINT_VERSION || plan.key !== key || !Array.isArray(plan.frames)) return null;
      return plan;
    },
    async writePlan(plan) {
      if (broken) return;
      try { await writeJsonAtomic(path.join(dir, 'plan.json'), { ...plan, v: CHECKPOINT_VERSION, key }); } catch (err) { disable(err); }
    },
    async readFrame(frame) {
      if (broken) return null;
      const rec = await readJson(path.join(dir, frameFileName(frame.i)));
      if (!rec || rec.v !== CHECKPOINT_VERSION || rec.key !== key || rec.i !== frame.i || rec.t !== frame.t) return null;
      return rec;
    },
    /**
     * A read frame's thumbnail goes to disk BEFORE its record: a record that
     * exists always has its thumbnail, so a resume dedupes like the first run.
     */
    async writeFrame(rec, thumb = null) {
      if (broken) return;
      try {
        if (thumb && thumb.data && rec.thumbW) await writeFileAtomic(path.join(dir, thumbFileName(rec.i)), thumb.data);
        await writeJsonAtomic(path.join(dir, frameFileName(rec.i)), { ...rec, v: CHECKPOINT_VERSION, key });
      } catch (err) {
        disable(err);
      }
    },
    /** The thumbnail of a checkpointed frame, or null (then it never dedupes). */
    async readThumb(rec) {
      if (broken || !rec || !rec.thumbW || !rec.thumbH) return null;
      try {
        const data = await fsp.readFile(path.join(dir, thumbFileName(rec.i)));
        return data.length === rec.thumbW * rec.thumbH ? { w: rec.thumbW, h: rec.thumbH, data } : null;
      } catch (_) {
        return null;
      }
    },
  };
}

// ── ffmpeg passes ───────────────────────────────────────────────────────

const SHOWINFO_RE = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/;
// ffmpeg 6.x on an audio-only file: no decoder takes `-skip_frame`, or the
// filter graph has no input («Output file does not contain any stream»).
const NO_VIDEO_RE = /does not contain any stream|matches no streams|AVOption skip_frame .* is not a decoding option/i;
// Consecutive frames that cannot be decoded before the job gives up.
const MAX_CONSECUTIVE_EXTRACT_FAILURES = 8;

async function detectSceneTimes(filePath, { run, ffmpeg, signal, timeoutMs, detectWidth, sceneThreshold }) {
  const times = [];
  const thr = sceneThreshold.toFixed(3);
  const filter = `scale='min(${detectWidth},iw)':-2,select='eq(n\\,0)+gt(scene\\,${thr})',showinfo`;
  const args = [
    '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'info',
    '-skip_frame', 'nokey',
    '-i', path.resolve(String(filePath)),
    '-an', '-sn', '-dn',
    '-vf', filter,
    '-f', 'null', '-',
  ];
  const res = await run(ffmpeg, args, {
    signal,
    timeoutMs,
    maxStdoutBytes: 64 * 1024,
    onStderrLine: (line) => {
      if (times.length >= MAX_DETECTED_TIMES || !line.includes('showinfo')) return;
      const m = SHOWINFO_RE.exec(line);
      if (m) {
        const t = Number(m[1]);
        if (Number.isFinite(t) && t >= 0) times.push(t);
      }
    },
  });
  return {
    times,
    timedOut: Boolean(res.timedOut),
    aborted: Boolean(res.aborted),
    missing: Boolean(res.missing),
    // An audio-only file: the scene pass has nothing to decode.
    noVideo: times.length === 0 && res.code !== 0 && NO_VIDEO_RE.test(String(res.stderrTail || '')),
  };
}

async function extractFrame(filePath, t, { run, ffmpeg, signal, timeoutMs, frameWidth }) {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-ss', Number(t).toFixed(3),
    '-i', path.resolve(String(filePath)),
    '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', `scale='min(${frameWidth},iw)':-2`,
    '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ];
  const res = await run(ffmpeg, args, { signal, timeoutMs, maxStdoutBytes: FRAME_MAX_BYTES });
  if (res.aborted) return { error: 'aborted' };
  if (res.missing) return { error: 'ffmpeg_missing' };
  if (res.timedOut) return { error: 'frame_timeout' };
  if (res.stdoutTruncated) return { error: 'frame_too_large' };
  if (!res.stdout || res.stdout.length < 8) return { error: 'no_frame' };
  return { buffer: res.stdout };
}

// ── Merge (pure) ────────────────────────────────────────────────────────

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Word-like tokens (3+ letters) of `text` that `base` does not have, even
 * misread by one letter («Krcbs» is «Krebs»). Bounded: OCR text is capped.
 */
function novelWords(base, text) {
  const words = (value) => tokensOf(value).filter((t) => /\p{L}{3,}/u.test(t));
  const known = words(base);
  const exact = new Set(known);
  let novel = 0;
  for (const word of new Set(words(text))) {
    if (exact.has(word)) continue;
    if (word.length >= 4 && known.some((k) => editDistanceAtMost1(k, word))) continue;
    novel += 1;
  }
  return novel;
}

/**
 * Frame records (time order) → items. A run of frames whose text is nearly
 * the same (or whose picture is a duplicate of the run's last read frame)
 * becomes one item from its first frame to the next frame that differs.
 */
function mergeFrameRecords(records, { durationSec = null, mergeSimilarity = 0.8 } = {}) {
  const items = [];
  let run = null;
  let lastReadHadText = false;
  const close = (endT) => {
    if (!run) return;
    const end = Number.isFinite(endT) && endT > run.lastT ? endT : run.lastT;
    items.push({
      start: round3(run.start),
      end: round3(Math.max(run.start, end)),
      text: run.text,
      confidence: Math.round(run.confidence * 1000) / 1000,
      frames: run.frames,
      ...(run.engine ? { engine: run.engine } : {}),
      ...(run.illegible ? { illegible: true } : {}),
    });
    run = null;
  };
  for (const rec of records) {
    if (!rec || !Number.isFinite(rec.t)) continue;
    // An unreadable frame says nothing about the picture: keep the run.
    if (rec.status === 'extract_failed' || rec.status === 'ocr_failed') continue;
    if (rec.status === 'duplicate') {
      if (run && lastReadHadText) { run.lastT = rec.t; run.frames += 1; }
      continue;
    }
    if (rec.status !== 'read' || !rec.text) {
      if (rec.status === 'read' || rec.status === 'empty') lastReadHadText = false;
      close(rec.t);
      continue;
    }
    lastReadHadText = true;
    const illegible = rec.text === ILLEGIBLE;
    if (run && run.illegible === illegible
      && (illegible || textSimilarity(run.text, rec.text) >= mergeSimilarity)) {
      run.lastT = rec.t;
      run.frames += 1;
      if (!illegible) {
        const confidence = Number(rec.confidence) || 0;
        // A build step (one more bullet, a word typed at the end) keeps the
        // fuller read unless it is clearly the worse one; a cleaner read
        // replaces the run's text only if it drops at most one stray word
        // (never the bullet a progressive reveal just added).
        const added = novelWords(run.text, rec.text);
        const dropped = novelWords(rec.text, run.text);
        const extendsRun = added > 0 && added >= dropped && confidence >= run.confidence - 0.1;
        const cleaner = confidence > run.confidence && dropped <= Math.max(1, added);
        if (extendsRun || cleaner) {
          run.text = rec.text;
          run.confidence = confidence; // the confidence of the text it now holds
          run.engine = rec.engine || run.engine;
        }
      }
      continue;
    }
    close(rec.t);
    run = {
      start: rec.t,
      lastT: rec.t,
      text: rec.text,
      confidence: Number(rec.confidence) || 0,
      engine: rec.engine || null,
      illegible,
      frames: 1,
    };
  }
  const duration = Number(durationSec);
  close(Number.isFinite(duration) && duration > 0 ? duration : null);
  return items;
}

// ── Main ────────────────────────────────────────────────────────────────

function planKey({ size, durationSec, knobs }) {
  return crypto.createHash('sha1').update(JSON.stringify({
    v: CHECKPOINT_VERSION,
    size: size || 0,
    d: durationSec ? Math.round(durationSec * 10) / 10 : null,
    s: knobs.sceneThreshold,
    mf: knobs.maxFrames,
    mh: knobs.maxFramesPerHour,
    se: knobs.sampleEverySec,
    g: knobs.maxGapSec,
    w: knobs.detectWidth,
    // Dedupe decisions are checkpointed too: other dedupe knobs, other job.
    dd: knobs.dedupeDistance,
    dp: knobs.dedupePixelThreshold,
    dc: knobs.dedupeMaxChangedPixels,
  })).digest('hex').slice(0, 24);
}

/**
 * See the module header. Never throws. `ok:false` reasons:
 *   missing_path · ffmpeg_unavailable · no_video_stream · aborted ·
 *   no_frames · internal_error
 * (a failed probe is not fatal: detection runs with the caller's duration, or none).
 * `ocr_unavailable` when the OCR engine never answers before any frame is read.
 * `partial:true` (with ok:true) when the budget ran out or detection was cut.
 */
async function extractOnScreenText(filePath, opts = {}) {
  const env = opts.env || process.env;
  const knobs = resolveOptions(opts, env);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const logger = opts.logger || console;
  const signal = opts.signal || null;
  const run = typeof opts.run === 'function' ? opts.run : mediaProbe.runMediaCommand;
  const ffmpeg = opts.ffmpeg || 'ffmpeg';
  const ocr = typeof opts.ocr === 'function' ? opts.ocr : defaultOcr;
  const escalate = typeof opts.escalate === 'function' ? opts.escalate : (knobs.escalateEnabled ? defaultEscalate : null);
  const hashFrame = typeof opts.hashFrame === 'function' ? opts.hashFrame : frameFingerprint;
  const startedAt = now();
  const deadline = startedAt + knobs.budgetMs;
  const out = {
    ok: false,
    items: [],
    framesRead: 0,
    framesSkipped: 0,
    partial: false,
    framesReused: 0,
    framesPlanned: 0,
    escalated: 0,
    escalationAttempts: 0,
    illegibleFrames: 0,
  };
  const stats = { extractFailed: 0, duplicates: 0, empty: 0, ocrFailed: 0 };
  const finish = (fields) => {
    Object.assign(out, fields);
    try {
      const line = `[video-onscreen-text] ok=${out.ok} planned=${out.framesPlanned} read=${out.framesRead} reused=${out.framesReused} `
        + `skipped=${out.framesSkipped} escalated=${out.escalated} items=${out.items.length} partial=${out.partial} `
        + `reason=${out.reason || '-'} elapsedMs=${Math.max(0, now() - startedAt)}`;
      if (out.ok) logger.info ? logger.info(line) : logger.log(line);
      else logger.warn(line);
    } catch (_) { /* logging is best-effort */ }
    return out;
  };

  try {
    if (!filePath) return finish({ reason: 'missing_path' });
    if (signal && signal.aborted) return finish({ reason: 'aborted' });

    // The probe always runs unless the caller hands one over: a known
    // duration says nothing about a picture (an mp3 with cover art has one
    // «video» stream and nothing to read). `durationSec` only overrides the
    // probed duration. A failed probe is not fatal.
    const probe = opts.probe || await mediaProbe.probeMediaStreams(filePath, {
      signal, ffprobe: opts.ffprobe, exec: opts.probeExec, logger,
    });
    if (signal && signal.aborted) return finish({ reason: 'aborted' });
    if (probe && probe.ok && !probe.hasVideo) return finish({ reason: 'no_video_stream' });
    let durationSec = Number.isFinite(Number(opts.durationSec)) && Number(opts.durationSec) > 0 ? Number(opts.durationSec) : null;
    if (durationSec == null && probe && probe.ok && probe.durationSec) durationSec = probe.durationSec;

    const caps = opts.capabilities || await mediaProbe.detectFfmpegFilters({ ffmpeg, run: opts.run, logger });
    if (!caps || !caps.available) return finish({ reason: 'ffmpeg_unavailable' });
    // An unknown filter set (`ffmpeg -filters` did not answer) is tried: a
    // missing binary or filter shows up in the scene pass itself.
    const filterSet = caps.filters instanceof Set ? caps.filters : (Array.isArray(caps.filters) ? new Set(caps.filters) : null);
    const canDetect = filterSet ? filterSet.has('select') && filterSet.has('showinfo') : true;

    const size = await fsp.stat(filePath).then((s) => s.size).catch(() => 0);
    const key = planKey({ size, durationSec, knobs });
    const ckpt = await openCheckpoint(opts.checkpointDir, key, { logger });

    // 1. Plan (checkpointed: the detection pass never runs twice).
    let plan = ckpt ? await ckpt.readPlan() : null;
    let detectionPartial = false;
    if (!plan) {
      let sceneTimes = [];
      if (canDetect) {
        const remaining = deadline - now();
        const detected = await detectSceneTimes(filePath, {
          run, ffmpeg, signal,
          timeoutMs: Math.max(5000, Math.min(15 * 60 * 1000, Math.floor(remaining * 0.5))),
          detectWidth: knobs.detectWidth,
          sceneThreshold: knobs.sceneThreshold,
        });
        if (detected.missing) return finish({ reason: 'ffmpeg_unavailable' });
        if (detected.noVideo) return finish({ reason: 'no_video_stream' });
        if (detected.aborted || (signal && signal.aborted)) return finish({ reason: 'aborted' });
        sceneTimes = detected.times;
        detectionPartial = detected.timedOut;
      }
      const planned = planFrameTimes(sceneTimes, {
        durationSec,
        maxFrames: knobs.maxFrames,
        maxFramesPerHour: knobs.maxFramesPerHour,
        sampleEverySec: knobs.sampleEverySec,
        maxGapSec: knobs.maxGapSec,
        minSpacingSec: knobs.minSpacingSec,
      });
      plan = {
        frames: planned.frames,
        fallback: planned.fallback || (canDetect ? null : 'no_scene_filter'),
        capped: planned.capped,
        detectionPartial,
        durationSec,
      };
      // Checkpointed even when detection was cut: gap filling already covers
      // the rest of the video, and a resume must never re-run the pass.
      if (ckpt) await ckpt.writePlan(plan);
    }
    detectionPartial = Boolean(plan.detectionPartial);
    out.framesPlanned = plan.frames.length;
    if (plan.frames.length === 0) return finish({ reason: 'no_frames' });

    // 2-3. Frames: checkpoint → extract → dedupe → OCR (→ escalate).
    const records = [];
    // The last frame that went through OCR: { i, hash, mean, thumb?, thumbW, thumbH }.
    // A checkpointed one loads its thumbnail lazily, only when a candidate
    // passes the coarse pre-filter against it.
    let lastRead = null;
    const dedupeOpts = {
      maxDistance: knobs.dedupeDistance,
      maxChangedPixels: knobs.dedupeMaxChangedPixels,
      pixelThreshold: knobs.dedupePixelThreshold,
    };
    let escalationOff = !escalate || knobs.maxEscalations === 0;
    let escalationFailures = 0;
    let ocrFailures = 0;
    let extractFailures = 0;
    let stopReason = null;
    for (const frame of plan.frames) {
      if (signal && signal.aborted) { stopReason = 'aborted'; break; }
      if (now() >= deadline) { stopReason = 'budget_exhausted'; break; }
      let rec = ckpt ? await ckpt.readFrame(frame) : null;
      let freshThumb = null;
      if (rec) {
        out.framesReused += 1;
      } else {
        const remaining = deadline - now();
        const extracted = await extractFrame(filePath, frame.t, {
          run, ffmpeg, signal, frameWidth: knobs.frameWidth,
          timeoutMs: Math.max(1000, Math.min(knobs.frameTimeoutMs, remaining)),
        });
        if (extracted.error === 'aborted' || (signal && signal.aborted)) { stopReason = 'aborted'; break; }
        if (extracted.error === 'ffmpeg_missing') return finish({ reason: 'ffmpeg_unavailable' });
        if (extracted.error) {
          rec = { i: frame.i, t: frame.t, status: 'extract_failed', transient: extracted.error === 'frame_timeout' };
          extractFailures += 1;
        } else {
          extractFailures = 0;
          let fingerprint = null;
          try { fingerprint = await hashFrame(extracted.buffer); } catch (_) { fingerprint = null; }
          let duplicate = false;
          if (fingerprint && lastRead && isCoarseDuplicate(fingerprint, lastRead, knobs.dedupeDistance)) {
            if (!lastRead.thumb && lastRead.thumbW && ckpt && !lastRead.thumbLoaded) {
              lastRead.thumbLoaded = true; // one disk read per resumed frame, hit or miss
              lastRead.thumb = await ckpt.readThumb(lastRead);
            }
            duplicate = isDuplicateFrame(fingerprint, lastRead, dedupeOpts);
          }
          const thumb = fingerprint && fingerprint.thumb && fingerprint.thumb.data ? fingerprint.thumb : null;
          const prints = fingerprint
            ? { hash: fingerprint.hash, mean: fingerprint.mean, ...(thumb ? { thumbW: thumb.w, thumbH: thumb.h } : {}) }
            : {};
          if (duplicate) {
            rec = { i: frame.i, t: frame.t, status: 'duplicate', hash: fingerprint.hash, mean: fingerprint.mean };
          } else {
            freshThumb = thumb;
            let read = { text: '', confidence: 0 };
            let ocrFailed = false;
            try {
              const frameBudget = Math.max(500, Math.min(knobs.frameBudgetMs, deadline - now()));
              const answer = await withTimeout(
                ocr(extracted.buffer, { budgetMs: frameBudget, signal, t: frame.t }),
                Math.max(1000, frameBudget + knobs.ocrStartupGraceMs),
              );
              if (answer === TIMED_OUT) ocrFailed = true;
              else read = answer || read;
            } catch (_) {
              ocrFailed = true;
            }
            if (signal && signal.aborted) { stopReason = 'aborted'; break; }
            if (ocrFailed) {
              // Not checkpointed: a resume must try this frame again.
              ocrFailures += 1;
              out.framesSkipped += 1;
              stats.ocrFailed += 1;
              records.push({ i: frame.i, t: frame.t, status: 'ocr_failed' });
              if (ocrFailures >= 2) { stopReason = 'ocr_unavailable'; break; }
              continue;
            }
            ocrFailures = 0;
            let text = cleanOcrText(read.text);
            let confidence = normalizeConfidence(read.confidence);
            let engine = 'tesseract';
            // A blurry slide can come back as junk lines only: the raw read
            // still says «there is text here» and deserves a second look.
            const weak = (usefulChars(text) >= 6 || usefulChars(read.text) >= 15) && confidence < knobs.lowConfidence;
            if (weak && !escalationOff && out.escalationAttempts < knobs.maxEscalations
              && deadline - now() >= knobs.escalateMinRemainingMs) {
              out.escalationAttempts += 1;
              let escalated = null;
              try {
                escalated = await withTimeout(
                  escalate(extracted.buffer, { tesseract: { text, confidence }, cloud: knobs.cloudVision, signal }),
                  Math.max(1000, Math.min(knobs.escalateTimeoutMs, deadline - now())),
                );
                if (escalated === TIMED_OUT) escalated = { failed: true };
              } catch (_) {
                escalated = { failed: true };
              }
              if (!escalated || escalated.unavailable) {
                escalationOff = true; // rung off: stop asking for this job
              } else if (escalated.failed) {
                escalationFailures += 1;
                if (escalationFailures >= 2) escalationOff = true;
              } else {
                escalationFailures = 0;
                const gated = gateEscalatedText(escalated.text, text);
                if (gated.ok) {
                  out.escalated += 1;
                  text = gated.text;
                  confidence = Math.max(confidence, normalizeConfidence(escalated.confidence) || 0.8);
                  engine = escalated.engine || 'vision';
                }
              }
            }
            if (usefulChars(text) < 3) {
              rec = { i: frame.i, t: frame.t, status: 'empty', ...prints };
            } else if (confidence >= knobs.minItemConfidence) {
              rec = { i: frame.i, t: frame.t, status: 'read', text, confidence: round3(confidence), engine, ...prints };
            } else if (wordlikeTokens(text) >= 3) {
              rec = { i: frame.i, t: frame.t, status: 'read', text: ILLEGIBLE, confidence: round3(confidence), engine, ...prints };
            } else {
              rec = { i: frame.i, t: frame.t, status: 'empty', ...prints };
            }
          }
        }
        // A frame that only timed out is retried on resume.
        if (ckpt && !rec.transient) await ckpt.writeFrame(rec, freshThumb);
      }
      if (rec.status === 'read' || rec.status === 'empty') {
        out.framesRead += 1;
        if (rec.hash) {
          lastRead = {
            i: rec.i, hash: rec.hash, mean: rec.mean, thumb: freshThumb, thumbW: rec.thumbW || null, thumbH: rec.thumbH || null,
          };
        } else {
          lastRead = null; // unknown picture: the next frame is read
        }
        if (rec.text === ILLEGIBLE) out.illegibleFrames += 1;
        if (rec.status === 'empty') stats.empty += 1;
      } else {
        out.framesSkipped += 1;
        if (rec.status === 'duplicate') stats.duplicates += 1;
        else stats.extractFailed += 1;
      }
      records.push(rec);
      if (extractFailures >= MAX_CONSECUTIVE_EXTRACT_FAILURES) { stopReason = 'extract_failing'; break; }
    }

    out.items = mergeFrameRecords(records, { durationSec, mergeSimilarity: knobs.mergeSimilarity });
    if (stopReason === 'aborted') return finish({ ok: false, partial: true, reason: 'aborted' });
    if ((stopReason === 'ocr_unavailable' || stopReason === 'extract_failing') && out.framesRead === 0) {
      return finish({ ok: false, partial: true, reason: stopReason === 'extract_failing' ? 'no_frames' : 'ocr_unavailable' });
    }
    const partial = Boolean(stopReason) || detectionPartial;
    const fields = { ok: true, partial };
    if (stopReason) fields.reason = stopReason;
    else if (detectionPartial) fields.reason = 'detection_timeout';
    if (plan.fallback) fields.sampling = plan.fallback;
    if (plan.capped) fields.capped = true;
    fields.framesDuplicate = stats.duplicates;
    fields.framesFailed = stats.extractFailed + stats.ocrFailed;
    if (stats.extractFailed > 0 && stats.extractFailed === records.length) return finish({ ok: false, reason: 'no_frames' });
    return finish(fields);
  } catch (err) {
    try { logger.warn(`[video-onscreen-text] internal error (${(err && (err.code || err.name)) || 'error'})`); } catch (_) { /* best-effort */ }
    return finish({ ok: false, reason: 'internal_error' });
  }
}

module.exports = {
  extractOnScreenText,
  // Pure helpers (tests, the queue's cross-checks).
  planFrameTimes,
  mergeFrameRecords,
  dHash,
  frameFingerprint,
  hammingHex,
  thumbChangedPixels,
  isCoarseDuplicate,
  isDuplicateFrame,
  cleanOcrText,
  textSimilarity,
  gateEscalatedText,
  looksLikeLoop,
  normalizeConfidence,
  resolveOptions,
  ILLEGIBLE,
  CHECKPOINT_VERSION,
};
