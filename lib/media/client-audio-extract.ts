/**
 * Client-side audio extraction for transcription uploads.
 *
 * What makes a WhatsApp upload feel instant is not a faster network: the
 * phone never sends the original. For transcription only the audio matters,
 * so a 10-hour 1080p recording (≈ 3 GB) becomes ≈ 108 MB of 24 kbps mono
 * Opus in the browser before the first byte leaves the machine; 100 such
 * files go from ≈ 300 GB to ≈ 11 GB. The decode/encode happens in WebCodecs
 * through mediabunny (MPL-2.0, dynamically imported: nothing loads until a
 * media file is attached).
 *
 * Tiers, best first:
 *   - `opus`: decode + re-encode to Opus 16 kHz mono (WebCodecs encoder).
 *   - `copy`: the browser cannot encode Opus (older Safari): the audio track
 *     is copied as-is into an audio-only container — the video track is what
 *     weighs — so a 3 GB MP4 still becomes ≈ 500 MB of AAC.
 *   - `none`: nothing usable here (no audio track, unreadable file, no gain,
 *     a duration that does not match): the ORIGINAL file is uploaded, as
 *     before. Extraction never loses a recording.
 *
 * Every outcome is verified before it replaces the original: the extracted
 * file must hold an audio track whose duration matches the source's. The
 * original also goes as it is when its audio starts after the video (the
 * server keeps that lead on the transcript clock), when the track is silent
 * (the server falls back to subtitles and on-screen text, which need the
 * video), and while a video tool is open (the caller does not prepare then).
 * Only the primary audio track is converted. Below the video threshold
 * (100 MB) the original is uploaded: the saving is small there and the server
 * keeps every video feature (frames, embedded subtitles, video references).
 */

import type { AudioSample, InputAudioTrack } from "mediabunny"
import { isMediaUpload } from "../attachment-ingest"

export type ExtractionTier = "opus" | "copy" | "none"

export type MediabunnyModule = typeof import("mediabunny")

type MediabunnyConversion = Awaited<ReturnType<MediabunnyModule["Conversion"]["init"]>>

export type ExtractionProgress = {
  phase: "probing" | "converting" | "verifying"
  /** 0–1 within the phase (conversion: fraction of the input processed). */
  progress: number
  processedSeconds?: number
}

export type ExtractionSource = {
  sourceName: string
  sourceSize: number
  sourceType: string
}

export type ExtractedAudio = ExtractionSource & {
  tier: "opus" | "copy"
  file: File
  codec: string | null
  durationSeconds: number | null
  bytesSaved: number
  ms: number
}

export type ExtractionSkipped = ExtractionSource & { tier: "none"; reason: string }

export type ExtractionOutcome = ExtractedAudio | ExtractionSkipped

/** The metadata the upload carries so the server knows what it received. */
export type ClientExtractedMetadata = {
  tier: "opus" | "copy"
  sourceName: string
  sourceSize: number
  sourceType: string
  codec: string | null
  durationSeconds: number | null
}

export type ExtractOptions = {
  signal?: AbortSignal
  onProgress?: (progress: ExtractionProgress) => void
  /** Test seam: the mediabunny module (default: dynamic import). */
  loadMediabunny?: () => Promise<MediabunnyModule>
  env?: Record<string, string | undefined>
  now?: () => number
  /** A `copy` whose source is larger than this is not attempted (it would sit in memory). */
  maxCopySourceBytes?: number
  /** Below this fraction of bytes saved the original is uploaded instead. */
  minSavingsRatio?: number
  /** A video shorter than this many seconds keeps the original (default CLIENT_AUDIO_EXTRACT_MIN_VIDEO_SECONDS). */
  minVideoSeconds?: number
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MB = 1024 * 1024

/** Opus for speech: mono, 16 kHz (what every STT engine resamples to anyway), 24 kbps. */
export const OPUS_TARGET = Object.freeze({ codec: "opus" as const, numberOfChannels: 1, sampleRate: 16_000, bitrate: 24_000 })

/**
 * Videos from this size on are worth extracting (the saving is the video
 * track itself). Below it the upload is short anyway and the original keeps
 * every video feature on the server.
 */
export const CLIENT_AUDIO_EXTRACT_MIN_VIDEO_BYTES = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MIN_VIDEO_MB, 100) * MB
/**
 * Videos shorter than this keep the original whatever their size: a clip is
 * watched as much as heard (frames, subtitles, on-screen text), while the
 * lectures and meetings this is for last far longer.
 */
