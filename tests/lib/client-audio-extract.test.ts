import { describe, expect, it } from "vitest"

import {
  CLIENT_AUDIO_EXTRACT_MIN_AUDIO_BYTES,
  CLIENT_AUDIO_EXTRACT_MIN_VIDEO_BYTES,
  OPUS_TARGET,
  clientExtractedMetadata,
  copyContainerFor,
  extractAudioForTranscription,
  extractedFileName,
  isClientAudioExtractionEnabled,
  mediaKindOf,
  planAudioExtraction,
  type MediabunnyModule,
} from "@/lib/media/client-audio-extract"

/**
 * Client-side audio extraction (mediabunny injected as a fake): the gate,
 * the opus tier (mono 16 kHz 24 kbps, video discarded), the copy tier when
 * the browser cannot encode Opus, the verification that protects the
 * original (duration match, real gain) and the abort path.
 */

const MB = 1024 * 1024

type FakeOptions = {
  codec?: string | null
  canDecode?: boolean
  canOpus?: boolean
  sourceDuration?: number | null
  /** Bytes the conversion produces per tier. */
  outputBytes?: Partial<Record<"opus" | "copy", number>>
  /** Duration the extracted file reports when re-read. */
  extractedDuration?: number | null
  noAudioTrack?: boolean
  unreadable?: boolean
  invalid?: boolean
  hang?: boolean
  /** Peak level of every decoded sample (0 = digital silence). */
  samplePeak?: number
  /** First timestamps: of the whole file, and of the audio track. */
  firstTimestamp?: number
  audioFirstTimestamp?: number
  /** The extracted file holds no audio track when re-read. */
  readBackNoAudio?: boolean
  /** Conversion.init resolves only when this promise does. */
  initGate?: Promise<void>
  /** What the source's container metadata says (default: sourceDuration); computing reads the whole file. */
  metadataDuration?: number | null
  /** getFormat never resolves; disposing the input rejects it (like mediabunny's pending reads). */
  probeHang?: boolean
  /** Every audio track of the source (default: the primary alone). */
  audioTracks?: Array<{ language?: string; name?: string | null; commentary?: boolean; visuallyImpaired?: boolean }>
}

