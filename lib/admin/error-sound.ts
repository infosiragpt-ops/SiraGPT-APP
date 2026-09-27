/**
 * Error sound for the admin panel — the ONE sound system every admin view
 * reuses («Fallos de respuesta», «Errores del sistema», live logs…).
 *
 * Synthesised with the Web Audio API (no audio assets, no licensing):
 *   critical — two-burst alarm (new system issue / regression)
 *   strong   — descending three-tone triangle chime, clearly an error
 *              (sin respuesta, colgado, sin cierre, error visible, adjunto
 *              perdido, herramienta fallida, cancelado por el sistema)
 *   soft     — short descending two-tone sine (respuesta no entendible,
 *              reportado por el usuario)
 *
 * Only failures ever sound. A throttle keeps at least 5 s between chimes;
 * a burst plays once and the UI shows the count. The on/off preference is
 * shared (localStorage `sira-admin-error-sound`), and so is the
 * AudioContext: the toggle click unlocks it once for every view.
 */

export type ChimeTier = "critical" | "strong" | "soft"
export type ErrorSoundTier = ChimeTier

/** localStorage key of the admin-wide «Sonido de errores» toggle. */
export const ERROR_SOUND_STORAGE_KEY = "sira-admin-error-sound"

const SOFT_CATEGORIES = new Set(["respuesta_no_entendible", "usuario_reporto"])

/** Category → chime tier. Unknown categories are treated as strong. */
export function soundTierFor(category?: string | null, sound?: string | null): ChimeTier {
  if (category && SOFT_CATEGORIES.has(category)) return "soft"
  if (category) return "strong"
  return sound === "soft" ? "soft" : "strong"
}

/** The strongest tier among a batch of new failures. */
export function strongestTier(items: Array<{ category?: string | null; sound?: string | null }>): ChimeTier {
  if (items.some((it) => it.sound === "critical")) return "critical"
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
// Two short high–low bursts: unmistakably «something new broke».
const CRITICAL_NOTES: Note[] = [
  { freq: 1046.5, at: 0, dur: 0.1 },
  { freq: 830.61, at: 0.11, dur: 0.1 },
  { freq: 1046.5, at: 0.3, dur: 0.1 },
  { freq: 830.61, at: 0.41, dur: 0.22 },
]

const TIER_VOICE: Record<ChimeTier, { notes: Note[]; peak: number; wave: string }> = {
  critical: { notes: CRITICAL_NOTES, peak: 0.28, wave: "square" },
  strong: { notes: STRONG_NOTES, peak: 0.24, wave: "triangle" },
  soft: { notes: SOFT_NOTES, peak: 0.1, wave: "sine" },
}

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
    const { notes, peak, wave } = TIER_VOICE[tier] || TIER_VOICE.strong
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

/** Create a browser AudioContext; null during SSR / when unsupported. */
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

let sharedContext: AudioContextLike | null = null

/** The admin panel's single AudioContext (created lazily, then reused). */
export function getErrorSoundContext(): AudioContextLike | null {
  if (!sharedContext) sharedContext = createBrowserAudioContext()
  return sharedContext
}

/**
 * Call from a user gesture (the toggle click): creates/resumes the shared
 * context so later chimes are allowed by the browser's autoplay policy.
 */
export function unlockErrorSound(): AudioContextLike | null {
  const ctx = getErrorSoundContext()
  if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
    void ctx.resume().catch(() => {})
  }
  return ctx
}

/** Whether the admin enabled «Sonido de errores» (shared preference). */
export function isErrorSoundEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(ERROR_SOUND_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * Play the error sound on the shared context — for any admin view. Respects
 * the shared on/off preference unless `force` (e.g. a preview on the toggle).
 */
export function playErrorSound(tier: ChimeTier = "strong", { force = false }: { force?: boolean } = {}): number[] {
  if (!force && !isErrorSoundEnabled()) return []
  return playErrorChime(getErrorSoundContext(), tier)
}

/** Test hook: forget the shared context. */
export function __resetErrorSoundForTests() {
  sharedContext = null
}