export const CLIENT_AUDIO_EXTRACT_MIN_VIDEO_SECONDS = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MIN_VIDEO_MINUTES, 20) * 60
/** Audio files from this size on are re-encoded (a 320 kbps MP3 shrinks ≈ 13×); small ones are not worth a decode. */
export const CLIENT_AUDIO_EXTRACT_MIN_AUDIO_BYTES = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MIN_AUDIO_MB, 32) * MB
/** The extracted audio sits in memory until it is uploaded: bound the source a track copy is tried on. */
export const DEFAULT_MAX_COPY_SOURCE_BYTES = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MAX_COPY_GB, 4) * 1024 * MB
export const DEFAULT_MIN_SAVINGS_RATIO = 0.1
/** The extracted duration may differ from the source by this much (container rounding, priming samples). */
export const DURATION_TOLERANCE_SECONDS = 1.5
export const DURATION_TOLERANCE_RATIO = 0.005
/** Audio that starts this much after the video keeps the original (its lead is on the transcript clock). */
export const MAX_AUDIO_LEAD_SECONDS = 0.1
/** A track whose peak never reaches this level (≈ −50 dBFS) is silent: the original goes, for the video fallbacks. */
export const SILENCE_PEAK = 10 ** (-50 / 20)

// Next inlines only literal `process.env.NEXT_PUBLIC_*` member reads into the
// browser bundle (there, `process.env` itself is an empty shim): the kill
// switch is read once, here, so NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT=0 works.
const BUILD_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT: process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT,
})

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|ts|m2ts|3gp|ogv)$/i
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|wma|aiff?|amr|caf|weba)$/i

export function isClientAudioExtractionEnabled(env: Readonly<Record<string, string | undefined>> = BUILD_ENV): boolean {
  const flag = String(env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT ?? "").trim().toLowerCase()
  return !(flag === "0" || flag === "false" || flag === "off")
}

export type MediaKind = "video" | "audio" | "other"

export function mediaKindOf(file: { name?: string | null; type?: string | null }): MediaKind {
  const type = String(file?.type || "").toLowerCase()
  const name = String(file?.name || "")
  if (type.startsWith("video/") || (!type && VIDEO_EXT.test(name))) return "video"
  if (type.startsWith("audio/") || (!type && AUDIO_EXT.test(name))) return "audio"
  if (VIDEO_EXT.test(name) && !type.startsWith("audio/")) return "video"
  if (AUDIO_EXT.test(name)) return "audio"
  return "other"
}

export type ExtractionPlan = { eligible: boolean; kind: MediaKind; reason: string }

/** Pure gate: which files are worth a client-side extraction at all. */
export function planAudioExtraction(
  file: { name?: string | null; type?: string | null; size?: number | null },
  env: Readonly<Record<string, string | undefined>> = BUILD_ENV,
): ExtractionPlan {
  const kind = mediaKindOf(file)
  const size = Number(file?.size) || 0
  if (!isClientAudioExtractionEnabled(env)) return { eligible: false, kind, reason: "disabled" }
  if (kind === "other" || !isMediaUpload({ name: file?.name ?? undefined, type: file?.type ?? undefined, size })) return { eligible: false, kind, reason: "not_media" }
  if (kind === "video") {
    return size >= CLIENT_AUDIO_EXTRACT_MIN_VIDEO_BYTES ? { eligible: true, kind, reason: "video" } : { eligible: false, kind, reason: "small_video" }
  }
  return size >= CLIENT_AUDIO_EXTRACT_MIN_AUDIO_BYTES ? { eligible: true, kind, reason: "large_audio" } : { eligible: false, kind, reason: "small_audio" }
}

