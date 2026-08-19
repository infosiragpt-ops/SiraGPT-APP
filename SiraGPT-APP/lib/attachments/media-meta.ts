/**
 * Best-effort browser media metadata extraction for chat attachments.
 *
 * Every async extractor degrades to `null` silently when the required
 * browser APIs are missing (SSR, jsdom), when decoding fails, or when the
 * operation exceeds the configured timeout. Callers can treat `null` as
 * "no preview available" without any error handling.
 */

export interface AudioMeta {
  durationSeconds: number;
  /** Per-bucket max-abs amplitude of channel 0, normalized to 0..1. */
  peaks: number[];
}

export interface VideoMeta {
  durationSeconds: number;
  /** JPEG data URL of a representative frame, or null when capture failed. */
  thumbnailDataUrl: string | null;
}

export interface ExtractAudioMetaOptions {
  /** Number of waveform buckets to compute (default 48). */
  buckets?: number;
  /** Max time to wait before giving up (default 8000 ms). */
  timeoutMs?: number;
}

export interface ExtractVideoMetaOptions {
  /** Max time to wait before giving up (default 8000 ms). */
  timeoutMs?: number;
  /** Max thumbnail width in pixels (default 320). */
  thumbnailMaxWidth?: number;
}

const DEFAULT_BUCKETS = 48;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_THUMBNAIL_MAX_WIDTH = 320;
const MIN_BAR_HEIGHT_PX = 2;

