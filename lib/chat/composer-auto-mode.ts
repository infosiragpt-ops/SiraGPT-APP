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
  "(?:cr(?:ea|eame|ear|eas)|gener(?:a|ame|ar|as|ate)|haz(?:me|melo|lo|la)?|hace(?:r|me)|dame|quiero|necesito|produc(?:e|eme|ir)|dise[nñ](?:a|ame|ar)|dibuj(?:a|ame|ar)|pint(?:a|ame|ar)|ilustr(?:a|ame|ar)|render(?:iza|izar)?|make|create|generate|draw|design|render|produce)"

const IMAGE_NOUN =
  "(?:imagen(?:es)?|image|foto(?:s|grafia|grafias)?|photo|picture|ilustraci(?:on|ones)|illustration|dibujo(?:s)?|drawing|logo(?:tipo|s)?|render(?:s)?|poster(?:s)?|afiche(?:s)?|banner(?:s)?|portada(?:s)?|wallpaper|thumbnail|miniatura|icono(?:s)?|icon|sticker(?:s)?|retrato(?:s)?|caricatura(?:s)?|infograf(?:ia|ias)|arte digital|pixel art)"

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

const IMAGE_COUNT_RE = /\b(\d{1,2}|dos|tres|cuatro|cinco|seis)\s+(?:imagenes|imágenes|fotos|ilustraciones|versiones|variantes|variaciones|opciones|images|pictures|versions)\b/i
const NUMBER_WORDS: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 }

function extractImageCount(normalized: string): number | null {
  const m = normalized.match(IMAGE_COUNT_RE)
  if (!m) return null
  const raw = m[1]
  const n = NUMBER_WORDS[raw] || Number(raw)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(4, Math.max(1, n))
}

function extractImageAspectRatio(normalized: string): string | null {
  const ratio = normalized.match(/\b(16:9|9:16|1:1|4:3|3:4|21:9|4:5|3:2|2:3)\b/)
  if (ratio) return ratio[1]
  if (/\b(?:cuadrad[oa]s?|square|post de instagram|feed de instagram)\b/.test(normalized)) return "1:1"
  if (/\b(?:vertical(?:es)?|retrato|portrait|tiktok|reels?|historias?|story|stories|shorts?|para movil|para celular|fondo de pantalla de (?:celular|movil))\b/.test(normalized)) return "9:16"
  if (/\b(?:horizontal(?:es)?|apaisad[oa]s?|panoramic[oa]s?|landscape|widescreen|youtube|banner|portada de (?:facebook|linkedin|youtube)|cabecera|cover|wallpaper de escritorio|fondo de pantalla de (?:pc|escritorio|computadora))\b/.test(normalized)) return "16:9"
  if (/\b(?:cinema(?:tico|tografico)?|ultrawide|panavision)\b/.test(normalized)) return "21:9"
  return null
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
  if (IMAGE_CREATE_RE.test(normalized) && !IMAGE_FALSE_POSITIVE_RE.test(normalized) && !isImageAnalysisPrompt(raw)) {
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
  cleanVoicePrompt,
}