/** `Clase 3 (final).mp4` → `Clase 3 (final).audio.ogg`: the source name survives, the extension says what it is now. */
export function extractedFileName(sourceName: string, extension: string): string {
  const base = String(sourceName || "audio").replace(/[\\/]+/g, " ").trim() || "audio"
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "") || base
  return `${stem}.audio.${extension.replace(/^\./, "")}`
}

/** The upload metadata for an extracted file. */
export function clientExtractedMetadata(outcome: ExtractedAudio): ClientExtractedMetadata {
  return {
    tier: outcome.tier,
    sourceName: outcome.sourceName,
    sourceSize: outcome.sourceSize,
    sourceType: outcome.sourceType,
    codec: outcome.codec,
    durationSeconds: outcome.durationSeconds,
  }
}

type CopyContainer = { make: (mb: MediabunnyModule) => InstanceType<MediabunnyModule["OutputFormat"]>; extension: string; mimeType: string }

/** The lightest audio-only container that holds the source codec without transcoding. */
export function copyContainerFor(codec: string | null): CopyContainer | null {
  switch (codec) {
    case "aac":
      // Not "in-memory": that muxer keeps every copied packet until the end,
      // and each one is a view into the source's read buffers (≈ the whole
      // video stays in RAM). Without it each chunk is written and released.
      return { make: (mb) => new mb.Mp4OutputFormat({ fastStart: false }), extension: "m4a", mimeType: "audio/mp4" }
    case "mp3":
      return { make: (mb) => new mb.Mp3OutputFormat(), extension: "mp3", mimeType: "audio/mpeg" }
    case "opus":
    case "vorbis":
      return { make: (mb) => new mb.OggOutputFormat(), extension: "ogg", mimeType: "audio/ogg" }
    case "flac":
      return { make: (mb) => new mb.FlacOutputFormat(), extension: "flac", mimeType: "audio/flac" }
    default:
      if (codec && codec.startsWith("pcm-")) return { make: (mb) => new mb.WavOutputFormat(), extension: "wav", mimeType: "audio/wav" }
      if (codec) return { make: (mb) => new mb.MkvOutputFormat(), extension: "mka", mimeType: "audio/x-matroska" }
      return null
  }
}

function abortError(): Error {
  try {
    return new DOMException("The extraction was aborted.", "AbortError")
  } catch {
    return Object.assign(new Error("The extraction was aborted."), { name: "AbortError" })
  }
}

/** `extracted` must be known: an output whose duration cannot be read back is not trusted. */
function durationsMatch(source: number | null, extracted: number | null): boolean {
  if (extracted == null || !(extracted > 0)) return false
  if (source == null) return true
  if (!(source > 0)) return false
  const tolerance = Math.max(DURATION_TOLERANCE_SECONDS, source * DURATION_TOLERANCE_RATIO)
  return Math.abs(source - extracted) <= tolerance
}

/** The read-back duration of the extracted file, or null when it holds no readable audio track. */
async function readDuration(mb: MediabunnyModule, blob: Blob): Promise<number | null> {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS })
  try {
    const audio = await input.getPrimaryAudioTrack().catch(() => null)
    if (!audio) return null
    const fromMetadata = await input.getDurationFromMetadata().catch(() => null)
    if (fromMetadata != null && fromMetadata > 0) return fromMetadata
    const computed = await input.computeDuration().catch(() => null)
    return computed != null && computed > 0 ? computed : null
  } finally {
    input.dispose()
  }
}

const defaultLoader = (): Promise<MediabunnyModule> => import("mediabunny")

/**
 * Extract the audio of `file` for transcription. Resolves with the extracted
 * file (`opus` / `copy`) or with `tier: "none"` and the reason: the caller
 * then uploads the original. Rejects only on abort.
 */