interface AudioBufferLike {
  duration: number;
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

interface AudioContextLike {
  decodeAudioData(
    data: ArrayBuffer,
    onSuccess?: (buffer: AudioBufferLike) => void,
    onError?: (error: unknown) => void,
  ): Promise<AudioBufferLike> | void;
  close?: () => Promise<void> | void;
}

type AudioContextCtorLike = new (...args: number[]) => AudioContextLike;

interface ObjectUrlApiLike {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

/** Timeout helper that resolves to null after `ms` and supports cancellation. */
function nullAfter(ms: number): { promise: Promise<null>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<null>((resolve) => {
    id = setTimeout(() => resolve(null), ms);
  });
  return {
    promise,
    cancel: () => {
      if (id !== undefined) clearTimeout(id);
    },
  };
}

function resolveAudioContextCtor(): { Ctor: AudioContextCtorLike; offline: boolean } | null {
  const g = globalThis as Record<string, unknown>;
  const live = g.AudioContext ?? g.webkitAudioContext;
  if (typeof live === 'function') {
    return { Ctor: live as AudioContextCtorLike, offline: false };
  }
  const offline = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (typeof offline === 'function') {
    return { Ctor: offline as AudioContextCtorLike, offline: true };
  }
  return null;
}

/** Supports both the promise-based and the legacy callback-based decodeAudioData. */
function decodeAudio(ctx: AudioContextLike, data: ArrayBuffer): Promise<AudioBufferLike> {
  return new Promise<AudioBufferLike>((resolve, reject) => {
    try {
      const maybePromise = ctx.decodeAudioData(data, resolve, reject);
      if (maybePromise && typeof (maybePromise as Promise<AudioBufferLike>).then === 'function') {
        (maybePromise as Promise<AudioBufferLike>).then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function computePeaks(channel: Float32Array, buckets: number): number[] {
  const count = Math.max(1, Math.floor(buckets));
  const peaks: number[] = new Array<number>(count).fill(0);
  if (channel.length === 0) return peaks;
  const bucketSize = channel.length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(channel.length, Math.max(start + 1, Math.floor((i + 1) * bucketSize)));
    let max = 0;
    for (let j = start; j < end; j++) {
      const value = Math.abs(channel[j] ?? 0);
      if (value > max) max = value;
    }
    peaks[i] = Math.min(1, max);
  }
  return peaks;
}

/**
 * Decode an audio file in the browser and compute duration + waveform peaks.
 * Resolves to `null` on missing Web Audio API, decode failure, or timeout.
 */
export async function extractAudioMeta(
  file: File,
  opts: ExtractAudioMetaOptions = {},
): Promise<AudioMeta | null> {
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const resolved = resolveAudioContextCtor();
  if (!resolved || !file || typeof file.arrayBuffer !== 'function') return null;

  let ctx: AudioContextLike | null = null;
  const timeout = nullAfter(timeoutMs);
  try {
    ctx = resolved.offline ? new resolved.Ctor(1, 1, 44100) : new resolved.Ctor();
    const audioCtx = ctx;
    const work: Promise<AudioMeta | null> = (async () => {
      const data = await file.arrayBuffer();
      const buffer = await decodeAudio(audioCtx, data);
      const duration =
        Number.isFinite(buffer.duration) && buffer.duration > 0
          ? buffer.duration
          : buffer.sampleRate > 0
            ? buffer.length / buffer.sampleRate
            : NaN;
      if (!Number.isFinite(duration) || duration < 0) return null;
      const channel =
        buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : new Float32Array(0);
      return { durationSeconds: duration, peaks: computePeaks(channel, buckets) };
    })();
    // Promise.race subscribes to both promises, so a late rejection of `work`
    // after the timeout wins is still considered handled (no unhandled rejection).
    return await Promise.race([work, timeout.promise]);
  } catch {
    return null;
  } finally {
    timeout.cancel();
    if (ctx && typeof ctx.close === 'function') {
      try {
        await ctx.close();
      } catch {
        // ignore close failures
      }
    }
  }
}

function captureVideoFrame(video: HTMLVideoElement, thumbnailMaxWidth: number): string | null {
  try {
    const sourceWidth = video.videoWidth || 0;
    const sourceHeight = video.videoHeight || 0;
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;
    const maxWidth = Number.isFinite(thumbnailMaxWidth)
      ? Math.max(1, Math.floor(thumbnailMaxWidth))
      : DEFAULT_THUMBNAIL_MAX_WIDTH;
    const width = Math.min(sourceWidth, maxWidth);
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return null;
    ctx2d.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

function loadVideoMeta(objectUrl: string, thumbnailMaxWidth: number): Promise<VideoMeta | null> {
  return new Promise<VideoMeta | null>((resolve) => {
    let video: HTMLVideoElement;
    try {
      video = document.createElement('video');
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const settle = (value: VideoMeta | null) => {
      if (settled) return;
      settled = true;
      try {
        video.removeAttribute('src');
      } catch {
        // ignore cleanup failures
      }
      resolve(value);
    };

    const capture = () => {
      const duration =
        Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : 0;
      settle({
        durationSeconds: duration,
        thumbnailDataUrl: captureVideoFrame(video, thumbnailMaxWidth),
      });
    };

    try {
      video.muted = true;
      try {
        video.playsInline = true;
      } catch {
        // older engines: attribute below is enough
      }
      video.setAttribute('playsinline', '');
      video.preload = 'metadata';

      video.addEventListener('error', () => settle(null));
      video.addEventListener('seeked', capture);
      video.addEventListener('loadeddata', () => {
        const duration = video.duration;
        const target =
          Number.isFinite(duration) && duration > 0 ? Math.min(0.5, duration / 10) : 0;
        if (target > 0) {
          try {
            video.currentTime = target;
            return; // wait for the 'seeked' event
          } catch {
            // seeking unsupported: capture the current frame
          }
        }
        capture();
      });

      video.src = objectUrl;
      if (typeof video.load === 'function') video.load();
    } catch {
      settle(null);
    }
  });
}

/**
 * Load a video file in an off-DOM <video> element and capture duration +
 * a JPEG thumbnail. Resolves to `null` on missing APIs, failure, or timeout.
 */
export async function extractVideoMeta(
  file: File,
  opts: ExtractVideoMetaOptions = {},
): Promise<VideoMeta | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const thumbnailMaxWidth = opts.thumbnailMaxWidth ?? DEFAULT_THUMBNAIL_MAX_WIDTH;

  if (!file) return null;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }
  const urlApi = (globalThis as { URL?: ObjectUrlApiLike }).URL;
  if (
    !urlApi ||
    typeof urlApi.createObjectURL !== 'function' ||
    typeof urlApi.revokeObjectURL !== 'function'
  ) {
    return null;
  }

  let objectUrl: string | null = null;
  const timeout = nullAfter(timeoutMs);
  try {
    objectUrl = urlApi.createObjectURL(file);
    const work = loadVideoMeta(objectUrl, thumbnailMaxWidth);
    return await Promise.race([work, timeout.promise]);
  } catch {
    return null;
  } finally {
    timeout.cancel();
    if (objectUrl !== null) {
      try {
        urlApi.revokeObjectURL(objectUrl);
      } catch {
        // ignore revoke failures
      }
    }
  }
}

/**
 * Format a duration in seconds as a compact clock label:
 * 7 → '0:07', 222 → '3:42', 3729 → '1:02:09'.
 */
export function formatMediaDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Map normalized peaks (0..1) to integer pixel bar heights, clamped to a
 * minimum of 2px so silent buckets stay visible. Pure function.
 */
export function buildPeakBars(peaks: number[], height: number): number[] {
  const maxHeight = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  return peaks.map((peak) => {
    const clamped = Number.isFinite(peak) ? Math.min(1, Math.max(0, peak)) : 0;
    return Math.max(MIN_BAR_HEIGHT_PX, Math.round(clamped * maxHeight));
  });
}
