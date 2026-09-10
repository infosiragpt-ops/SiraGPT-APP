export type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"
export type ImageGenerationCount = 1 | 2 | 3 | 4 | 5
export type ImageQuality = "512px" | "1K" | "2K" | "4K"
export type VideoResolution = "480p" | "720p" | "1080p"
export type VideoAspectRatio = "auto" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9"
export type VideoDuration = number
export type VoiceModel =
  | "Sira Voz"
  | "Multilingual V2"
  | "Eleven V3"
  | "Flash V2.5"
  | "Gemini Flash TTS"
  | "Gemini Pro TTS"
  | "OpenAI TTS"
  | "OpenAI TTS HD"
  | "GPT-4o mini TTS"
  | "Turbo V2.5"
  // Legacy labels (pre-catalog UI). Still resolve server-side via
  // voice-director aliases; kept in the type so stored values compile.
  | "Gemini 2.5 Flash TTS"
  | "ElevenLabs"
export type VoiceLanguage =
  | "Spanish" | "English" | "Portuguese" | "French" | "German"
  | "Italian" | "Dutch" | "Polish" | "Russian" | "Ukrainian"
  | "Turkish" | "Arabic" | "Hindi" | "Japanese" | "Chinese"
  | "Korean" | "Indonesian" | "Swedish" | "Bulgarian" | "Romanian"
  | "Czech" | "Greek" | "Finnish" | "Croatian" | "Malay"
  | "Slovak" | "Danish" | "Tamil" | "Filipino" | "Hungarian"
  | "Norwegian" | "Vietnamese" | "Hebrew" | "Catalan" | "Bengali"
  | "Afrikaans" | "Armenian" | "Assamese" | "Azerbaijani" | "Belarusian"
  | "Serbian" | "Thai" | "Urdu" | "Swahili"
export type VoiceAccent = string
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
export const VIDEO_RESOLUTION_OPTIONS: readonly VideoResolution[] = ["480p", "720p", "1080p"]
export const VIDEO_ASPECT_RATIO_OPTIONS: ReadonlyArray<MediaAspectRatioOption<VideoAspectRatio>> = [
  { value: "auto", label: "Auto", ratio: "Auto", className: "h-6 w-6", visibleByDefault: true },
  { value: "16:9", label: "Wide", ratio: "16:9", className: "h-[16px] w-8", visibleByDefault: true },
  { value: "9:16", label: "Story", ratio: "9:16", className: "h-8 w-[16px]", visibleByDefault: true },
  { value: "1:1", label: "Square", ratio: "1:1", className: "h-7 w-7", visibleByDefault: true },
  { value: "4:3", label: "Classic", ratio: "4:3", className: "h-[22px] w-8", visibleByDefault: true },
  { value: "3:4", label: "Portrait", ratio: "3:4", className: "h-8 w-6" },
  { value: "21:9", label: "Cinema", ratio: "21:9", className: "h-[14px] w-9" },
]
export const VIDEO_DURATION_OPTIONS: readonly VideoDuration[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]
export const VIDEO_DURATION_PINNED_OPTIONS: readonly VideoDuration[] = [8, 15, 30]
export const VOICE_MODEL_OPTIONS: readonly VoiceModel[] = [
  "Sira Voz",
  "Multilingual V2",
  "Eleven V3",
  "Flash V2.5",
  "Gemini Flash TTS",
  "Gemini Pro TTS",
  "OpenAI TTS",
  "OpenAI TTS HD",
  "GPT-4o mini TTS",
  "Turbo V2.5",
]
export const VOICE_LANGUAGE_OPTIONS: readonly VoiceLanguage[] = [
  "Spanish", "English", "Portuguese", "French", "German",
  "Italian", "Dutch", "Polish", "Russian", "Ukrainian",
  "Turkish", "Arabic", "Hindi", "Japanese", "Chinese",
  "Korean", "Indonesian", "Swedish", "Bulgarian", "Romanian",
  "Czech", "Greek", "Finnish", "Croatian", "Malay",
  "Slovak", "Danish", "Tamil", "Filipino", "Hungarian",
  "Norwegian", "Vietnamese", "Hebrew", "Catalan", "Bengali",
  "Afrikaans", "Armenian", "Assamese", "Azerbaijani", "Belarusian",
  "Serbian", "Thai", "Urdu", "Swahili",
]
// Legacy fallback list — the accent submenu always shows
// voiceAccentsFor(language) instead.
export const VOICE_ACCENT_OPTIONS: readonly VoiceAccent[] = ["Neutral", "Latino", "US", "British", "Mexican", "Spain"]
export const VOICE_EFFECT_OPTIONS: readonly VoiceEffect[] = ["None", "Studio Clean", "Warm", "Cinematic", "Narration", "Podcast"]

