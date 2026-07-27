'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_FRAME_COUNT = 6;
const MAX_SPECTROGRAM_SECONDS = 120;

const AUDIO_EXTENSIONS = new Set([
  'aac', 'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'opus', 'wav', 'webm',
]);
const VIDEO_EXTENSIONS = new Set([
  'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm',
]);
const SPECTROGRAM_STYLES = new Set([
  'channel', 'intensity', 'magma', 'plasma', 'rainbow', 'viridis',
]);

function mediaError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw mediaError('media processing was cancelled', 'MEDIA_ABORTED');
}

function extensionFor(record) {
  const name = String(record?.originalName || record?.filename || '');
  return path.extname(name).slice(1).toLowerCase();
}

function mediaKindsFor(record) {
  const mime = String(record?.mimeType || '').toLowerCase();
  const ext = extensionFor(record);
  const kinds = new Set();
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) kinds.add('audio');
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) kinds.add('video');
  return kinds;
}

function safeSourceMetadata(record, actualSize) {
  return {
    fileId: String(record.id),
    filename: String(record.originalName || record.filename || 'media'),
    mimeType: String(record.mimeType || 'application/octet-stream'),
    sizeBytes: Number(actualSize || record.size || 0),
  };
}

function normalizeCandidateIds(fileId, ctx) {
  const explicit = String(fileId || '').trim();
  if (explicit) return { ids: [explicit], explicit: true };
  const ids = Array.isArray(ctx?.fileIds)
    ? [...new Set(ctx.fileIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  return { ids, explicit: false };
}

async function findOwnedRecord(prisma, ids, userId, explicit) {
  if (!ids.length) return null;
  const where = { userId: String(userId), deletedAt: null };
  if (explicit) {
    return prisma.file.findFirst({ where: { ...where, id: ids[0] } });
  }
  const records = await prisma.file.findMany({ where: { ...where, id: { in: ids } } });
  const byId = new Map((records || []).map((record) => [String(record.id), record]));
  return ids.map((id) => byId.get(id)).find(Boolean) || null;
}

async function resolveOwnedMediaSource(options = {}, ctx = {}) {
  throwIfAborted(ctx.signal);
  if (!ctx.userId) {
    throw mediaError('media processing requires an authenticated user', 'MEDIA_USER_REQUIRED');
  }

  const prisma = ctx.prisma || require('../../config/database');
  if (!prisma?.file?.findFirst || !prisma?.file?.findMany) {
    throw mediaError('media file storage is unavailable', 'MEDIA_STORAGE_UNAVAILABLE');
  }

  const { ids, explicit } = normalizeCandidateIds(options.fileId, ctx);
  if (!ids.length) {
    throw mediaError('attach a media file or provide its file id', 'MEDIA_FILE_REQUIRED');
  }

  let record;
  if (explicit) {
    record = await findOwnedRecord(prisma, ids, ctx.userId, true);
  } else {
    const where = { userId: String(ctx.userId), deletedAt: null, id: { in: ids } };
    const records = await prisma.file.findMany({ where });
    const byId = new Map((records || []).map((entry) => [String(entry.id), entry]));
    const allowedKinds = new Set(options.allowedKinds || ['audio', 'video']);
    record = ids
      .map((id) => byId.get(id))
      .find((entry) => entry && [...mediaKindsFor(entry)].some((kind) => allowedKinds.has(kind)));
  }

  if (!record || !record.path) {
    throw mediaError('the requested media file was not found', 'MEDIA_FILE_NOT_FOUND');
  }

  const allowedKinds = new Set(options.allowedKinds || ['audio', 'video']);
  const kinds = mediaKindsFor(record);
  if (![...kinds].some((kind) => allowedKinds.has(kind))) {
    throw mediaError('the selected file is not a supported media type', 'MEDIA_TYPE_UNSUPPORTED');
  }

  const maxSourceBytes = Number(options.maxSourceBytes || DEFAULT_MAX_SOURCE_BYTES);
  if (Number(record.size || 0) > maxSourceBytes) {
    throw mediaError('the selected media file exceeds the processing size limit', 'MEDIA_SOURCE_TOO_LARGE', {
      maxSourceBytes,
    });
  }

  const objectStorage = ctx.objectStorage || require('../object-storage');
  const materialized = await objectStorage.toLocalTemp(record.path);
  try {
    throwIfAborted(ctx.signal);
    const stat = await fs.promises.stat(materialized.path);
    if (!stat.isFile()) {
      throw mediaError('the selected media source is not a regular file', 'MEDIA_SOURCE_INVALID');
    }
    if (stat.size > maxSourceBytes) {
      throw mediaError('the selected media file exceeds the processing size limit', 'MEDIA_SOURCE_TOO_LARGE', {
        maxSourceBytes,
      });
    }
    return {
      record,
      localPath: materialized.path,
      kinds: [...kinds],
      source: safeSourceMetadata(record, stat.size),
      cleanup: async () => {
        try { await materialized.cleanup?.(); } catch { /* best effort */ }
      },
    };
  } catch (error) {
    try { await materialized.cleanup?.(); } catch { /* best effort */ }
    throw error;
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function runProcess(command, args, options = {}) {
  const timeoutMs = boundedInteger(options.timeoutMs, 45_000, 100, 180_000);
  const maxOutputBytes = boundedInteger(
    options.maxOutputBytes,
    MAX_PROCESS_OUTPUT_BYTES,
    1024,
    4 * 1024 * 1024,
  );
  const spawnImpl = options.spawnImpl || spawn;

  return new Promise((resolve, reject) => {
    throwIfAborted(options.signal);
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let child;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const stop = () => {
      try { child?.kill('SIGKILL'); } catch { /* best effort */ }
    };
    const fail = (message, code, extra = {}) => {
      stop();
      settle(reject, mediaError(message, code, extra));
    };
    const append = (bucket, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        fail('media process produced too much diagnostic output', 'MEDIA_PROCESS_OUTPUT_LIMIT');
        return;
      }
      bucket.push(buffer);
    };
    const onAbort = () => fail('media processing was cancelled', 'MEDIA_ABORTED');
    const timer = setTimeout(() => {
      fail('media processing exceeded its time limit', 'MEDIA_PROCESS_TIMEOUT');
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawnImpl(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle(reject, mediaError('media processing tool could not start', 'MEDIA_TOOL_UNAVAILABLE', {
        cause: error,
      }));
      return;
    }

    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    child.stdout?.on('data', (chunk) => append(stdout, chunk));
    child.stderr?.on('data', (chunk) => append(stderr, chunk));
    child.once('error', (error) => {
      settle(reject, mediaError('media processing tool is unavailable', 'MEDIA_TOOL_UNAVAILABLE', {
        cause: error,
      }));
    });
    child.once('close', (code) => {
      if (settled) return;
      const stderrText = Buffer.concat(stderr).toString('utf8').slice(-2000);
      if (code !== 0) {
        settle(reject, mediaError('media processing failed', 'MEDIA_PROCESS_FAILED', {
          exitCode: code,
          diagnostics: stderrText,
        }));
        return;
      }
      settle(resolve, {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function summarizeProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const durationSeconds = Number.parseFloat(probe?.format?.duration);
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    format: String(probe?.format?.format_name || '').split(',')[0] || null,
    video: video ? {
      codec: video.codec_name || null,
      width: Number(video.width) || null,
      height: Number(video.height) || null,
    } : null,
    audio: audio ? {
      codec: audio.codec_name || null,
      sampleRate: Number(audio.sample_rate) || null,
      channels: Number(audio.channels) || null,
    } : null,
  };
}

async function probeMedia(localPath, ctx = {}) {
  const result = await runProcess(ctx.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=duration,format_name,size:stream=index,codec_type,codec_name,width,height,sample_rate,channels',
    '-of', 'json',
    localPath,
  ], {
    signal: ctx.signal,
    timeoutMs: ctx.probeTimeoutMs || 30_000,
    spawnImpl: ctx.spawnImpl,
  });
  try {
    return JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw mediaError('media metadata could not be read', 'MEDIA_PROBE_INVALID');
  }
}

function buildFrameTimestamps({ timestamps, count, durationSeconds }) {
  const duration = Number(durationSeconds);
  const maxTimestamp = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.01) : null;
  const supplied = Array.isArray(timestamps)
    ? timestamps.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  const desiredCount = boundedInteger(count, supplied.length || 1, 1, MAX_FRAME_COUNT);
  let values = supplied.slice(0, MAX_FRAME_COUNT);
  if (!values.length) {
    if (maxTimestamp == null || desiredCount === 1) values = [0];
    else values = Array.from({ length: desiredCount }, (_, index) => (
      ((index + 1) * duration) / (desiredCount + 1)
    ));
  }
  const normalized = values.map((value) => (
    maxTimestamp == null ? Math.max(0, value) : Math.min(maxTimestamp, Math.max(0, value))
  ));
  return [...new Set(normalized.map((value) => Number(value.toFixed(3))))].slice(0, MAX_FRAME_COUNT);
}

function cleanBaseName(filename, fallback) {
  const base = path.basename(String(filename || fallback), path.extname(String(filename || '')));
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 72) || fallback;
}

async function assertArtifactFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw mediaError('media processing produced an empty artifact', 'MEDIA_ARTIFACT_EMPTY');
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw mediaError('media artifact exceeds the output size limit', 'MEDIA_ARTIFACT_TOO_LARGE');
  }
  return stat;
}

async function extractVideoFrames(args = {}, ctx = {}) {
  const source = await resolveOwnedMediaSource({
    fileId: args.fileId,
    allowedKinds: ['video'],
  }, ctx);
  let tempDir = null;
  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'siragpt-frames-'));
    const probe = await probeMedia(source.localPath, ctx);
    const media = summarizeProbe(probe);
    if (!media.video) {
      throw mediaError('the selected file has no video stream', 'MEDIA_VIDEO_STREAM_MISSING');
    }
    const timestamps = buildFrameTimestamps({
      timestamps: args.timestamps,
      count: args.count,
      durationSeconds: media.durationSeconds,
    });
    const width = boundedInteger(args.width, 1280, 320, 1920);
    const format = args.format === 'png' ? 'png' : 'jpg';
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const ffmpegPath = ctx.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    const baseName = cleanBaseName(source.source.filename, 'video');
    const frames = [];

    for (let index = 0; index < timestamps.length; index += 1) {
      throwIfAborted(ctx.signal);
      const timestamp = timestamps[index];
      const outputPath = path.join(tempDir, `frame-${index + 1}.${format}`);
      await runProcess(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', String(timestamp),
        '-i', source.localPath,
        '-map_metadata', '-1', '-an', '-frames:v', '1',
        '-vf', `scale=${width}:-2:force_original_aspect_ratio=decrease`,
        '-threads', '1',
        outputPath,
      ], {
        signal: ctx.signal,
        timeoutMs: ctx.frameTimeoutMs || 45_000,
        spawnImpl: ctx.spawnImpl,
      });
      const stat = await assertArtifactFile(outputPath);
      frames.push({
        filename: `${baseName}-frame-${index + 1}-at-${timestamp.toFixed(3)}s.${format}`,
        mime,
        sizeBytes: stat.size,
        timestampSeconds: timestamp,
        buffer: await fs.promises.readFile(outputPath),
      });
    }

    return { source: source.source, media, frames };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
    await source.cleanup();
  }
}

async function createAudioSpectrogram(args = {}, ctx = {}) {
  const source = await resolveOwnedMediaSource({
    fileId: args.fileId,
    allowedKinds: ['audio', 'video'],
  }, ctx);
  let tempDir = null;
  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'siragpt-spectrogram-'));
    const probe = await probeMedia(source.localPath, ctx);
    const media = summarizeProbe(probe);
    if (!media.audio) {
      throw mediaError('the selected file has no audio stream', 'MEDIA_AUDIO_STREAM_MISSING');
    }
    const maxStart = media.durationSeconds == null
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, media.durationSeconds - 0.01);
    const startSeconds = boundedNumber(args.startSeconds, 0, 0, maxStart);
    const available = media.durationSeconds == null
      ? MAX_SPECTROGRAM_SECONDS
      : Math.max(0.1, media.durationSeconds - startSeconds);
    const durationSeconds = boundedNumber(
      args.durationSeconds,
      Math.min(30, available),
      0.1,
      Math.min(MAX_SPECTROGRAM_SECONDS, available),
    );
    const width = boundedInteger(args.width, 1280, 640, 1600);
    const height = boundedInteger(args.height, 640, 320, 1000);
    const style = SPECTROGRAM_STYLES.has(args.style) ? args.style : 'magma';
    const outputPath = path.join(tempDir, 'spectrogram.png');
    const ffmpegPath = ctx.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';

    await runProcess(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', String(startSeconds), '-t', String(durationSeconds),
      '-i', source.localPath,
      '-map_metadata', '-1',
      '-filter_complex', `showspectrumpic=s=${width}x${height}:legend=1:color=${style}:scale=log`,
      '-frames:v', '1', '-threads', '1',
      outputPath,
    ], {
      signal: ctx.signal,
      timeoutMs: ctx.spectrogramTimeoutMs || 90_000,
      spawnImpl: ctx.spawnImpl,
    });
    const stat = await assertArtifactFile(outputPath);
    const baseName = cleanBaseName(source.source.filename, 'audio');
    return {
      source: source.source,
      media,
      spectrogram: {
        filename: `${baseName}-spectrogram.png`,
        mime: 'image/png',
        sizeBytes: stat.size,
        startSeconds,
        durationSeconds,
        width,
        height,
        style,
        buffer: await fs.promises.readFile(outputPath),
      },
    };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
    await source.cleanup();
  }
}

module.exports = {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  SPECTROGRAM_STYLES,
  DEFAULT_MAX_SOURCE_BYTES,
  MAX_FRAME_COUNT,
  MAX_SPECTROGRAM_SECONDS,
  mediaKindsFor,
  resolveOwnedMediaSource,
  runProcess,
  probeMedia,
  summarizeProbe,
  buildFrameTimestamps,
  extractVideoFrames,
  createAudioSpectrogram,
};
