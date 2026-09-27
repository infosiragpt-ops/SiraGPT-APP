import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ERROR_SOUND_STORAGE_KEY,
  __resetErrorSoundForTests,
  createAlertThrottle,
  isErrorSoundEnabled,
  playErrorChime,
  playErrorSound,
  soundTierFor,
  strongestTier,
  unlockErrorSound,
  type AudioContextLike,
} from "@/lib/admin/error-sound"

function fakeAudio(state = "running") {
  const oscillators: Array<{ type: string; freqs: number[]; started: number[]; stopped: number[] }> = []
  const ctx: AudioContextLike & { resumed: number } = {
    currentTime: 10,
    state,
    destination: {},
    resumed: 0,
    resume: vi.fn(async () => { ctx.resumed += 1 }),
    createOscillator() {
      const rec = { type: "", freqs: [] as number[], started: [] as number[], stopped: [] as number[] }
      oscillators.push(rec)
      return {
        get type() { return rec.type },
        set type(v: string) { rec.type = v },
        frequency: { setValueAtTime: (v: number) => { rec.freqs.push(v) } },
        connect: () => undefined,
        start: (t?: number) => { rec.started.push(t ?? 0) },
        stop: (t?: number) => { rec.stopped.push(t ?? 0) },
      } as any
    },
    createGain() {
      return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined } as any
    },
  }
  return { ctx, oscillators }
}

describe("error chime — severity mapping", () => {
  it("critical failures are strong; unusable answers and thumbs-down are soft", () => {
    for (const c of ["sin_respuesta", "colgado", "sin_cierre", "error_visible", "adjunto_perdido", "herramienta_fallida", "cancelado_por_sistema"]) {
      expect(soundTierFor(c)).toBe("strong")
    }
    expect(soundTierFor("respuesta_no_entendible")).toBe("soft")
    expect(soundTierFor("usuario_reporto")).toBe("soft")
    expect(soundTierFor(null, "soft")).toBe("soft")
    expect(soundTierFor("categoria_nueva")).toBe("strong")
  })

  it("a batch sounds as its strongest member", () => {
    expect(strongestTier([{ category: "usuario_reporto" }, { category: "respuesta_no_entendible" }])).toBe("soft")
    expect(strongestTier([{ category: "usuario_reporto" }, { category: "colgado" }])).toBe("strong")
    expect(strongestTier([{ category: "colgado" }, { sound: "critical" }])).toBe("critical")
  })
})

describe("error chime — throttle", () => {
  it("keeps ≥5 s between chimes and plays a burst once with its count", () => {
    let t = 0
    const throttle = createAlertThrottle({ minIntervalMs: 5000, now: () => t })
    expect(throttle.offer(3)).toEqual({ play: true, count: 3 })
    t = 1000
    expect(throttle.offer(2)).toEqual({ play: false, count: 2 })
    t = 4999
    expect(throttle.offer(1).play).toBe(false)
    t = 5000
    // Everything held back while throttled is covered by the next chime.
    expect(throttle.offer(1)).toEqual({ play: true, count: 4 })
    expect(throttle.offer(0)).toEqual({ play: false, count: 0 })
  })
})

describe("error chime — Web Audio synthesis", () => {
  it("strong = three descending triangle tones, each oscillator started and stopped", () => {
    const { ctx, oscillators } = fakeAudio()
    const played = playErrorChime(ctx, "strong")
    expect(played).toEqual([880, 698.46, 587.33])
    expect(oscillators).toHaveLength(3)
    for (const osc of oscillators) {
      expect(osc.type).toBe("triangle")
      expect(osc.started).toHaveLength(1)
      expect(osc.stopped).toHaveLength(1)
      expect(osc.stopped[0]).toBeGreaterThan(osc.started[0])
    }
    const freqs = oscillators.map((o) => o.freqs[0])
    expect([...freqs].sort((a, b) => b - a)).toEqual(freqs)
  })

  it("soft = two descending sine tones", () => {
    const { ctx, oscillators } = fakeAudio()
    expect(playErrorChime(ctx, "soft")).toEqual([659.25, 523.25])
    expect(oscillators.every((o) => o.type === "sine")).toBe(true)
  })

  it("resumes a suspended context and never throws without audio", () => {
    const { ctx } = fakeAudio("suspended")
    playErrorChime(ctx, "strong")
    expect(ctx.resume).toHaveBeenCalled()
    expect(playErrorChime(null, "strong")).toEqual([])
    expect(playErrorChime({ currentTime: 0, destination: {}, createOscillator: () => { throw new Error("x") }, createGain: () => ({}) } as any)).toEqual([])
  })
})

describe("error sound — critical tier and the shared player", () => {
  afterEach(() => {
    __resetErrorSoundForTests()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it("critical = two high–low bursts (four tones), distinct from strong", () => {
    const { ctx, oscillators } = fakeAudio()
    expect(playErrorChime(ctx, "critical")).toEqual([1046.5, 830.61, 1046.5, 830.61])
    expect(oscillators.every((o) => o.type === "square")).toBe(true)
  })

  it("playErrorSound reuses ONE shared context and honours the shared toggle", () => {
    const created: ReturnType<typeof fakeAudio>[] = []
    function FakeCtor(this: unknown) {
      const audio = fakeAudio("suspended")
      created.push(audio)
      return audio.ctx
    }
    vi.stubGlobal("AudioContext", FakeCtor as unknown as typeof AudioContext)

    // Off by default: nothing plays, no context is even created.
    expect(isErrorSoundEnabled()).toBe(false)
    expect(playErrorSound("strong")).toEqual([])
    expect(created).toHaveLength(0)

    // The toggle click unlocks (creates + resumes) the shared context…
    const unlocked = unlockErrorSound()
    expect(created).toHaveLength(1)
    expect(unlocked?.resume).toHaveBeenCalled()

    // …and every later chime, from any view, lands on that same context.
    window.localStorage.setItem(ERROR_SOUND_STORAGE_KEY, "1")
    expect(playErrorSound("strong")).toEqual([880, 698.46, 587.33])
    expect(playErrorSound("soft")).toEqual([659.25, 523.25])
    expect(created).toHaveLength(1)
    expect(created[0].oscillators).toHaveLength(5)
    expect(playErrorSound("critical", { force: true })).toHaveLength(4)
  })
})