// ── Professional voice catalog (UI mirror of the backend voice-director) ────
// Engine metadata for the model picker; the backend re-validates and
// auto-corrects every combination, so the UI can never send an impossible
// one (e.g. Turbo V2 + Spanish) without the server upgrading it and
// reporting a warning.
export type VoiceProvider = "ElevenLabs" | "Google" | "OpenAI" | "Local"

export interface VoiceModelMeta {
  /** Display label — this exact string is sent as `model` to /ai/generate-speech. */
  label: string
  provider: VoiceProvider
  badge: string
  languages: string
  bestFor: string[]
  description: string
  iconName: string
}

export const VOICE_MODEL_CATALOG: VoiceModelMeta[] = [
  { label: "Sira Voz", provider: "Local", badge: "Local", languages: "Tu voz", bestFor: ["Clonar", "Gratis"], description: "Tus voces clonadas. 100 % local y gratis.", iconName: "Mic" },
  { label: "Multilingual V2", provider: "ElevenLabs", badge: "Natural", languages: "29 idiomas", bestFor: ["Narración", "Audiolibros"], description: "La voz más natural y consistente.", iconName: "Bot" },
  { label: "Eleven V3", provider: "ElevenLabs", badge: "Expresivo", languages: "70+ idiomas", bestFor: ["Efectos", "Acentos marcados"], description: "Máxima expresividad con acentos y efectos nativos.", iconName: "Bot" },
  { label: "Flash V2.5", provider: "ElevenLabs", badge: "Rápido", languages: "32 idiomas", bestFor: ["Tiempo real", "Textos largos"], description: "Ultra-baja latencia; hasta 40.000 caracteres.", iconName: "Bot" },
  { label: "Gemini Flash TTS", provider: "Google", badge: "Versátil", languages: "100+ idiomas", bestFor: ["Cualquier idioma", "Fallback universal"], description: "Cobertura universal de idiomas.", iconName: "GeminiLogo" },
  { label: "Gemini Pro TTS", provider: "Google", badge: "Estudio", languages: "100+ idiomas", bestFor: ["Calidad máxima"], description: "Máxima fidelidad en direcciones complejas.", iconName: "GeminiLogo" },
  { label: "OpenAI TTS", provider: "OpenAI", badge: "Directo", languages: "Multilingüe", bestFor: ["Latencia", "Voces OpenAI"], description: "Síntesis directa de OpenAI (tts-1).", iconName: "Bot" },
  { label: "OpenAI TTS HD", provider: "OpenAI", badge: "Calidad", languages: "Multilingüe", bestFor: ["Calidad"], description: "Versión HD de OpenAI TTS.", iconName: "Bot" },
  { label: "GPT-4o mini TTS", provider: "OpenAI", badge: "Dirigible", languages: "Multilingüe", bestFor: ["Dirección por instrucciones"], description: "Acepta instrucciones de estilo y acento.", iconName: "Bot" },
  { label: "Turbo V2.5", provider: "ElevenLabs", badge: "Legacy", languages: "32 idiomas", bestFor: ["Compatibilidad"], description: "Primera generación; se recomienda Flash V2.5.", iconName: "Bot" },
]

const ELEVEN_VOICE_LABELS = new Set(
  VOICE_MODEL_CATALOG.filter((m) => m.provider === "ElevenLabs").map((m) => m.label),
)

const NON_ELEVEN_VOICE_LABELS = new Set(
  VOICE_MODEL_CATALOG.filter((m) => m.provider !== "ElevenLabs").map((m) => m.label),
)

/** Whether the model uses an ElevenLabs voice id (shows the voice catalog disc). */
export function isElevenVoiceModel(label: string): boolean {
  // Exact catalog labels first: "Gemini Flash TTS" contains "flash" but is
  // NOT ElevenLabs.
  if (NON_ELEVEN_VOICE_LABELS.has(label)) return false
  if (ELEVEN_VOICE_LABELS.has(label)) return true
  // Backward compat with pre-catalog labels ("ElevenLabs", "eleven-turbo-v2", …).
  // NOTE: bare "flash" is intentionally NOT matched — it would false-positive
  // on "Gemini Flash TTS".
  return /eleven|turbo|multilingual/i.test(label)
}

export function voiceModelMeta(label: string): VoiceModelMeta | undefined {
  return VOICE_MODEL_CATALOG.find((m) => m.label === label)
}

