/**
 * Error chime for the admin turn-failure tracker.
 *
 * Synthesised with the Web Audio API (no audio assets, no licensing):
 *   strong — descending three-tone triangle chime, clearly an error
 *            (sin respuesta, colgado, sin cierre, error visible, adjunto
 *            perdido, herramienta fallida, cancelado por el sistema)
 *   soft   — short descending two-tone sine (respuesta no entendible,
 *            reportado por el usuario)
 *
 * Only failures ever sound. A throttle keeps at least 5 s between chimes;
 * a burst plays once and the UI shows the count.
 */

export type ChimeTier = "strong" | "soft"

const SOFT_CATEGORIES = new Set(["respuesta_no_entendible", "usuario_reporto"])

/** Category → chime tier. Unknown categories are treated as strong. */
export function soundTierFor(category?: string | null, sound?: string | null): ChimeTier {
  if (category && SOFT_CATEGORIES.has(category)) return "soft"
  if (category) return "strong"
  return sound === "soft" ? "soft" : "strong"
}

/** The strongest tier among a batch of new failures. */
export function strongestTier(items: Array<{ category?: string | null; sound?: string | null }>): ChimeTier {
  return items.some((it) => soundTierFor(it.category, it.sound) === "strong") ? "strong" : "soft"
}

export type AlertThrottle = {
  /** Offer `count` new failures. Returns whether to play now and how many it covers. */
  offer(count: number): { play: boolean; count: number }
  pending(): number
}

export function createAlertThrottle({
  minIntervalMs = 5000,
  now = () => Date.now(),
}: { minIntervalMs?: number; now?: () => number } = {}): AlertThrottle {
  let lastPlayedAt = Number.NEGATIVE_INFINITY
  let pendingCount = 0
  return {
    offer(count: number) {
      const n = Math.max(0, Math.floor(Number(count) || 0))
      if (n === 0) return { play: false, count: 0 }
      pendingCount += n
      const t = now()
      if (t - lastPlayedAt >= minIntervalMs) {
        const covered = pendingCount
        pendingCount = 0
        lastPlayedAt = t
        return { play: true, count: covered }
      }
      return { play: false, count: pendingCount }
    },
    pending() {
      return pendingCount
    },
  }
}

type ParamLike = {
  setValueAtTime(value: number, time: number): unknown
  exponentialRampToValueAtTime?(value: number, time: number): unknown
  linearRampToValueAtTime?(value: number, time: number): unknown
}
type OscillatorLike = {
  type: string
  frequency: ParamLike
  connect(node: unknown): unknown
  start(time?: number): void
  stop(time?: number): void
}
type GainLike = { gain: ParamLike; connect(node: unknown): unknown }
export type AudioContextLike = {
  currentTime: number
  state?: string
  destination: unknown
  resume?: () => Promise<void>
  createOscillator(): OscillatorLike
  createGain(): GainLike
}

type Note = { freq: number; at: number; dur: number }

const STRONG_NOTES: Note[] = [
  { freq: 880, at: 0, dur: 0.14 },
  { freq: 698.46, at: 0.15, dur: 0.14 },
  { freq: 587.33, at: 0.3, dur: 0.3 },
]
const SOFT_NOTES: Note[] = [
  { freq: 659.25, at: 0, dur: 0.12 },
  { freq: 523.25, at: 0.13, dur: 0.2 },
]

/**
 * Schedule the chime on an AudioContext. Returns the scheduled frequencies
 * (descending) — useful for tests and never throws.
 */
export function playErrorChime(ctx: AudioContextLike | null | undefined, tier: ChimeTier = "strong"): number[] {
  if (!ctx) return []
  try {
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      void ctx.resume().catch(() => {})
    }
    const notes = tier === "strong" ? STRONG_NOTES : SOFT_NOTES
    const peak = tier === "strong" ? 0.24 : 0.1
    const wave = tier === "strong" ? "triangle" : "sine"
    const base = ctx.currentTime + 0.01
    const played: number[] = []
    for (const note of notes) {
      const start = base + note.at
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = wave
      osc.frequency.setValueAtTime(note.freq, start)
      gain.gain.setValueAtTime(0.0001, start)
      if (gain.gain.exponentialRampToValueAtTime) {
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur)
      } else if (gain.gain.linearRampToValueAtTime) {
        gain.gain.linearRampToValueAtTime(peak, start + 0.015)
        gain.gain.linearRampToValueAtTime(0, start + note.dur)
      }
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + note.dur + 0.02)
      played.push(note.freq)
    }
    return played
  } catch {
    return []
  }
}

/** Create (or return) a browser AudioContext; null during SSR / when unsupported. */
export function createBrowserAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!Ctor) return null
  try {
    return new Ctor() as AudioContextLike
  } catch {
    return null
  }
}
