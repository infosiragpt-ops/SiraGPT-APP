'use strict';

/**
 * video-duration-planner — parses user video durations in seconds OR minutes
 * ("30 segundos", "1 minuto", "2 min 30 s", "1:30") and plans seamless
 * multi-segment chained image-to-video generation when the requested duration
 * exceeds a single provider clip cap.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MIN_VIDEO_DURATION_SECONDS = 3;
const MAX_EXTENDED_DURATION_SECONDS = 300; // 5 minutes cap
const MAX_CHAINED_SEGMENTS = 12;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse requested video duration in seconds from explicit `targetDuration` or
 * natural-language Spanish/English prompt text ("30s", "1 minuto", "1:30",
 * "2 minutos y medio", "medio minuto").
 * Returns integer seconds clamped to [3, 300], or null when none detected.
 */
function parseRequestedVideoDurationSeconds(prompt, explicitTargetDuration = null) {
  const explicit = Number(explicitTargetDuration);
  if (Number.isFinite(explicit) && explicit >= MIN_VIDEO_DURATION_SECONDS) {
    return Math.min(MAX_EXTENDED_DURATION_SECONDS, Math.max(MIN_VIDEO_DURATION_SECONDS, Math.round(explicit)));
  }

  const text = normalizeText(prompt);
  if (!text) return null;

  // "medio minuto" / "half a minute"
  if (/\b(?:medio\s+minuto|half\s+(?:a\s+)?minute)\b/.test(text)) {
    return 30;
  }

  // "MM:SS" notation when paired with video/duracion/clip context
  const clockMatch = text.match(/\b(?:de|duracion(?:\s+de)?|dura|video\s+de|clip\s+de|for|length)?\s*(\d{1,2}):([0-5]\d)\b/);
  if (clockMatch && /\b(?:video|clip|duracion|dura|minuto|segundo|animacion|escena|convertir|hazlo|de\s+\d{1,2}:)\b/.test(text)) {
    const mins = Number.parseInt(clockMatch[1], 10);
    const secs = Number.parseInt(clockMatch[2], 10);
    const total = mins * 60 + secs;
    if (total >= MIN_VIDEO_DURATION_SECONDS && total <= MAX_EXTENDED_DURATION_SECONDS) {
      return total;
    }
  }

  // "X minutos y medio" / "X.5 minutos" / "X min Y seg"
  const minAndHalf = text.match(/\b(\d{1,2})\s*(?:minutos?|mins?|minutes?)\s*(?:y\s+medio|and\s+a\s+half)\b/);
  if (minAndHalf) {
    const total = Number.parseInt(minAndHalf[1], 10) * 60 + 30;
    return Math.min(MAX_EXTENDED_DURATION_SECONDS, Math.max(MIN_VIDEO_DURATION_SECONDS, total));
  }

  const minAndSec = text.match(/\b(\d{1,2})\s*(?:minutos?|mins?|minutes?)\s*(?:y\s+|con\s+|and\s+)?(\d{1,2})\s*(?:segundos?|segs?|seconds?|s)\b/);
  if (minAndSec) {
    const total = Number.parseInt(minAndSec[1], 10) * 60 + Number.parseInt(minAndSec[2], 10);
    return Math.min(MAX_EXTENDED_DURATION_SECONDS, Math.max(MIN_VIDEO_DURATION_SECONDS, total));
  }

  // Decimal or integer minutes: "1 minuto", "2 min", "1.5 minutos", "un minuto"
  if (/\b(?:un|uno|1)\s*(?:minuto|min|minute)\b/.test(text)) {
    return 60;
  }
  const minOnly = text.match(/\b(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:minutos?|mins?|minutes?)\b/);
  if (minOnly) {
    const mins = Number.parseFloat(minOnly[1].replace(',', '.'));
    if (Number.isFinite(mins) && mins > 0) {
      return Math.min(MAX_EXTENDED_DURATION_SECONDS, Math.max(MIN_VIDEO_DURATION_SECONDS, Math.round(mins * 60)));
    }
  }

  // Explicit seconds: "30 segundos", "45 seg", "20s"
  const secOnly = text.match(/\b(\d{1,3})\s*(?:segundos?|segs?|seconds?|s)\b/);
  if (secOnly) {
    const secs = Number.parseInt(secOnly[1], 10);
    if (Number.isFinite(secs) && secs >= MIN_VIDEO_DURATION_SECONDS) {
      return Math.min(MAX_EXTENDED_DURATION_SECONDS, secs);
    }
  }

  return null;
}

/**
 * Format seconds cleanly in Spanish ("8 s", "30 s", "1 min", "1 min 30 s").
 */
function formatDurationLabelEs(totalSeconds) {
  const s = Math.max(1, Math.round(Number(totalSeconds) || 0));
  if (s < 60) return `${s} s`;
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  if (rem === 0) return `${mins} min`;
  return `${mins} min ${rem} s`;
}

/**
 * Plan sequential chained segments when `targetDurationSeconds` exceeds a
 * single clip's valid duration.
 */