// ─── Accents per language ───────────────────────────────────────────────────
const VOICE_ACCENTS_BY_LANGUAGE: Record<string, string[]> = {
  English: ["US", "British", "Australian", "Canadian", "Indian", "Neutral"],
  Spanish: ["Latino", "Mexican", "Spain", "Argentino", "Colombiano", "Neutral"],
  Portuguese: ["Brazilian", "European", "Neutral"],
  French: ["France", "Quebec", "Belgian", "Neutral"],
  German: ["Standard", "Austrian", "Swiss", "Neutral"],
  Italian: ["Standard", "Northern", "Southern", "Neutral"],
  Dutch: ["Standard", "Flemish", "Neutral"],
  Arabic: ["Modern Standard", "Egyptian", "Gulf", "Levantine"],
  Hindi: ["Standard", "Neutral"],
  Chinese: ["Mandarin Mainland", "Taiwanese", "Neutral"],
}

const GENERIC_VOICE_ACCENTS = ["Neutral", "Standard", "Formal"]

/** Every accent the UI can produce (used to validate persisted settings). */
const ALL_KNOWN_VOICE_ACCENTS = new Set<string>([
  ...VOICE_ACCENT_OPTIONS,
  "Spanish", // legacy fixed-list member
  ...Object.values(VOICE_ACCENTS_BY_LANGUAGE).flat(),
  ...GENERIC_VOICE_ACCENTS,
])

export function voiceAccentsFor(language: string): string[] {
  return VOICE_ACCENTS_BY_LANGUAGE[language] || GENERIC_VOICE_ACCENTS
}

const DEFAULT_VOICE_ACCENT_BY_LANGUAGE: Record<string, string> = {
  English: "US",
  Spanish: "Latino",
  Portuguese: "Brazilian",
  French: "France",
  German: "Standard",
  Italian: "Standard",
  Dutch: "Standard",
  Arabic: "Modern Standard",
  Hindi: "Standard",
  Chinese: "Mandarin Mainland",
}

export function defaultVoiceAccentFor(language: string): string {
  return DEFAULT_VOICE_ACCENT_BY_LANGUAGE[language] || "Neutral"
}

// ─── Effects ────────────────────────────────────────────────────────────────
export interface VoiceEffectMeta {
  name: VoiceEffect
  description: string
}

export const VOICE_EFFECT_CATALOG: VoiceEffectMeta[] = [
  { name: "Studio Clean", description: "Cabina tratada, máxima inteligibilidad." },
  { name: "Narration", description: "Audiolibro: cadencia estable y cuidada." },
  { name: "Podcast", description: "Conversacional, energía natural." },
  { name: "Warm", description: "Íntima y cercana, presencia cálida." },
  { name: "Cinematic", description: "Tráiler dramático, pausas marcadas." },
  { name: "None", description: "Voz tal cual, sin dirección." },
]

// ─── Stability ──────────────────────────────────────────────────────────────
export function describeVoiceStability(value: number): string {
  if (!Number.isFinite(value)) return "Equilibrado"
  if (value < 25) return "Muy expresivo"
  if (value < 50) return "Expresivo"
  if (value < 75) return "Equilibrado"
  if (value < 90) return "Estable"
  return "Ultra estable"
}

export const VOICE_STABILITY_PRESETS: Array<{ name: string; value: number; hint: string }> = [
  { name: "Publicidad", value: 35, hint: "Máxima expresividad." },
  { name: "Conversación", value: 55, hint: "Natural y dinámica." },
  { name: "Audiolibro", value: 72, hint: "Consistente en textos largos." },
  { name: "Narración", value: 80, hint: "Estable y clara." },
]

// ─── Browser TTS last resort ────────────────────────────────────────────────
// When NO provider is configured anywhere, the backend answers 503 with
// `{ fallback: "browser-tts", languageBcp47, rate }` and these helpers speak
// locally via the Web Speech API — voice works with zero keys.
const VOICE_BCP47_BY_LANGUAGE: Record<string, string> = {
  Spanish: "es-ES", English: "en-US", Portuguese: "pt-BR", French: "fr-FR",
  German: "de-DE", Italian: "it-IT", Dutch: "nl-NL", Polish: "pl-PL",
  Russian: "ru-RU", Ukrainian: "uk-UA", Turkish: "tr-TR", Arabic: "ar-SA",
  Hindi: "hi-IN", Japanese: "ja-JP", Chinese: "cmn-CN", Korean: "ko-KR",
  Indonesian: "id-ID", Swedish: "sv-SE", Bulgarian: "bg-BG", Romanian: "ro-RO",
  Czech: "cs-CZ", Greek: "el-GR", Finnish: "fi-FI", Croatian: "hr-HR",
  Malay: "ms-MY", Slovak: "sk-SK", Danish: "da-DK", Tamil: "ta-IN",
  Filipino: "fil-PH", Hungarian: "hu-HU", Norwegian: "nb-NO", Vietnamese: "vi-VN",
  Hebrew: "he-IL", Catalan: "ca-ES", Bengali: "bn-BD", Afrikaans: "af-ZA",
  Armenian: "hy-AM", Assamese: "as-IN", Azerbaijani: "az-AZ", Belarusian: "be-BY",
  Serbian: "sr-RS", Thai: "th-TH", Urdu: "ur-PK", Swahili: "sw-KE",
}

