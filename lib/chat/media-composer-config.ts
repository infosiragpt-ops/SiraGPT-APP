export type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"
export type ImageGenerationCount = 1 | 2 | 3 | 4 | 5
export type ImageQuality = "512px" | "1K" | "2K" | "4K"
export type VideoResolution = "480p" | "720p"
export type VideoAspectRatio = "auto" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9"
export type VideoDuration = 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
export type VoiceModel = "Gemini 2.5 Flash TTS" | "ElevenLabs"
export type VoiceLanguage = "English" | "Spanish" | "German" | "French" | "Portuguese" | "Afrikaans" | "Arabic" | "Armenian" | "Assamese" | "Azerbaijani" | "Belarusian" | "Bengali"
export type VoiceAccent = "Neutral" | "Latino" | "US" | "British" | "Spanish" | "Mexican"
export type VoiceEffect = "None" | "Studio Clean" | "Warm" | "Cinematic" | "Narration" | "Podcast"
export type MusicModel = "ElevenLabs" | "Lyria 3 Pro" | "Mimo Max 02HD"
export type MusicStyle = "Auto" | "Cinematic" | "Pop" | "Electronic" | "Ambient" | "Orchestral" | "Latin" | "Hip-Hop" | "Jazz"
export type MusicMood = "Balanced" | "Energetic" | "Emotional" | "Dark" | "Happy" | "Epic" | "Relaxed"
export type MusicEffect = "None" | "Studio Master" | "Spatial" | "Warm Tape" | "Radio Ready" | "Lo-Fi"

export type MediaAspectRatioOption<T> = {
  value: T
  label: string
  ratio: string
  className: string
  visibleByDefault?: boolean
}

export const IMAGE_ASPECT_RATIO_OPTIONS: ReadonlyArray<MediaAspectRatioOption<ImageAspectRatio>> = [
  { value: "1:1", label: "Square", ratio: "1:1", className: "h-7 w-7", visibleByDefault: true },
  { value: "2:3", label: "Portrait", ratio: "2:3", className: "h-8 w-[22px]", visibleByDefault: true },
  { value: "3:2", label: "Landscape", ratio: "3:2", className: "h-[22px] w-8", visibleByDefault: true },
  { value: "3:4", label: "Portrait", ratio: "3:4", className: "h-8 w-6", visibleByDefault: true },
  { value: "4:3", label: "Classic", ratio: "4:3", className: "h-6 w-8" },
  { value: "9:16", label: "Story", ratio: "9:16", className: "h-8 w-[18px]" },
  { value: "16:9", label: "Wide", ratio: "16:9", className: "h-[18px] w-9", visibleByDefault: true },
]

