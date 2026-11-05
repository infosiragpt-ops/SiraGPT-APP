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
 * file must be readable and its duration must match the source's.
 */

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
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MB = 1024 * 1024

/** Opus for speech: mono, 16 kHz (what every STT engine resamples to anyway), 24 kbps. */
export const OPUS_TARGET = Object.freeze({ codec: "opus" as const, numberOfChannels: 1, sampleRate: 16_000, bitrate: 24_000 })

/** Videos from this size on are worth extracting (the saving is the video track itself). */
export const CLIENT_AUDIO_EXTRACT_MIN_VIDEO_BYTES = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MIN_VIDEO_MB, 8) * MB
/** Audio files from this size on are re-encoded (a 320 kbps MP3 shrinks ≈ 13×); small ones are not worth a decode. */
export const CLIENT_AUDIO_EXTRACT_MIN_AUDIO_BYTES = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MIN_AUDIO_MB, 32) * MB
/** A track copy keeps the whole output in memory: bound the source it is tried on. */
export const DEFAULT_MAX_COPY_SOURCE_BYTES = envInt(process.env.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT_MAX_COPY_GB, 4) * 1024 * MB
export const DEFAULT_MIN_SAVINGS_RATIO = 0.1
/** The extracted duration may differ from the source by this much (container rounding, priming samples). */
export const DURATION_TOLERANCE_SECONDS = 1.5
export const DURATION_TOLERANCE_RATIO = 0.005

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|ts|m2ts|3gp|ogv)$/i
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|wma|aiff?|amr|caf|weba)$/i

export function isClientAudioExtractionEnabled(env: Record<string, string | undefined> = process.env): boolean {
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
  env: Record<string, string | undefined> = process.env,
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
      return { make: (mb) => new mb.Mp4OutputFormat({ fastStart: "in-memory" }), extension: "m4a", mimeType: "audio/mp4" }
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

function durationsMatch(source: number | null, extracted: number | null): boolean {
  if (source == null || extracted == null) return true
  if (!(source > 0) || !(extracted > 0)) return false
  const tolerance = Math.max(DURATION_TOLERANCE_SECONDS, source * DURATION_TOLERANCE_RATIO)
  return Math.abs(source - extracted) <= tolerance
}

async function readDuration(mb: MediabunnyModule, blob: Blob): Promise<number | null> {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS })
  try {
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
  try {
    try {
      await input.getFormat()
    } catch {
      return skip("unreadable")
    }
    const track = await input.getPrimaryAudioTrack().catch(() => null)
    if (!track) return skip("no_audio_track")
    const codec = track.codec ?? null
    const sourceDuration = (await input.getDurationFromMetadata().catch(() => null))
      ?? (await input.computeDuration().catch(() => null))
    throwIfAborted()
    emit({ phase: "probing", progress: 1 })

    const kind = mediaKindOf(file)
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
      let conversion: MediabunnyConversion
      try {
        conversion = await mb.Conversion.init({
          input,
          output,
          video: { discard: true },
          audio: attempt.audio,
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
      const extracted = new File([buffer], extractedFileName(file.name, attempt.extension), { type: attempt.mimeType, lastModified: file.lastModified })
      const minSavings = options.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO
      if (file.size - extracted.size < file.size * minSavings) {
        lastReason = "no_gain"
        continue
      }
      emit({ phase: "verifying", progress: 0 })
      const extractedDuration = await readDuration(mb, extracted).catch(() => null)
      if (!durationsMatch(sourceDuration, extractedDuration)) {
        lastReason = "duration_mismatch"
        continue
      }
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
    input.dispose()
  }
}