export async function extractAudioForTranscription(file: File, options: ExtractOptions = {}): Promise<ExtractionOutcome> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const source: ExtractionSource = { sourceName: file.name, sourceSize: file.size, sourceType: file.type || "" }
  const skip = (reason: string): ExtractionSkipped => ({ ...source, tier: "none", reason })
  const signal = options.signal
  const throwIfAborted = () => { if (signal?.aborted) throw abortError() }
  const emit = (progress: ExtractionProgress) => { try { options.onProgress?.(progress) } catch { /* observers never break the extraction */ } }
  throwIfAborted()

  let mb: MediabunnyModule
  try {
    mb = await (options.loadMediabunny ?? defaultLoader)()
  } catch {
    return skip("mediabunny_unavailable")
  }
  throwIfAborted()
  emit({ phase: "probing", progress: 0 })

  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  // ✕ during the probe: disposing the input rejects its pending reads at once.
  const onProbeAbort = () => { try { input.dispose() } catch { /* already disposed */ } }
  signal?.addEventListener("abort", onProbeAbort, { once: true })
  try {
    try {
      await input.getFormat()
    } catch {
      throwIfAborted()
      return skip("unreadable")
    }
    const track = await input.getPrimaryAudioTrack().catch(() => null)
    throwIfAborted()
    if (!track) return skip("no_audio_track")
    const codec = track.codec ?? null
    // From the container's metadata only: computing it reads the whole file
    // (a MediaRecorder WebM has none), and the conversion reads it again.
    // The read-back duration of the small output stands in when it is missing.
    const sourceDuration = await input.getDurationFromMetadata().catch(() => null)
    // Audio that starts after the video: dropping the video would rebase it to
    // 0 and shift every timestamp early. The server keeps that lead.
    const firstAll = await input.getFirstTimestamp().catch(() => null)
    const firstAudio = await input.getFirstTimestamp([track]).catch(() => null)
    if (firstAll != null && firstAudio != null && firstAudio - firstAll > MAX_AUDIO_LEAD_SECONDS) return skip("audio_offset")
    const kind = mediaKindOf(file)
    const minVideoSeconds = options.minVideoSeconds ?? CLIENT_AUDIO_EXTRACT_MIN_VIDEO_SECONDS
    if (kind === "video" && sourceDuration != null && sourceDuration < minVideoSeconds) return skip("short_video")
    throwIfAborted()
    signal?.removeEventListener("abort", onProbeAbort)
    emit({ phase: "probing", progress: 1 })

    const canDecode = await track.canDecode().catch(() => false)
    const canOpus = canDecode && (await mb.canEncodeAudio("opus", { numberOfChannels: OPUS_TARGET.numberOfChannels, sampleRate: OPUS_TARGET.sampleRate, bitrate: OPUS_TARGET.bitrate }).catch(() => false))

    const attempts: Array<{ tier: "opus" | "copy"; format: InstanceType<MediabunnyModule["OutputFormat"]>; extension: string; mimeType: string; audio: Record<string, unknown> }> = []
    if (canOpus) {
      attempts.push({ tier: "opus", format: new mb.OggOutputFormat(), extension: "ogg", mimeType: "audio/ogg", audio: { ...OPUS_TARGET, forceTranscode: true } })
    }
    // A copy only pays off when the video track is what weighs; an audio file
    // that cannot be re-encoded stays as it is. Bounded: the copy sits in memory.
    const copy = kind === "video" && file.size <= (options.maxCopySourceBytes ?? DEFAULT_MAX_COPY_SOURCE_BYTES) ? copyContainerFor(codec) : null
    if (copy) attempts.push({ tier: "copy", format: copy.make(mb), extension: copy.extension, mimeType: copy.mimeType, audio: {} })
    if (!attempts.length) return skip(canDecode ? (kind === "video" ? "no_container" : "no_encoder") : "undecodable")

    let lastReason = "no_output"
    for (const attempt of attempts) {
      throwIfAborted()
      const output = new mb.Output({ format: attempt.format, target: new mb.BufferTarget() })
      // The decoded (mono 16 kHz) samples tell whether the track is silent;
      // the measuring stops at the first audible sample, so it costs nothing
      // on speech. A copy is never decoded: its level is unknown.
      let peak = 0
      const measure = (sample: AudioSample) => {
        if (peak >= SILENCE_PEAK) return sample
        try {
          const frames = new Float32Array(sample.numberOfFrames)
          sample.copyTo(frames, { planeIndex: 0, format: "f32-planar" })
          for (let i = 0; i < frames.length; i += 1) {
            const level = Math.abs(frames[i])
            if (level > peak) peak = level
            if (peak >= SILENCE_PEAK) break
          }
        } catch {
          peak = SILENCE_PEAK // unmeasurable: never call it silent
        }
        return sample
      }
      const audioOptions = attempt.tier === "opus" ? { ...attempt.audio, process: measure } : attempt.audio
      let conversion: MediabunnyConversion
      try {
        conversion = await mb.Conversion.init({
          input,
          output,
          // The primary audio track only: the others (commentary, dubs) would
          // reach the server as extra streams with no language or default flag.
          tracks: "primary",
          video: { discard: true },
          audio: (candidate: InputAudioTrack) => (candidate.id === track.id ? audioOptions : { discard: true }),
          tags: () => ({}),
          showWarnings: false,
        })
      } catch {
        lastReason = `${attempt.tier}_init_failed`
        continue
      }
      if (!conversion.isValid) {
        lastReason = `${attempt.tier}_invalid`
        continue
      }
      conversion.onProgress = (progress: number, processedTime: number) => emit({ phase: "converting", progress, processedSeconds: processedTime })
      const onAbort = () => { void conversion.cancel() }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) {
        // Aborted while init was pending: the listener never fires for it.
        signal.removeEventListener("abort", onAbort)
        await conversion.cancel().catch(() => {})
        throw abortError()
      }
      try {
        await conversion.execute()
      } catch (err) {
        signal?.removeEventListener("abort", onAbort)
        if (signal?.aborted) throw abortError()
        lastReason = `${attempt.tier}_failed`
        continue
      }
      signal?.removeEventListener("abort", onAbort)
      throwIfAborted()
      const buffer = output.target.buffer
      if (!buffer || buffer.byteLength === 0) {
        lastReason = `${attempt.tier}_empty`
        continue
      }
      if (attempt.tier === "opus" && peak < SILENCE_PEAK) {
        // Nothing audible: a slide or screen recording. The server reads its
        // embedded subtitles or the text on screen, which need the video.
        return skip("silent_audio")
      }
      const extracted = new File([buffer], extractedFileName(file.name, attempt.extension), { type: attempt.mimeType, lastModified: file.lastModified })
      const minSavings = options.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO
      if (file.size - extracted.size < file.size * minSavings) {
        lastReason = "no_gain"
        continue
      }
      emit({ phase: "verifying", progress: 0 })
      const extractedDuration = await readDuration(mb, extracted).catch(() => null)
      if (extractedDuration == null) {
        lastReason = `${attempt.tier}_unverifiable`
        continue
      }
      if (!durationsMatch(sourceDuration, extractedDuration)) {
        lastReason = "duration_mismatch"
        continue
      }
      // No duration in the source's metadata: the short-video rule uses the output's.
      if (kind === "video" && sourceDuration == null && extractedDuration < minVideoSeconds) return skip("short_video")
      emit({ phase: "verifying", progress: 1 })
      return {
        ...source,
        tier: attempt.tier,
        file: extracted,
        codec,
        durationSeconds: sourceDuration ?? extractedDuration ?? null,
        bytesSaved: file.size - extracted.size,
        ms: Math.max(0, now() - startedAt),
      }
    }
    return skip(lastReason)
  } finally {
    signal?.removeEventListener("abort", onProbeAbort)
    input.dispose()
  }
}