export function voiceBcp47For(language: string): string {
  return VOICE_BCP47_BY_LANGUAGE[language] || "es-ES"
}

export function browserTtsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as any).speechSynthesis !== "undefined" &&
    typeof (window as any).SpeechSynthesisUtterance !== "undefined"
  )
}

export function speakWithBrowserVoice(
  text: string,
  opts: { bcp47?: string; rate?: number; onEnd?: () => void } = {},
): () => void {
  const synth = (window as any).speechSynthesis as SpeechSynthesis
  synth.cancel()
  const utterance = new (window as any).SpeechSynthesisUtterance(text) as SpeechSynthesisUtterance
  const wanted = String(opts.bcp47 || "es-ES").toLowerCase()
  const prefix = wanted.split("-")[0]
  let voices: SpeechSynthesisVoice[] = []
  try {
    voices = synth.getVoices() || []
  } catch {
    voices = []
  }
  const match =
    voices.find((v) => String(v.lang || "").toLowerCase() === wanted) ||
    voices.find((v) => String(v.lang || "").toLowerCase().startsWith(prefix)) ||
    voices.find((v) => v.default) ||
    voices[0]
  if (match) {
    utterance.voice = match
    utterance.lang = match.lang
  } else {
    utterance.lang = opts.bcp47 || "es-ES"
  }
  const rate = Number(opts.rate)
  utterance.rate = Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1
  if (opts.onEnd) utterance.onend = opts.onEnd
  synth.speak(utterance)
  return () => {
    try {
      synth.cancel()
    } catch {
      /* already gone */
    }
  }
}
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
  isActive?: unknown
  virtual?: unknown
  id?: unknown
}

