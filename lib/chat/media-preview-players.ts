/**
 * Shared helpers for professional black-and-white video/audio preview
 * chrome. React players live in components/chat/media-preview-players.tsx.
 */
import { FORBIDDEN_MEDIA_CHIP_COLOR_RE } from "./media-mode-chips"

export type MediaPreviewKind = "video" | "audio"
export type MediaPreviewVariant = "composer" | "bubble" | "viewer" | "generated"
export type MediaPreviewAspect = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16"

export const MEDIA_PREVIEW_ASPECTS: readonly MediaPreviewAspect[] = Object.freeze([
  "auto",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
])

export const MEDIA_PREVIEW_VARIANTS: readonly MediaPreviewVariant[] = Object.freeze([
  "composer",
  "bubble",
  "viewer",
  "generated",
])

const ASPECT_RATIO_CSS: Record<MediaPreviewAspect, string> = {
  auto: "16 / 9",
  "21:9": "21 / 9",
  "16:9": "16 / 9",
  "4:3": "4 / 3",
  "1:1": "1 / 1",
  "3:4": "3 / 4",
  "9:16": "9 / 16",
}

export function normalizeMediaPreviewAspect(value: unknown): MediaPreviewAspect {
  const raw = String(value || "").trim()
  return (MEDIA_PREVIEW_ASPECTS as readonly string[]).includes(raw)
    ? raw as MediaPreviewAspect
    : "16:9"
}

export function mediaPreviewAspectCss(value: unknown): string {
  return ASPECT_RATIO_CSS[normalizeMediaPreviewAspect(value)]
}

export function formatMediaClock(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds as number) || (seconds as number) < 0) return "0:00"
  const total = Math.floor(seconds as number)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`
}

/** Deterministic fallback waveform (SSR-safe, no Math.random). */
export const FALLBACK_AUDIO_WAVEFORM = Object.freeze(
  Array.from({ length: 48 }, (_, i) => {
    const detail = Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.19) + Math.sin(i * 1.3) * 0.35)
    const envelope = 0.42 + 0.58 * Math.sin((i / 47) * Math.PI)
    return Math.max(0.12, Math.min(1, detail * envelope))
  }),
)

export function normalizeWaveformPeaks(peaks: unknown, buckets = 48): number[] {
  if (!Array.isArray(peaks) || peaks.length === 0) {
    return FALLBACK_AUDIO_WAVEFORM.slice(0, buckets) as number[]
  }
  const nums = peaks.filter((p): p is number => typeof p === "number" && Number.isFinite(p))
  if (nums.length === 0) return FALLBACK_AUDIO_WAVEFORM.slice(0, buckets) as number[]
  const max = Math.max(...nums, 0.0001)
  const normalized = nums.map((p) => Math.max(0.08, Math.min(1, p / max)))
  if (normalized.length === buckets) return normalized
  if (normalized.length > buckets) {
    const step = normalized.length / buckets
    return Array.from({ length: buckets }, (_, i) => {
      const start = Math.floor(i * step)
      const end = Math.max(start + 1, Math.floor((i + 1) * step))
      const slice = normalized.slice(start, end)
      return slice.reduce((a, b) => a + b, 0) / slice.length
    })
  }
  const out: number[] = []
  for (let i = 0; i < buckets; i++) {
    const t = i * (normalized.length - 1) / Math.max(1, buckets - 1)
    const lo = Math.floor(t)
    const hi = Math.min(normalized.length - 1, lo + 1)
    const f = t - lo
    out.push(normalized[lo] * (1 - f) + normalized[hi] * f)
  }
  return out
}

export const VIDEO_PLAYER_FRAME_CLASS =
  "chat-video-player relative overflow-hidden rounded-[0.95rem] border border-zinc-200/90 bg-zinc-950 text-white shadow-[0_10px_28px_-18px_rgba(15,23,42,0.55)] dark:border-white/12"

export const AUDIO_PLAYER_FRAME_CLASS =
  "chat-audio-player relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-zinc-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/12 dark:bg-zinc-900 dark:text-zinc-100"

export const MEDIA_PLAY_BUTTON_CLASS =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white transition-transform hover:scale-[1.04] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:bg-white dark:text-zinc-950"

export const MEDIA_SEEK_TRACK_CLASS =
  "relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-900/15 dark:bg-white/15"

export const MEDIA_SEEK_FILL_CLASS =
  "absolute inset-y-0 left-0 rounded-full bg-zinc-950 dark:bg-white"

export function mediaPlayerChrome(kind: MediaPreviewKind, variant: MediaPreviewVariant = "bubble"): {
  className: string
  kind: MediaPreviewKind
  variant: MediaPreviewVariant
} {
  return {
    kind,
    variant,
    className: kind === "video" ? VIDEO_PLAYER_FRAME_CLASS : AUDIO_PLAYER_FRAME_CLASS,
  }
}

export function forbiddenMediaPlayerColorHits(className: string, style?: unknown): string[] {
  const haystack = `${className} ${typeof style === "string" ? style : JSON.stringify(style ?? {})}`
  return haystack.match(new RegExp(FORBIDDEN_MEDIA_CHIP_COLOR_RE.source, "gi")) || []
}

export function assertMonochromeMediaPlayerChrome(className: string, style?: unknown): void {
  const hits = forbiddenMediaPlayerColorHits(className, style)
  if (hits.length > 0) {
    throw new Error(`media player chrome is not black-and-white: ${hits.join(", ")}`)
  }
}

export function mediaPreviewCombos(): Array<{
  kind: MediaPreviewKind
  variant: MediaPreviewVariant
  aspect: MediaPreviewAspect
  hasPoster: boolean
  hasPeaks: boolean
  hasDuration: boolean
}> {
  const combos: Array<{
    kind: MediaPreviewKind
    variant: MediaPreviewVariant
    aspect: MediaPreviewAspect
    hasPoster: boolean
    hasPeaks: boolean
    hasDuration: boolean
  }> = []
  for (const kind of ["video", "audio"] as const) {
    for (const variant of MEDIA_PREVIEW_VARIANTS) {
      for (const aspect of MEDIA_PREVIEW_ASPECTS) {
        for (const hasPoster of [true, false]) {
          for (const hasPeaks of [true, false]) {
            for (const hasDuration of [true, false]) {
              combos.push({ kind, variant, aspect, hasPoster, hasPeaks, hasDuration })
            }
          }
        }
      }
    }
  }
  return combos
}

export function isFilenameOnlyPreview(markup: string): boolean {
  const hasPlayer = /data-testid="chat-(?:video|audio)-player"/i.test(markup)
    || /<video[\s>]|<audio[\s>]/i.test(markup)
  const looksLikeChip = /paperclip|filename-only|getFileIcon/i.test(markup)
  return looksLikeChip && !hasPlayer
}