export const IMAGE_QUALITY_OPTIONS: readonly ImageQuality[] = ["512px", "1K", "2K", "4K"]
export const IMAGE_COUNT_OPTIONS: readonly ImageGenerationCount[] = [1, 2, 3, 4, 5]
export const VIDEO_RESOLUTION_OPTIONS: readonly VideoResolution[] = ["480p", "720p"]
export const VIDEO_ASPECT_RATIO_OPTIONS: ReadonlyArray<MediaAspectRatioOption<VideoAspectRatio>> = [
  { value: "auto", label: "Auto", ratio: "Auto", className: "h-6 w-6", visibleByDefault: true },
  { value: "16:9", label: "Wide", ratio: "16:9", className: "h-[16px] w-8", visibleByDefault: true },
  { value: "9:16", label: "Story", ratio: "9:16", className: "h-8 w-[16px]", visibleByDefault: true },
  { value: "1:1", label: "Square", ratio: "1:1", className: "h-7 w-7", visibleByDefault: true },
  { value: "4:3", label: "Classic", ratio: "4:3", className: "h-[22px] w-8", visibleByDefault: true },
  { value: "3:4", label: "Portrait", ratio: "3:4", className: "h-8 w-6" },
  { value: "21:9", label: "Cinema", ratio: "21:9", className: "h-[14px] w-9" },
]
export const VIDEO_DURATION_OPTIONS: readonly VideoDuration[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
export const VOICE_MODEL_OPTIONS: readonly VoiceModel[] = ["Gemini 2.5 Flash TTS", "ElevenLabs"]
export const VOICE_LANGUAGE_OPTIONS: readonly VoiceLanguage[] = ["English", "Spanish", "German", "French", "Portuguese", "Afrikaans", "Arabic", "Armenian", "Assamese", "Azerbaijani", "Belarusian", "Bengali"]
export const VOICE_ACCENT_OPTIONS: readonly VoiceAccent[] = ["Neutral", "Latino", "US", "British", "Spanish", "Mexican"]
export const VOICE_EFFECT_OPTIONS: readonly VoiceEffect[] = ["None", "Studio Clean", "Warm", "Cinematic", "Narration", "Podcast"]
export const MUSIC_MODEL_OPTIONS: readonly MusicModel[] = ["ElevenLabs", "Lyria 3 Pro", "Mimo Max 02HD"]
export const MUSIC_STYLE_OPTIONS: readonly MusicStyle[] = ["Auto", "Cinematic", "Pop", "Electronic", "Ambient", "Orchestral", "Latin", "Hip-Hop", "Jazz"]
export const MUSIC_MOOD_OPTIONS: readonly MusicMood[] = ["Balanced", "Energetic", "Emotional", "Dark", "Happy", "Epic", "Relaxed"]
export const MUSIC_EFFECT_OPTIONS: readonly MusicEffect[] = ["None", "Studio Master", "Spatial", "Warm Tape", "Radio Ready", "Lo-Fi"]

export const MUSIC_STYLE_PROFILES: Readonly<Record<MusicStyle, { label: string; description: string; accentClass: string }>> = {
  Auto: { label: "Auto", description: "Deja que el modelo elija el genero segun tu prompt.", accentClass: "bg-zinc-900 dark:bg-white" },
  Cinematic: { label: "Cinematic", description: "Texturas amplias, tension y final de trailer.", accentClass: "bg-violet-500" },
  Pop: { label: "Pop", description: "Hook claro, bateria pulida y estructura comercial.", accentClass: "bg-pink-500" },
  Electronic: { label: "Electronic", description: "Sintetizadores, pulso moderno y energia digital.", accentClass: "bg-cyan-500" },
  Ambient: { label: "Ambient", description: "Capas suaves, atmosfera y movimiento discreto.", accentClass: "bg-teal-500" },
  Orchestral: { label: "Orchestral", description: "Cuerdas, metales y dinamica de partitura.", accentClass: "bg-amber-500" },
  Latin: { label: "Latin", description: "Ritmo calido, percusion marcada y sabor latino.", accentClass: "bg-orange-500" },
  "Hip-Hop": { label: "Hip-Hop", description: "Beat con groove, bajo presente y espacio vocal.", accentClass: "bg-slate-700 dark:bg-slate-300" },
  Jazz: { label: "Jazz", description: "Armonia rica, swing sutil e instrumentacion organica.", accentClass: "bg-emerald-600" },
}

export const VOICE_COMPOSER_PLACEHOLDER = "Escribe el texto que quieres convertir en voz"
export const DEFAULT_IMAGE_MODEL = ""
export const DEFAULT_IMAGE_PROVIDER = "OpenAI"
export const DEFAULT_VIDEO_MODEL = ""
export const DEFAULT_VIDEO_DURATION: VideoDuration = 8

type MediaModelEntry = {
  type?: unknown
  kind?: unknown
  name?: unknown
  displayName?: unknown
  provider?: unknown
}

export function providerForMediaModel(modelName: string, fallback = DEFAULT_IMAGE_PROVIDER): string {
  const value = String(modelName || "").toLowerCase()
  if (value.includes("/")) return "OpenRouter"
  if (value.includes("openrouter") || value.includes("seedream")) return "OpenRouter"
  if (value.includes("google") || value.includes("imagen") || value.includes("gemini") || value.includes("veo")) return "Google"
  if (value.includes("kling")) return "Kling"
  if (value.includes("openai") || value.includes("dall") || value.includes("gpt-image")) return "OpenAI"
  return fallback
}

export function isImageModelEntry(model: MediaModelEntry | null | undefined): boolean {
  const type = String(model?.type || model?.kind || "").toLowerCase()
  const label = `${model?.name || ""} ${model?.displayName || ""} ${model?.provider || ""}`
  return type === "image" || type === "images" || type.includes("image") || /image|imagen|dall|seedream|flux|stable|midjourney|ideogram|recraft|gpt-image/i.test(label)
}

export function isVideoModelEntry(model: MediaModelEntry | null | undefined): boolean {
  const type = String(model?.type || model?.kind || "").toLowerCase()
  const label = `${model?.name || ""} ${model?.displayName || ""} ${model?.provider || ""}`
  return type === "video" || type === "videos" || type.includes("video") || /video|text-to-video|image-to-video|veo|kling|sora|seedance|pixverse|hailuo|ltx|wan|cosmos|fal\.ai/i.test(label)
}
