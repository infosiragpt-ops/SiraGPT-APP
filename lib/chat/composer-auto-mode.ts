/**
 * Auto mode for the /agentes composer.
 *
 * "crea una imagen de un gato", "hazme un word con…", "genera una ppt sobre…",
 * "haz un video de…", "compón una canción…", "narra este texto", "busca en
 * internet…": the request itself says which tool the user wants. This pure,
 * deterministic classifier turns that into a composer mode + the settings the
 * text implies (aspect ratio, count, quality, duration…) so the right chip
 * switches on with sensible defaults before the send — the user never has to
 * open the "+" menu first.
 *
 * Reuses the routing vocabulary of lib/ai-service.ts (video/music/voice media
 * patterns, image-analysis guard, output-format requests) and mirrors the
 * backend media-intent lexicon, so client and server agree.
 */

import {
  ROUTING_PATTERNS,
  extractRequestedVideoAspectRatio,
  extractRequestedVideoAudio,
  extractRequestedVideoDurationSeconds,
  extractRequestedVideoResolution,
  isImageAnalysisPrompt,
  shouldAutoActivateVideoGeneration,
} from "@/lib/ai-service"
import { detectDocumentChatFormat } from "@/lib/document-chat-request"
import { canonicalizeImageTypos, detectExplicitImageCount, detectImageFrame, IMAGE_COUNT_MAX } from "@/lib/chat/image-request-lexicon"

export type ComposerAutoMode = "image" | "video" | "music" | "voice" | "web_search" | "docx" | "xlsx" | "pptx"

export type ComposerAutoSettings = {
  imageAspectRatio?: string
  imageCount?: number
  imageQuality?: string
  videoDuration?: number
  videoAspectRatio?: string
  videoResolution?: string
  videoAudio?: boolean
  musicDurationSeconds?: number
  musicStyle?: string
  musicMood?: string
  musicEffect?: string
  documentFormat?: "docx" | "xlsx" | "pptx"
}

export type ComposerAutoDecision = {
  mode: ComposerAutoMode
  confidence: "high" | "medium"
  settings: ComposerAutoSettings
  cleanedPrompt: string
  reason: string
}

export type ComposerAutoContext = {
  attachments?: Array<{ name?: string | null; mimeType?: string | null; type?: string | null }>
  activeMode?: ComposerAutoMode | null
}