export function providerForMediaModel(modelName: string, fallback = DEFAULT_IMAGE_PROVIDER): string {
  const value = String(modelName || "").toLowerCase()
  if (value.includes("deepseek")) return "DeepSeek"
  if (value.includes("openrouter")) return "DeepSeek"
  if (value.includes("seedream")) return "OpenAI"
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

/**
 * Admin-catalog visibility for the /chat Video picker.
 * Same flags as Admin > AI Models: type=VIDEO and isActive=true.
 * A model missing from the admin catalog (no VIDEO type) is treated as hidden.
 */
export function isAdminVisibleVideoModel(model: MediaModelEntry | null | undefined): boolean {
  if (!model) return false
  const name = String(model.name || "").trim()
  if (!name) return false
  const type = String(model.type || model.kind || "").trim().toUpperCase()
  if (type !== "VIDEO") return false
  if (model.isActive === false) return false
  if (model.virtual === true) return false
  const id = String(model.id || "").trim()
  if (id.startsWith("__virtual_")) return false
  return true
}

export function filterAdminVisibleVideoModels<T extends MediaModelEntry>(
  models: T[] | null | undefined,
): T[] {
  return (Array.isArray(models) ? models : []).filter(isAdminVisibleVideoModel)
}

/** FE-068: image/video generate must never fall through to OpenRouter text models. */
export function isForbiddenMediaTextModel(name?: string, provider?: string): boolean {
  const s = `${name || ""} ${provider || ""}`.toLowerCase()
  if (!s.trim()) return false
  const isMedia = /image|video|imagen|veo|kling|dall|seedream|sora|flux|midjourney|ideogram|gpt-image/.test(s)
  if (/openrouter/.test(s) && !isMedia) return true
  if (/(^|\s)(gpt-4|gpt-3|claude|gemini-2\.5-pro|deepseek-v4-flash|deepseek-v4-pro)(\s|$)/.test(s) && !isMedia) return true
  return false
}

export function assertMediaGenerateModel(name?: string, provider?: string): void {
  if (isForbiddenMediaTextModel(name, provider)) {
    const err = new Error("openrouter_text_model_forbidden")
    err.name = "ModelForbiddenError"
    throw err
  }
}

export function filterMediaModels<T extends { name?: string; provider?: string; type?: string; kind?: string }>(
  models: T[] | null | undefined,
): T[] {
  return (Array.isArray(models) ? models : []).filter((model) => !isForbiddenMediaTextModel(model?.name, model?.provider))
}

/**
 * Voice composer settings persisted per browser (same pattern as the effort
 * picker's `sira:composer:effort`): language/accent/effect/stability and the
 * provider model survive reloads. Values are validated on read — a stale or
 * foreign entry falls back to the default. The model name itself is dynamic
 * (live catalog), so it is only re-validated against the catalog on open.
 */
export const VOICE_SETTINGS_STORAGE_KEYS = {
  model: "sira:composer:voice:model",
  language: "sira:composer:voice:language",
  accent: "sira:composer:voice:accent",
  stability: "sira:composer:voice:stability",
  effect: "sira:composer:voice:effect",
} as const

export type VoiceSettingKey = keyof typeof VOICE_SETTINGS_STORAGE_KEYS

const VOICE_SETTING_DEFAULTS: Record<VoiceSettingKey, string | number> = {
  model: "",
  language: "Spanish",
  accent: "Latino",
  stability: 100,
  effect: "Studio Clean",
}

function readVoiceStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function validatedVoiceSetting(key: VoiceSettingKey, raw: string | null): string | number {
  const fallback = VOICE_SETTING_DEFAULTS[key]
  if (raw == null || raw === "") return fallback
  if (key === "stability") {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback
  }
  if (key === "language") return (VOICE_LANGUAGE_OPTIONS as readonly string[]).includes(raw) ? raw : fallback
  if (key === "accent") return ALL_KNOWN_VOICE_ACCENTS.has(raw) ? raw : fallback
  if (key === "effect") return (VOICE_EFFECT_OPTIONS as readonly string[]).includes(raw) ? raw : fallback
  return raw
}

export function readStoredVoiceSetting(key: VoiceSettingKey, fallback: string | number): string | number {
  const stored = readVoiceStorage(VOICE_SETTINGS_STORAGE_KEYS[key])
  if (stored == null || stored === "") return fallback
  return validatedVoiceSetting(key, stored)
}

export function writeStoredVoiceSettings(patch: Partial<Record<VoiceSettingKey, string | number>>): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in VOICE_SETTINGS_STORAGE_KEYS)) continue
      window.localStorage.setItem(
        VOICE_SETTINGS_STORAGE_KEYS[key as VoiceSettingKey],
        String(value ?? ""),
      )
    }
  } catch {
    /* private mode / quota — settings simply don't persist */
  }
}

// ── Sira Voz (VoiceStudio, open source, 100 % local, free) ──────────────────
// The Voz picker lists the Admin-active AUDIO rows by their catalog `name`;
// the local studio row is `sira-voz` (displayName "Sira Voz"). Matching by
// pattern keeps the chip working if the row is ever renamed in Admin.
export const SIRA_VOZ_MODEL_RE = /sira[-_\s]?voz|voice[-_\s]?studio|omnivoice/i

export function isSiraVozModel(value: unknown): boolean {
  return SIRA_VOZ_MODEL_RE.test(String(value ?? ""))
}

export const SIRA_VOZ_LABEL = "Sira Voz"
export const SIRA_VOZ_TAGLINE = "Clona voces, dobla vídeos, transcribe y crea audiolibros. 100 % local y gratis."

/** The user's cloned voice chosen for Sira Voz (persisted per browser). */
export const VOICE_STUDIO_STORAGE_KEYS = {
  voiceId: "sira:composer:voice:studio-voice-id",
  voiceName: "sira:composer:voice:studio-voice-name",
} as const

export function readStoredVoiceStudioVoice(): { id: string; name: string } {
  const id = readVoiceStorage(VOICE_STUDIO_STORAGE_KEYS.voiceId) || ""
  const name = readVoiceStorage(VOICE_STUDIO_STORAGE_KEYS.voiceName) || ""
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { id: "", name: "" }
  return { id, name: name.slice(0, 80) }
}

export function writeStoredVoiceStudioVoice(voice: { id: string; name: string } | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return
    if (!voice || !voice.id) {
      window.localStorage.removeItem(VOICE_STUDIO_STORAGE_KEYS.voiceId)
      window.localStorage.removeItem(VOICE_STUDIO_STORAGE_KEYS.voiceName)
      return
    }
    window.localStorage.setItem(VOICE_STUDIO_STORAGE_KEYS.voiceId, String(voice.id))
    window.localStorage.setItem(VOICE_STUDIO_STORAGE_KEYS.voiceName, String(voice.name || "").slice(0, 80))
  } catch {
    /* private mode / quota — the pick simply does not persist */
  }
}