function fakeMediabunny(opts: FakeOptions = {}) {
  const calls: { conversions: any[]; cancels: number; disposed: number; readBacks: number; executed: number; sourceComputes: number } = { conversions: [], cancels: 0, disposed: 0, readBacks: 0, executed: 0, sourceComputes: 0 }
  let inputs = 0
  class BlobSource { constructor(public blob: Blob) {} }
  class BufferTarget { buffer: ArrayBuffer | null = null }
  const format = (name: string) => class { name = name; constructor(public options?: unknown) {} }
  const PRIMARY = { id: 2, codec: opts.codec === undefined ? "aac" : opts.codec, canDecode: async () => opts.canDecode ?? true }
  class Input {
    private readonly blob: Blob
    private readonly isReadBack: boolean
    constructor(options: { source: BlobSource }) {
      this.blob = options.source.blob
      this.isReadBack = inputs > 0
      inputs += 1
    }
    private rejectProbe: ((err: Error) => void) | null = null
    async getFormat() {
      if (opts.unreadable && !this.isReadBack) throw new Error("unreadable")
      if (opts.probeHang && !this.isReadBack) return new Promise((_resolve, reject) => { this.rejectProbe = reject })
      return {}
    }
    async getPrimaryAudioTrack() {
      if (this.isReadBack) return opts.readBackNoAudio ? null : { id: 1, codec: "opus" }
      if (opts.noAudioTrack) return null
      return PRIMARY
    }
    async getAudioTracks() {
      const list = this.isReadBack ? [{}] : (opts.audioTracks ?? [{}])
      return list.map((meta, index) => ({
        id: index === 0 ? PRIMARY.id : 100 + index,
        getLanguageCode: async () => meta.language ?? "und",
        getName: async () => meta.name ?? null,
        getDisposition: async () => ({ default: index === 0, primary: index === 0, forced: false, original: false, commentary: Boolean(meta.commentary), hearingImpaired: false, visuallyImpaired: Boolean(meta.visuallyImpaired) }),
      }))
    }
    async getFirstTimestamp(tracks?: unknown[]) {
      return tracks ? (opts.audioFirstTimestamp ?? opts.firstTimestamp ?? 0) : (opts.firstTimestamp ?? 0)
    }
    async getDurationFromMetadata() {
      if (this.isReadBack) { calls.readBacks += 1; return opts.extractedDuration === undefined ? (opts.sourceDuration === undefined ? 3600 : opts.sourceDuration) : opts.extractedDuration }
      if (opts.metadataDuration !== undefined) return opts.metadataDuration
      return opts.sourceDuration === undefined ? 3600 : opts.sourceDuration
    }
    async computeDuration() {
      if (!this.isReadBack) { calls.sourceComputes += 1; return opts.sourceDuration === undefined ? 3600 : opts.sourceDuration }
      return this.getDurationFromMetadata()
    }
    dispose() { calls.disposed += 1; this.rejectProbe?.(new Error("InputDisposedError")) }
  }
  class Output { constructor(public options: { format: any; target: BufferTarget }) {} get target() { return this.options.target } }
  class Conversion {
    onProgress?: (p: number, t: number) => unknown
    isValid = !opts.invalid
    private cancelled = false
    constructor(public options: any) {}
    static async init(options: any) {
      if (opts.initGate) await opts.initGate
      const c = new Conversion(options)
      calls.conversions.push(options)
      return c
    }
    async execute() {
      calls.executed += 1
      const audio = typeof this.options.audio === "function" ? this.options.audio(PRIMARY) : this.options.audio
      const tier = audio && audio.codec === "opus" ? "opus" : "copy"
      if (typeof audio?.process === "function") {
        for (let i = 0; i < 3; i += 1) {
          const level = opts.samplePeak ?? 0.5
          audio.process({ numberOfFrames: 4, copyTo: (dest: Float32Array) => dest.fill(i === 2 ? level : level / 10) })
        }
      }
      this.onProgress?.(0.5, 1800)
      if (opts.hang) {
        await new Promise<void>((_resolve, reject) => { const t = setInterval(() => { if (this.cancelled) { clearInterval(t); reject(new Error("canceled")) } }, 1) })
      }
      const bytes = opts.outputBytes?.[tier] ?? (tier === "opus" ? 1 * MB : 20 * MB)
      this.options.output.target.buffer = new ArrayBuffer(bytes)
      this.onProgress?.(1, 3600)
    }
    async cancel() { this.cancelled = true; calls.cancels += 1 }
  }
  const mb = {
    ALL_FORMATS: [],
    BlobSource,
    BufferTarget,
    Input,
    Output,
    Conversion,
    OggOutputFormat: format("ogg"),
    Mp4OutputFormat: format("mp4"),
    Mp3OutputFormat: format("mp3"),
    FlacOutputFormat: format("flac"),
    WavOutputFormat: format("wav"),
    MkvOutputFormat: format("mkv"),
    canEncodeAudio: async () => opts.canOpus ?? true,
  } as unknown as MediabunnyModule
  return { mb, calls, load: async () => mb }
}

const video = (bytes = 100 * MB, name = "Clase 3 (final).mp4", type = "video/mp4") => new File([new Uint8Array(16)], name, { type, lastModified: 1700000000000 }) as File & { size: number }
const withSize = (file: File, size: number) => Object.defineProperty(file, "size", { value: size })

describe("planAudioExtraction / helpers", () => {
  it("gates by kind, size and the public flag", () => {
    expect(planAudioExtraction({ name: "a.mp4", type: "video/mp4", size: CLIENT_AUDIO_EXTRACT_MIN_VIDEO_BYTES })).toEqual({ eligible: true, kind: "video", reason: "video" })
    expect(planAudioExtraction({ name: "a.mp4", type: "video/mp4", size: CLIENT_AUDIO_EXTRACT_MIN_VIDEO_BYTES - 1 }).eligible).toBe(false)
    expect(planAudioExtraction({ name: "a.mp3", type: "audio/mpeg", size: CLIENT_AUDIO_EXTRACT_MIN_AUDIO_BYTES })).toEqual({ eligible: true, kind: "audio", reason: "large_audio" })
    expect(planAudioExtraction({ name: "nota.ogg", type: "audio/ogg", size: 2 * MB }).reason).toBe("small_audio")
    expect(planAudioExtraction({ name: "informe.pdf", type: "application/pdf", size: 500 * MB }).reason).toBe("not_media")
    expect(planAudioExtraction({ name: "a.mp4", type: "video/mp4", size: 500 * MB }, { NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT: "0" }).reason).toBe("disabled")
    expect(isClientAudioExtractionEnabled({})).toBe(true)
    expect(isClientAudioExtractionEnabled({ NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT: "off" })).toBe(false)
    expect(mediaKindOf({ name: "clase.MKV", type: "" })).toBe("video")
    expect(mediaKindOf({ name: "clase.m4b", type: "" })).toBe("audio")
    expect(mediaKindOf({ name: "x.bin", type: "" })).toBe("other")
    expect(extractedFileName("Clase 3 (final).mp4", "ogg")).toBe("Clase 3 (final).audio.ogg")
    expect(extractedFileName("sin.extension", "m4a")).toBe("sin.extension.audio.m4a", "only a short real extension is stripped")
    expect(extractedFileName("archivo.MOV", "ogg")).toBe("archivo.audio.ogg")
    expect(extractedFileName("", "ogg")).toBe("audio.audio.ogg")
    expect(copyContainerFor("aac")?.extension).toBe("m4a")
    expect(copyContainerFor("vorbis")?.extension).toBe("ogg")
    expect(copyContainerFor("pcm-s16")?.extension).toBe("wav")
    expect(copyContainerFor("eac3")?.extension).toBe("mka")
    expect(copyContainerFor(null)).toBeNull()
  })
})

