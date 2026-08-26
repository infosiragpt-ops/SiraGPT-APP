/**
 * Shared black-and-white chrome for composer media-mode chips
 * (Imágenes, Voz, Música, Video). Settings never change chip color.
 */
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_COUNT_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  VOICE_ACCENT_OPTIONS,
  VOICE_EFFECT_OPTIONS,
  VOICE_LANGUAGE_OPTIONS,
  type ImageAspectRatio,
  type ImageGenerationCount,
  type ImageQuality,
  type VoiceAccent,
  type VoiceEffect,
  type VoiceLanguage,
} from "./media-composer-config"

export type MediaMode = "image" | "voice" | "music" | "video"

export type ImageChipSettings = {
  aspect: ImageAspectRatio
  quality: ImageQuality
  count: ImageGenerationCount
}

export type VoiceChipSettings = {
  language: VoiceLanguage
  accent: VoiceAccent
  effect: VoiceEffect
  stability: number
}

/** Tokens that must never appear on media-mode chip className/style. */
export const FORBIDDEN_MEDIA_CHIP_COLOR_RE =
  /purple|violet|fuchsia|indigo|celeste|sky-400|sky-500|cyan|#7c3aed|#8b5cf6|#a855f7|#38bdf8|#0ea5e9|#22d3ee|#06b6d4|from-purple|to-pink|bg-purple|text-purple|bg-cyan|text-cyan|border-cyan|emerald-|teal-|pink-500/i

export const MEDIA_MODE_CHIP_LAYOUT_CLASS =
  "relative isolate flex h-7 sm:h-8 shrink-0 items-center gap-1 sm:gap-1.5 overflow-hidden rounded-full border px-2 sm:px-3 text-[11px] sm:text-[14px] font-semibold backdrop-blur-xl transition-all duration-300 hover:scale-[1.01]"

export const MEDIA_MODE_CHIP_CLOSE_CLASS =
  "media-mode-chip__close relative z-10 ml-0.5 sm:ml-1 h-4 sm:h-5 w-4 sm:w-5 rounded-full p-0 hover:bg-white/15 dark:hover:bg-white/10"

export const MEDIA_MENU_ICON_WRAP_CLASS =
  "liquid-icon w-8 h-8 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center"

export const MEDIA_MENU_ICON_GLYPH_CLASS = "h-4 w-4 text-zinc-800 dark:text-zinc-100"

export const MEDIA_MENU_DOT_CLASS = "w-2 h-2 shrink-0 bg-zinc-900 dark:bg-zinc-100 rounded-full"

export const VOICE_STABILITY_SLIDER_CLASS = "mt-2 voice-stability-slider"

export const VOICE_STABILITY_GRID: readonly number[] = Object.freeze(
  Array.from({ length: 21 }, (_, index) => index * 5),
)

const MODE_CHIP_CLASS: Record<MediaMode, string> = {
  image: `media-mode-chip image-liquid-chip group/image-liquid ${MEDIA_MODE_CHIP_LAYOUT_CLASS}`,
  voice: `media-mode-chip voice-mode-chip group/voice-liquid ${MEDIA_MODE_CHIP_LAYOUT_CLASS}`,
  music: `media-mode-chip music-mode-chip group/music-liquid ${MEDIA_MODE_CHIP_LAYOUT_CLASS}`,
  video: `media-mode-chip video-mode-chip group/video-liquid ${MEDIA_MODE_CHIP_LAYOUT_CLASS}`,
}

export function mediaModeChipChrome(
  mode: MediaMode,
): { className: string; style: Record<string, string> | undefined } {
  return {
    className: MODE_CHIP_CLASS[mode],
    style: undefined,
  }
}

export function chipChromeForImageSettings(_settings: ImageChipSettings) {
  return mediaModeChipChrome("image")
}

export function chipChromeForVoiceSettings(_settings: VoiceChipSettings) {
  return mediaModeChipChrome("voice")
}

export function isMediaPromptSendEnabled(prompt: string): boolean {
  return prompt.trim().length > 0
}

export function imageSettingCombos(): ImageChipSettings[] {
  const combos: ImageChipSettings[] = []
  for (const aspect of IMAGE_ASPECT_RATIO_OPTIONS) {
    for (const quality of IMAGE_QUALITY_OPTIONS) {
      for (const count of IMAGE_COUNT_OPTIONS) {
        combos.push({ aspect: aspect.value, quality, count })
      }
    }
  }
  return combos
}

export function voiceSettingCombos(): VoiceChipSettings[] {
  const combos: VoiceChipSettings[] = []
  for (const language of VOICE_LANGUAGE_OPTIONS) {
    for (const accent of VOICE_ACCENT_OPTIONS) {
      for (const effect of VOICE_EFFECT_OPTIONS) {
        for (const stability of VOICE_STABILITY_GRID) {
          combos.push({ language, accent, effect, stability })
        }
      }
    }
  }
  return combos
}

export function forbiddenColorHits(className: string, style?: unknown): string[] {
  const haystack = `${className} ${typeof style === "string" ? style : JSON.stringify(style ?? {})}`
  return haystack.match(new RegExp(FORBIDDEN_MEDIA_CHIP_COLOR_RE.source, "gi")) || []
}

export function assertMonochromeChipChrome(className: string, style?: unknown): void {
  const hits = forbiddenColorHits(className, style)
  if (hits.length > 0) {
    throw new Error(`media-mode chip chrome is not black-and-white: ${hits.join(", ")}`)
  }
}