function normalize(text: string): string {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

// Verbs that mean "produce it", shared by every mode.
const CREATE_VERB =
  "(?:cr(?:ea|eame|ear|eas)|gener(?:a|ame|ar|as|ate)|haz(?:me|melo|lo|la)?|hace(?:r|me)|dame|quiero|necesito|produc(?:e|eme|ir)|dise[nñ](?:a|ame|ar)|dibuj(?:a|ame|ar)|pint(?:a|ame|ar)|ilustr(?:a|ame|ar)|render(?:iza|izar)?|make|create|generate|draw|design|render|produce|want|need|give me|gimme)"

const IMAGE_NOUN =
  "(?:imagen(?:es)?|image(?:s)?|foto(?:s|grafia|grafias)?|photo(?:s|graph|graphs)?|picture(?:s)?|pic(?:s)?|ilustraci(?:on|ones)|illustration(?:s)?|dibujo(?:s)?|drawing(?:s)?|logo(?:tipo|tipos|s)?|render(?:s)?|poster(?:s)?|afiche(?:s)?|banner(?:s)?|portada(?:s)?|wallpaper(?:s)?|thumbnail(?:s)?|miniatura(?:s)?|icono(?:s)?|icon(?:s)?|sticker(?:s)?|retrato(?:s)?|caricatura(?:s)?|infograf(?:ia|ias)|arte digital|pixel art)"

const IMAGE_CREATE_RE = new RegExp(
  `\\b${CREATE_VERB}\\b[^.?!]{0,90}\\b${IMAGE_NOUN}\\b|\\b${IMAGE_NOUN}\\b[^.?!]{0,60}\\b${CREATE_VERB}\\b`,
  "i",
)

// "imagen corporativa/mental/de marca" and similar are not pictures.
const IMAGE_FALSE_POSITIVE_RE =
  /\b(?:imagen (?:corporativa|mental|de marca|publica|personal|profesional|institucional)|imagen que (?:proyect|d[ae]|transmit)|buena imagen|mala imagen|foto(?:s)? de perfil (?:que|donde)|logo(?:tipo)?s? (?:existentes?|actual(?:es)?) (?:que|y))\b/i

const MUSIC_FALSE_POSITIVE_RE =
  /\b(?:letra(?:s)? (?:de|para) (?:una |la )?canci[oó]n|escrib\w* (?:la |una )?(?:letra|canci[oó]n)|analiza\w* (?:la |esta )?canci[oó]n|acordes|partitura|tablatura|historia de la m[uú]sica|teor[ií]a musical)\b/i

const VOICE_FALSE_POSITIVE_RE =
  /\b(?:tu (?:voz|opini[oó]n)|voz (?:pasiva|activa)|en voz alta te|dar(?:le)? voz a|voz de mando|voz narrativa|voz del autor)\b/i

const QUESTION_OR_IDEATION_RE =
  /^(?:que|qu[eé]|cual|cu[aá]l|como|c[oó]mo|por que|por qu[eé]|cuando|cu[aá]ndo|donde|d[oó]nde|quien|qui[eé]n|cuanto|cu[aá]nto|explica|explicame|dime|cuentame|recomienda|sugiere|ideas? (?:de|para)|opciones (?:de|para))\b/i

const WEB_SEARCH_RE =
  /\b(?:busca(?:me|r)?|buscalo|investiga(?:me|r)?|averigua(?:me|r)?|consulta(?:me|r)?|search|look up|google(?:a|alo|ar)?)\b[^.?!]{0,60}\b(?:en (?:internet|la web|google|la red|linea|online)|online|noticias|ultim(?:a|as|o|os) (?:noticias|novedades)|actualizad[oa]|hoy|esta semana|este mes|precio actual|cotizaci[oó]n)\b|\b(?:ultim(?:as|os) noticias|noticias de hoy|que paso hoy|que esta pasando|tendencias actuales)\b/i

const DOC_CREATE_RE =
  /\b(?:cr(?:ea|eame|ear)|gener(?:a|ame|ar)|haz(?:me)?|hace(?:r|me)|dame|quiero|necesito|elabora(?:me|r)?|redacta(?:me|r)?|prepara(?:me|r)?|arma(?:me|r)?|construye(?:me|r)?|exporta(?:me|r|lo|la|los|las)?|descarga(?:me|r|lo|la)?|convierte(?:lo|la|me|r)?|pasa(?:lo|la|me|r)?|make|create|generate|write|build|export)\b[^.?!]{0,80}\b(?:word|docx?|excel|xlsx?|hoja de calculo|spreadsheet|ppt|pptx|power ?point|presentaci[oó]n|diapositivas|slides?|deck|documento|informe|reporte|memoria|ensayo|monografia|tesis|carta|oficio|solicitud|curriculum|cv|contrato|acta|plantilla|tabla dinamica|cronograma)\b/i

const DOC_FORMAT_QUESTION_RE =
  /\b(?:que dice|cual es|cuantas? (?:paginas?|filas?|columnas?|hojas?|diapositivas?)|resume\w*|explica\w*|analiza\w*|revisa\w*|corrige\w*|traduce\w*|lee\w*)\b[^.?!]{0,40}\b(?:el|la|este|esta|mi|del|de la)\b[^.?!]{0,20}\b(?:word|docx?|excel|xlsx?|ppt|pptx|presentaci[oó]n|documento|archivo|adjunto)\b/i

// Count + frame come from the lexicon the backend re-derives at generation
// time (lib/chat/image-request-lexicon.ts mirrors image-directive.js), so the
// chip shows exactly what will be rendered: "una imagen" → 1, "3 fotos" → 3,
// "vertical" → 3:4, "historia de instagram" → 9:16, "portada de facebook" →
// 16:9. Anything above the picker ceiling clamps to IMAGE_COUNT_MAX.
function extractImageCount(normalized: string): number | null {
  const n = detectExplicitImageCount(normalized)
  if (n == null) return null
  return Math.min(IMAGE_COUNT_MAX, Math.max(1, n))
}

function extractImageAspectRatio(normalized: string): string | null {
  return detectImageFrame(normalized)?.frame ?? null
}

function extractImageQuality(normalized: string): string | null {
  if (/\b(?:4k|ultra hd|uhd|maxima calidad|alta resolucion|resolucion alta|hiperrealista\w*|fotorrealista\w*|ultra detallad[oa]s?)\b/.test(normalized)) return "4K"
  if (/\b(?:borrador|boceto|rapid[oa]|baja resolucion|sketch|draft|low res)\b/.test(normalized)) return "1K"
  return null
}

function extractMusicDuration(normalized: string): number | null {
  const m = normalized.match(/\b(\d{1,3})\s*(?:s|seg(?:undo)?s?|sec(?:ond)?s?)\b/) || normalized.match(/\b(\d{1,2})\s*(?:min(?:uto)?s?|minutes?)\b/)
  if (!m) return null
  const isMinutes = /min/.test(m[0])
  const seconds = isMinutes ? Number(m[1]) * 60 : Number(m[1])
  if (!Number.isFinite(seconds) || seconds < 5) return null
  return Math.min(300, seconds)
}

// Producción musical: the same Estilo / Mood / Effect values the panel offers,
// read from the request itself ("una balada triste estilo pop de 45 segundos
// con acabado lo-fi") so a typed setting lands on the chip exactly like a
// selected one. Values are the panel's enum labels (lib/chat/media-composer-config).
const MUSIC_STYLE_RULES: Array<[string, RegExp]> = [
  ["Cinematic", /\b(?:cinematic[oa]?|de pelicula|banda sonora|soundtrack|epic[oa] orquestal|trailer)\b/],
  ["Orchestral", /\b(?:orquest(?:a|al|ada)|sinfoni(?:a|co|ca)|clasic[oa]|classical|orchestra(?:l)?|cuerdas|violines|piano solo)\b/],
  ["Electronic", /\b(?:electronic[oa]|electronica|edm|techno|house|trance|dubstep|synth(?:wave|pop)?|dance|drum and bass|dnb|club)\b/],
  ["Hip-Hop", /\b(?:hip[ -]?hop|rap|trap|drill|boom bap|beat de rap)\b/],
  ["Jazz", /\b(?:jazz|jazzy|swing|bossa nova|blues|saxo(?:fon)?|bebop)\b/],
  ["Latin", /\b(?:latin[oa]?|reggaeton|reggaeton|salsa|bachata|cumbia|merengue|bolero|ranchera|mariachi|tango|flamenco|corrido|banda|vallenato|samba)\b/],
  // "lo-fi" is read as the finish (Effect), never as the genre, so "balada
  // pop con acabado lo-fi" keeps Pop + Lo-Fi.
  ["Ambient", /\b(?:ambient(?:al)?|ambiente|relajante|relajacion|meditacion|meditation|spa|chill(?:[ -]?out)?|atmosferic[oa]|drone|para dormir|sleep)\b/],
  ["Pop", /\b(?:pop|balada|ballad|cancion pop|indie pop|k[ -]?pop|radio hit|pegajos[oa])\b/],
]
const MUSIC_MOOD_RULES: Array<[string, RegExp]> = [
  ["Epic", /\b(?:epic[oa]|epic|heroic[oa]|grandios[oa]|triunfal|monumental)\b/],
  ["Dark", /\b(?:oscur[oa]|dark|siniestr[oa]|tenebros[oa]|terror|miedo|sombri[oa]|gotic[oa]|misterios[oa])\b/],
  ["Emotional", /\b(?:triste|tristeza|emotiv[oa]|emocional|emotional|melancolic[oa]|nostalgic[oa]|nostalgia|desamor|llorar|conmovedor[a]?|romantic[oa])\b/],
  ["Energetic", /\b(?:energic[oa]|energetic|con energia|movid[oa]|intens[oa]|rapid[oa]|para entrenar|gym|gimnasio|workout|fiesta|party|bailable|upbeat|animad[oa])\b/],
  ["Relaxed", /\b(?:relajad[oa]|relajante|tranquil[oa]|calmad[oa]|calm|chill|suave|soft|lent[oa]|para estudiar|para dormir|serena?)\b/],
  ["Happy", /\b(?:alegre|feliz|felicidad|happy|divertid[oa]|optimista|positiv[oa]|cheerful|luminos[oa]|de cumpleanos|infantil)\b/],
]
const MUSIC_EFFECT_RULES: Array<[string, RegExp]> = [
  ["Lo-Fi", /\b(?:lo[ -]?fi|lofi|sonido vintage de cassette|granulad[oa])\b/],
  ["Warm Tape", /\b(?:cinta|tape|analogic[oa]|analog|calid[oa] y vintage|warm tape|vinilo|vinyl)\b/],
  ["Spatial", /\b(?:espacial|spatial|3d|envolvente|surround|dolby|inmersiv[oa]|binaural)\b/],
  ["Radio Ready", /\b(?:radio|listo para radio|radio ready|comercial|masterizad[oa] para radio|para spotify)\b/],
  ["Studio Master", /\b(?:master(?:izad[oa]|izacion)?|studio master|calidad de estudio|estudio|profesional|limpi[oa]|nitid[oa])\b/],
]

function firstRuleMatch(rules: Array<[string, RegExp]>, normalized: string): string | null {
  for (const [value, re] of rules) if (re.test(normalized)) return value
  return null
}

function extractMusicStyle(normalized: string): string | null { return firstRuleMatch(MUSIC_STYLE_RULES, normalized) }
function extractMusicMood(normalized: string): string | null { return firstRuleMatch(MUSIC_MOOD_RULES, normalized) }
function extractMusicEffect(normalized: string): string | null { return firstRuleMatch(MUSIC_EFFECT_RULES, normalized) }

/** Strip "narra:", "lee este texto:" prefixes so TTS reads only the content. */
function cleanVoicePrompt(prompt: string): string {
  const stripped = String(prompt || "")
    .replace(/^\s*(?:por favor\s+)?(?:narra(?:me|r)?|lee(?:me|r)?|convierte(?:lo)?\s+(?:a|en)\s+(?:audio|voz)|pon(?:le)?\s+voz\s+a|dilo\s+en\s+voz\s+alta|genera(?:me)?\s+(?:un\s+)?audio\s+(?:de|con)|haz(?:me)?\s+(?:un\s+)?audio\s+(?:de|con)|read(?:\s+aloud)?|narrate|say)\s*(?:este\s+texto|el\s+siguiente\s+texto|esto|lo\s+siguiente|this)?\s*[:\-–—]?\s*/i, "")
    .trim()
  return stripped || String(prompt || "").trim()
}

function hasImageAttachment(ctx?: ComposerAutoContext): boolean {
  return Boolean(ctx?.attachments?.some((f) => /^image\//i.test(String(f?.mimeType || f?.type || "")) || /\.(?:png|jpe?g|webp|gif|heic)$/i.test(String(f?.name || ""))))
}

function hasDocumentAttachment(ctx?: ComposerAutoContext): boolean {
  return Boolean(ctx?.attachments?.some((f) => {
    const mime = String(f?.mimeType || f?.type || "")
    const name = String(f?.name || "")
    return /(?:pdf|msword|officedocument|ms-excel|spreadsheet|presentation|text\/plain|csv)/i.test(mime)
      || /\.(?:docx?|pdf|xlsx?|csv|pptx?|txt|md)$/i.test(name)
  }))
}

/**
 * Decide which composer mode the prompt asks for. Returns null when the text
 * is a question, an analysis of an attachment, or plain chat.
 */
export function detectComposerAutoMode(input: string, ctx: ComposerAutoContext = {}): ComposerAutoDecision | null {
  const raw = String(input || "")
  const normalized = normalize(raw)
  if (!normalized || normalized.length < 6) return null
  if (QUESTION_OR_IDEATION_RE.test(normalized)) return null
  const attachedDoc = hasDocumentAttachment(ctx)
  const attachedImage = hasImageAttachment(ctx)

  // Video (existing contract: same helper the typing effect already uses).
  if (shouldAutoActivateVideoGeneration(raw) && !MUSIC_FALSE_POSITIVE_RE.test(normalized)) {
    const settings: ComposerAutoSettings = {}
    const duration = extractRequestedVideoDurationSeconds(raw)
    if (duration) settings.videoDuration = duration
    const aspect = extractRequestedVideoAspectRatio(raw)
    if (aspect) settings.videoAspectRatio = aspect
    const resolution = extractRequestedVideoResolution(raw)
    if (resolution) settings.videoResolution = resolution
    const audio = extractRequestedVideoAudio(raw)
    if (audio !== null) settings.videoAudio = audio
    return { mode: "video", confidence: "high", settings, cleanedPrompt: raw.trim(), reason: "video-create" }
  }

  // Music before voice: "una canción con voz" is a song.
  if (ROUTING_PATTERNS.musicGeneration.test(normalized) && !MUSIC_FALSE_POSITIVE_RE.test(normalized)) {
    const settings: ComposerAutoSettings = {}
    const duration = extractMusicDuration(normalized)
    if (duration) settings.musicDurationSeconds = duration
    const style = extractMusicStyle(normalized)
    if (style) settings.musicStyle = style
    const mood = extractMusicMood(normalized)
    if (mood) settings.musicMood = mood
    const effect = extractMusicEffect(normalized)
    if (effect) settings.musicEffect = effect
    return { mode: "music", confidence: "high", settings, cleanedPrompt: raw.trim(), reason: "music-create" }
  }

  // "narra este texto: …", "léeme esto:", "dilo en voz alta" — the prefix IS
  // the instruction; the media pattern needs a second voice noun to fire.
  const VOICE_PREFIX_RE = /^\s*(?:por favor\s+)?(?:narra(?:me|r|lo|la)?|lee(?:me|lo|la)?|leeme|dilo en voz alta|convierte(?:lo)? (?:a|en) (?:audio|voz)|pon(?:le)? voz a|genera(?:me)? (?:un )?audio (?:de|con)|haz(?:me)? (?:un )?audio (?:de|con)|read(?: this)?(?: aloud)?|narrate|say)\b/i
  if (
    (ROUTING_PATTERNS.voiceGeneration.test(normalized) || VOICE_PREFIX_RE.test(normalized))
    && !VOICE_FALSE_POSITIVE_RE.test(normalized)
    && !isImageAnalysisPrompt(raw)
    && !attachedDoc
  ) {
    return { mode: "voice", confidence: "medium", settings: {}, cleanedPrompt: cleanVoicePrompt(raw), reason: "voice-create" }
  }

  // Image: needs a create verb + picture noun; analysis prompts stay on chat.
  // Chat typos ("dma euna imajenes", "iamgen") are canonicalised with the same
  // table the backend uses, so a misspelt request still flips the chip.
  const imageNormalized = canonicalizeImageTypos(normalized)
  if (IMAGE_CREATE_RE.test(imageNormalized) && !IMAGE_FALSE_POSITIVE_RE.test(imageNormalized) && !isImageAnalysisPrompt(raw)) {
    // An attached document + "crea una imagen" usually means "based on this" — still image.
    const settings: ComposerAutoSettings = {}
    const count = extractImageCount(normalized)
    if (count) settings.imageCount = count
    const aspect = extractImageAspectRatio(normalized)
    if (aspect) settings.imageAspectRatio = aspect
    const quality = extractImageQuality(normalized)
    if (quality) settings.imageQuality = quality
    return {
      mode: "image",
      confidence: attachedImage ? "medium" : "high",
      settings,
      cleanedPrompt: raw.trim(),
      reason: attachedImage ? "image-edit-or-create" : "image-create",
    }
  }

  // Documents: explicit "create/export a Word/PPT/Excel…" — never questions
  // about an attached file.
  if (DOC_CREATE_RE.test(normalized) && !DOC_FORMAT_QUESTION_RE.test(normalized)) {
    if (attachedDoc && !/\b(?:nuevo|nueva|desde cero|otro|otra|a partir|basad[oa] en|con (?:base|los datos))\b/.test(normalized) && /\b(?:corrige|edita|modifica|cambia|agrega|añade|elimina|borra|reemplaza|actualiza|traduce|resume)\b/.test(normalized)) {
      return null // editing the attachment is the document-edit path, not a new file
    }
    const format = detectDocumentChatFormat(raw)
    const mode: ComposerAutoMode = format === "xlsx" ? "xlsx" : format === "pptx" ? "pptx" : "docx"
    return {
      mode,
      confidence: "high",
      settings: { documentFormat: mode },
      cleanedPrompt: raw.trim(),
      reason: `document-create:${format}`,
    }
  }

  if (WEB_SEARCH_RE.test(normalized)) {
    return { mode: "web_search", confidence: "medium", settings: {}, cleanedPrompt: raw.trim(), reason: "web-search" }
  }

  return null
}

export const __test = {
  extractImageCount,
  extractImageAspectRatio,
  extractImageQuality,
  extractMusicDuration,
  extractMusicStyle,
  extractMusicMood,
  extractMusicEffect,
  cleanVoicePrompt,
}