function planVideoSegments({
  targetDurationSeconds,
  clipDurationSeconds = 8,
  prompt = '',
  isImageToVideo = false,
} = {}) {
  const clipSec = Math.max(3, Math.min(30, Math.round(Number(clipDurationSeconds) || 8)));
  const rawTarget = Number(targetDurationSeconds);
  const targetSec = Number.isFinite(rawTarget) && rawTarget > clipSec
    ? Math.min(MAX_EXTENDED_DURATION_SECONDS, Math.round(rawTarget))
    : clipSec;

  if (targetSec <= clipSec) {
    return {
      isMultiSegment: false,
      segmentCount: 1,
      clipDurationSeconds: clipSec,
      requestedDurationSeconds: targetSec,
      plannedDurationSeconds: clipSec,
      label: formatDurationLabelEs(clipSec),
      segments: [{
        index: 0,
        total: 1,
        startSecond: 0,
        endSecond: clipSec,
        durationSeconds: clipSec,
        prompt: String(prompt || '').trim(),
      }],
    };
  }

  const rawCount = Math.ceil(targetSec / clipSec);
  const segmentCount = Math.max(2, Math.min(MAX_CHAINED_SEGMENTS, rawCount));
  const plannedDurationSeconds = segmentCount * clipSec;
  const cleanPrompt = String(prompt || '').trim();

  const segments = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const startSecond = i * clipSec;
    const endSecond = (i + 1) * clipSec;
    const phaseCue = i === 0
      ? (isImageToVideo
        ? `Scene 1/${segmentCount} (${startSecond}s-${endSecond}s): Opening beat anchored strictly to the input image; smooth natural entrance motion.`
        : `Scene 1/${segmentCount} (${startSecond}s-${endSecond}s): Opening establishing beat with coherent motion.`)
      : i === segmentCount - 1
        ? `Scene ${i + 1}/${segmentCount} (${startSecond}s-${endSecond}s): Seamless continuation from the exact last frame of scene ${i}; graceful closing beat maintaining identical subject, wardrobe, palette, lighting, and environment.`
        : `Scene ${i + 1}/${segmentCount} (${startSecond}s-${endSecond}s): Seamless continuation from the exact last frame of scene ${i}; fluid progressive motion maintaining identical subject identity, lighting, camera style, and scene continuity.`;

    segments.push({
      index: i,
      total: segmentCount,
      startSecond,
      endSecond,
      durationSeconds: clipSec,
      prompt: `${cleanPrompt}\n\n${phaseCue}`.trim().slice(0, 1200),
    });
  }

  return {
    isMultiSegment: true,
    segmentCount,
    clipDurationSeconds: clipSec,
    requestedDurationSeconds: targetSec,
    plannedDurationSeconds,
    label: formatDurationLabelEs(plannedDurationSeconds),
    segments,
  };
}

let cachedFfmpegAvailable = null;

async function isFfmpegAvailable() {
  if (cachedFfmpegAvailable !== null) return cachedFfmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 4000 });
    cachedFfmpegAvailable = true;
  } catch {
    cachedFfmpegAvailable = false;
  }
  return cachedFfmpegAvailable;
}

/**
 * Extract the last frame of an MP4 buffer as a PNG buffer using ffmpeg so the
 * next video segment chains seamlessly via image-to-video.
 */
async function extractLastFramePng(mp4Buffer) {
  if (!Buffer.isBuffer(mp4Buffer) || !mp4Buffer.length) return null;
  if (!(await isFfmpegAvailable())) return null;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sira-vid-frame-'));
  const inPath = path.join(tmpDir, 'clip.mp4');
  const outPath = path.join(tmpDir, 'last.png');
  try {
    await fs.promises.writeFile(inPath, mp4Buffer);
    await execFileAsync('ffmpeg', [
      '-y',
      '-sseof', '-0.12',
      '-i', inPath,
      '-update', '1',
      '-frames:v', '1',
      outPath,
    ], { timeout: 25000 });
    if (fs.existsSync(outPath)) {
      const png = await fs.promises.readFile(outPath);
      return png.length > 0 ? png : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Concatenate an array of MP4 buffers into one seamless MP4 buffer via ffmpeg.
 * Attempts stream-copy concat first (instant, zero quality loss) and falls back
 * to normalized H.264/AAC re-encode if clip parameters differ.
 */
async function concatVideoBuffers(mp4Buffers) {
  if (!Array.isArray(mp4Buffers) || mp4Buffers.length === 0) return null;
  if (mp4Buffers.length === 1) return mp4Buffers[0];
  if (!(await isFfmpegAvailable())) return mp4Buffers[0];

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sira-vid-concat-'));
  const listPath = path.join(tmpDir, 'clips.txt');
  const outPath = path.join(tmpDir, 'merged.mp4');
  try {
    const lines = [];
    for (let i = 0; i < mp4Buffers.length; i += 1) {
      const segPath = path.join(tmpDir, `seg_${String(i).padStart(2, '0')}.mp4`);
      await fs.promises.writeFile(segPath, mp4Buffers[i]);
      lines.push(`file '${segPath.replace(/'/g, "'\\''")}'`);
    }
    await fs.promises.writeFile(listPath, lines.join('\n'), 'utf8');

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outPath,
      ], { timeout: 60000 });
    } catch {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outPath,
      ], { timeout: 120000 });
    }

    if (fs.existsSync(outPath)) {
      const merged = await fs.promises.readFile(outPath);
      if (merged.length > 0) return merged;
    }
    return mp4Buffers[0];
  } catch {
    return mp4Buffers[0];
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  MIN_VIDEO_DURATION_SECONDS,
  MAX_EXTENDED_DURATION_SECONDS,
  MAX_CHAINED_SEGMENTS,
  parseRequestedVideoDurationSeconds,
  formatDurationLabelEs,
  planVideoSegments,
  isFfmpegAvailable,
  extractLastFramePng,
  concatVideoBuffers,
};