describe("extractAudioForTranscription", () => {
  it("opus tier: video discarded, mono 16 kHz 24 kbps Opus in Ogg, progress reported, duration verified, metadata for the upload", async () => {
    const fake = fakeMediabunny({ codec: "aac", sourceDuration: 36_000, outputBytes: { opus: 108 * MB } })
    const file = withSize(video(), 3 * 1024 * MB)
    const progress: string[] = []
    const out = await extractAudioForTranscription(file, { loadMediabunny: fake.load, onProgress: (p) => progress.push(`${p.phase}:${p.progress}`), now: (() => { let t = 1000; return () => (t += 500) })() })
    expect(out.tier).toBe("opus")
    if (out.tier !== "opus") return
    expect(fake.calls.conversions).toHaveLength(1)
    const conv = fake.calls.conversions[0]
    expect(conv.video).toEqual({ discard: true })
    // Only the primary audio track is converted; any other one is discarded.
    expect(conv.tracks).toBe("primary")
    const primary = conv.audio({ id: 2 })
    expect(primary).toMatchObject({ codec: "opus", numberOfChannels: 1, sampleRate: 16_000, bitrate: 24_000, forceTranscode: true })
    expect(primary).toMatchObject(OPUS_TARGET)
    expect(typeof primary.process).toBe("function")
    expect(conv.audio({ id: 9 })).toEqual({ discard: true })
    expect(conv.output.options.format.name).toBe("ogg")
    expect(conv.showWarnings).toBe(false)
    expect(out.file.name).toBe("Clase 3 (final).audio.ogg")
    expect(out.file.type).toBe("audio/ogg")
    expect(out.file.size).toBe(108 * MB)
    expect(out.codec).toBe("aac")
    expect(out.durationSeconds).toBe(36_000)
    expect(out.bytesSaved).toBe(3 * 1024 * MB - 108 * MB)
    expect(out.ms).toBeGreaterThan(0)
    expect(out.sourceName).toBe("Clase 3 (final).mp4")
    expect(progress[0]).toBe("probing:0")
    expect(progress).toContain("converting:0.5")
    expect(progress[progress.length - 1]).toBe("verifying:1")
    expect(fake.calls.readBacks).toBe(1)
    expect(fake.calls.disposed).toBe(2)
    expect(clientExtractedMetadata(out)).toEqual({ tier: "opus", sourceName: "Clase 3 (final).mp4", sourceSize: 3 * 1024 * MB, sourceType: "video/mp4", codec: "aac", durationSeconds: 36_000 })
  })

  it("copy tier when the browser cannot encode Opus: the AAC track goes into an audio-only MP4 written as it goes; an audio-only source without an encoder is left alone", async () => {
    const fake = fakeMediabunny({ codec: "aac", canOpus: false, sourceDuration: 3600, outputBytes: { copy: 50 * MB } })
    const out = await extractAudioForTranscription(withSize(video(), 600 * MB), { loadMediabunny: fake.load })
    expect(out.tier).toBe("copy")
    if (out.tier !== "copy") return
    expect(fake.calls.conversions[0].audio({ id: 2 })).toEqual({})
    expect(fake.calls.conversions[0].output.options.format.name).toBe("mp4")
    expect(fake.calls.conversions[0].output.options.format.options).toEqual({ fastStart: false })
    expect(out.file.name).toBe("Clase 3 (final).audio.m4a")
    expect(out.file.type).toBe("audio/mp4")

    const audioOnly = fakeMediabunny({ codec: "mp3", canOpus: false })
    const skipped = await extractAudioForTranscription(withSize(video(200 * MB, "charla.mp3", "audio/mpeg"), 200 * MB), { loadMediabunny: audioOnly.load })
    expect(skipped).toMatchObject({ tier: "none", reason: "no_encoder" })
    expect(audioOnly.calls.conversions).toHaveLength(0)

    const tooBig = fakeMediabunny({ codec: "aac", canOpus: false })
    const bounded = await extractAudioForTranscription(withSize(video(), 5 * 1024 * MB), { loadMediabunny: tooBig.load, maxCopySourceBytes: 4 * 1024 * MB })
    expect(bounded).toMatchObject({ tier: "none", reason: "no_container" })
  })

  it("never replaces the original without proof: no audio track, unreadable file, no real gain, duration mismatch, invalid conversion, missing module", async () => {
    expect(await extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: fakeMediabunny({ noAudioTrack: true }).load })).toMatchObject({ tier: "none", reason: "no_audio_track" })
    expect(await extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: fakeMediabunny({ unreadable: true }).load })).toMatchObject({ tier: "none", reason: "unreadable" })
    // An audio file whose Opus re-encode barely shrinks it (already compact): the original is uploaded.
    expect(await extractAudioForTranscription(withSize(video(100 * MB, "charla.mp3", "audio/mpeg"), 100 * MB), { loadMediabunny: fakeMediabunny({ codec: "mp3", outputBytes: { opus: 95 * MB } }).load })).toMatchObject({ tier: "none", reason: "no_gain" })
    const mismatch = fakeMediabunny({ sourceDuration: 36_000, extractedDuration: 35_000 })
    expect(await extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: mismatch.load })).toMatchObject({ tier: "none", reason: "duration_mismatch" })
    const close = fakeMediabunny({ sourceDuration: 36_000, extractedDuration: 35_999 })
    expect((await extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: close.load })).tier).toBe("opus")
    expect(await extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: fakeMediabunny({ invalid: true, canOpus: false }).load })).toMatchObject({ tier: "none", reason: "copy_invalid" })
    expect(await extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: async () => { throw new Error("offline") } })).toMatchObject({ tier: "none", reason: "mediabunny_unavailable" })
    // The opus attempt fails → the copy attempt is tried next.
    const fallthrough = fakeMediabunny({ codec: "aac", sourceDuration: 3600, outputBytes: { opus: 0, copy: 30 * MB } })
    const out = await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: fallthrough.load })
    expect(out.tier).toBe("copy")
    expect(fallthrough.calls.conversions).toHaveLength(2)
  })

  it("an output whose audio cannot be read back never replaces the original", async () => {
    const fake = fakeMediabunny({ codec: "aac", readBackNoAudio: true })
    expect(await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: fake.load })).toMatchObject({ tier: "none", reason: "copy_unverifiable" })
    expect(fake.calls.conversions).toHaveLength(2)
    // Unknown read-back duration: refused too.
    const unknown = fakeMediabunny({ codec: "aac", canOpus: true, extractedDuration: null, sourceDuration: 3600 })
    expect(await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: unknown.load })).toMatchObject({ tier: "none" })
  })

  it("a silent track or audio that starts after the video keeps the original (the server needs the video then)", async () => {
    const silent = fakeMediabunny({ codec: "aac", samplePeak: 0 })
    expect(await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: silent.load })).toMatchObject({ tier: "none", reason: "silent_audio" })
    const quiet = fakeMediabunny({ codec: "aac", samplePeak: 0.01 })
    expect((await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: quiet.load })).tier).toBe("opus")
    const late = fakeMediabunny({ codec: "aac", firstTimestamp: 0, audioFirstTimestamp: 4.978 })
    expect(await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: late.load })).toMatchObject({ tier: "none", reason: "audio_offset" })
    expect(late.calls.conversions).toHaveLength(0)
    const tiny = fakeMediabunny({ codec: "aac", firstTimestamp: 0, audioFirstTimestamp: 0.04 })
    expect((await extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: tiny.load })).tier).toBe("opus")
  })

  it("a video shorter than 20 minutes keeps the original whatever its size; long ones and audio files are extracted", async () => {
    const clip = fakeMediabunny({ codec: "aac", sourceDuration: 8 * 60 })
    expect(await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: clip.load })).toMatchObject({ tier: "none", reason: "short_video" })
    expect(clip.calls.conversions).toHaveLength(0)
    const lecture = fakeMediabunny({ codec: "aac", sourceDuration: 20 * 60 })
    expect((await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: lecture.load })).tier).toBe("opus")
    const tuned = fakeMediabunny({ codec: "aac", sourceDuration: 8 * 60 })
    expect((await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: tuned.load, minVideoSeconds: 60 })).tier).toBe("opus")
    const song = fakeMediabunny({ codec: "aac", sourceDuration: 8 * 60 })
    expect((await extractAudioForTranscription(withSize(video(100 * MB, "Canción.wav", "audio/wav"), 100 * MB), { loadMediabunny: song.load })).tier).toBe("opus")
  })

  it("the source duration comes from metadata only: without it the whole file is never read twice, and the output's duration decides", async () => {
    const live = fakeMediabunny({ codec: "aac", metadataDuration: null, sourceDuration: 3600 })
    expect((await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: live.load })).tier).toBe("opus")
    expect(live.calls.sourceComputes).toBe(0)
    const shortLive = fakeMediabunny({ codec: "aac", metadataDuration: null, extractedDuration: 5 * 60 })
    expect(await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: shortLive.load })).toMatchObject({ tier: "none", reason: "short_video" })
  })

  it("several audio tracks whose choice matters (dubs, commentary, description) keep the original; OBS-style untagged tracks are extracted", async () => {
    const dub = fakeMediabunny({ codec: "aac", audioTracks: [{ language: "spa" }, { language: "eng" }] })
    expect(await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: dub.load })).toMatchObject({ tier: "none", reason: "multiple_audio_tracks" })
    const commentary = fakeMediabunny({ codec: "aac", audioTracks: [{ language: "spa" }, { language: "spa", name: "Comentarios del director" }] })
    expect(await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: commentary.load })).toMatchObject({ reason: "multiple_audio_tracks" })
    const described = fakeMediabunny({ codec: "aac", audioTracks: [{}, { visuallyImpaired: true }] })
    expect(await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: described.load })).toMatchObject({ reason: "multiple_audio_tracks" })
    const obs = fakeMediabunny({ codec: "aac", audioTracks: [{}, {}] })
    expect((await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: obs.load })).tier).toBe("opus")
    const sameLanguage = fakeMediabunny({ codec: "aac", audioTracks: [{ language: "spa" }, { language: "spa" }] })
    expect((await extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: sameLanguage.load })).tier).toBe("opus")
  })

  it("✕ during the probe disposes the input and rejects at once", async () => {
    const fake = fakeMediabunny({ probeHang: true })
    const controller = new AbortController()
    const pending = extractAudioForTranscription(withSize(video(), 900 * MB), { loadMediabunny: fake.load, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fake.calls.conversions).toHaveLength(0)
  })

  it("an abort that lands while the conversion is being prepared cancels it before it runs", async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const fake = fakeMediabunny({ initGate: gate })
    const ctrl = new AbortController()
    const pending = extractAudioForTranscription(withSize(video(), 300 * MB), { loadMediabunny: fake.load, signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 5))
    ctrl.abort()
    open()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fake.calls.cancels).toBe(1)
    expect(fake.calls.executed).toBe(0)
  })

  it("the kill switch is read through a literal NEXT_PUBLIC_ member (inlined into the browser bundle)", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(path.join(process.cwd(), "lib", "media", "client-audio-extract.ts"), "utf8")
    expect(source).toMatch(/NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT: process\.env\.NEXT_PUBLIC_CLIENT_AUDIO_EXTRACT,/)
    expect(source).toMatch(/export function isClientAudioExtractionEnabled\(env: Readonly<Record<string, string \| undefined>> = BUILD_ENV\)/)
    expect(source).not.toMatch(/= process\.env\)/)
  })

  it("abort: the running conversion is cancelled and the call rejects with an AbortError; the input is disposed", async () => {
    const fake = fakeMediabunny({ hang: true })
    const ctrl = new AbortController()
    const pending = extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: fake.load, signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 5))
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fake.calls.cancels).toBe(1)
    expect(fake.calls.disposed).toBe(1)
    const aborted = new AbortController()
    aborted.abort()
    await expect(extractAudioForTranscription(withSize(video(), 100 * MB), { loadMediabunny: fake.load, signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})
