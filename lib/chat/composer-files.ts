import { isActiveProcessingStage, type FileProcessingStage } from "../file-processing-vocab"
import { getLongPasteMetadata, type LongPasteMetadata } from "../long-paste"
import { getAttachmentRelativePath } from "../attachments/folder-selection"

type ComposerFileRecord = {
  id?: unknown
  fileId?: unknown
  attachmentId?: unknown
  file?: unknown
  url?: unknown
  preview?: unknown
  objectUrl?: unknown
  imageUrl?: unknown
  path?: unknown
  thumbnailUrl?: unknown
  extractedText?: unknown
  status?: unknown
  processingStage?: unknown
  stage?: unknown
  name?: unknown
  originalName?: unknown
  filename?: unknown
  mimeType?: unknown
  type?: unknown
  contentType?: unknown
  size?: unknown
  openaiFileId?: unknown
  sourceChannel?: unknown
  relativePath?: unknown
  isLongPasteDocument?: unknown
  longPasteTitle?: unknown
  longPastePreview?: unknown
  tempId?: unknown
  mediaMeta?: unknown
}

export type AgentFileMetadata = {
  id: string
  relativePath?: string
  name: string
  originalName: string
  filename: string
  mimeType: unknown
  type: unknown
  size: unknown
  url: unknown
  openaiFileId: unknown
  sourceChannel: unknown
  isLongPasteDocument: boolean
  longPasteTitle: string | null
  longPastePreview: string | null
  longPasteMeta: SafeLongPasteMetadata | null
}

export type SafeLongPasteMetadata = Pick<
  LongPasteMetadata,
  | "kind"
  | "title"
  | "filename"
  | "preview"
  | "originalCharCount"
  | "originalWordCount"
  | "originalLineCount"
  | "createdAt"
> & { text?: never }

function asComposerFile(file: unknown): ComposerFileRecord | null {
  return file && typeof file === "object" ? file as ComposerFileRecord : null
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized || null
}

export function resolveUploadFileId(file: unknown): string | null {
  if (typeof file === "string") return optionalString(file)
  const candidate = asComposerFile(file)
  if (!candidate) return null
  return optionalString(candidate.id)
    || optionalString(candidate.fileId)
    || optionalString(candidate.attachmentId)
}

export function collectUploadFileIds(files: readonly unknown[] = []): string[] {
  return files.map(resolveUploadFileId).filter((id): id is string => Boolean(id))
}

export function parseMessageFiles(files: unknown): unknown[] {
  if (!files) return []
  if (Array.isArray(files)) return files
  if (typeof files === "string") {
    try {
      const parsed = JSON.parse(files)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

export function collectMessageFileIds(files: unknown): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const file of parseMessageFiles(files)) {
    const id = resolveUploadFileId(file)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** No accents, no ¿?¡!.,;:, letters split from digits ("los50" → "los 50"). */
function normalizeRoutingPrompt(prompt: string): string {
  return String(prompt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/([a-z])(\d)/g, "$1 $2").replace(/[¿?¡!.,;:]/g, " ").replace(/\s+/g, " ").trim()
}

/** Accent-folded and lowercased but punctuation kept, so "1:30" stays a timecode. */
function foldRoutingPrompt(prompt: string): string {
  return String(prompt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

function anyOf(patterns: readonly RegExp[]): RegExp {
  return new RegExp(patterns.map((pattern) => pattern.source).join("|"))
}

// What a request about a recording asks for: a transcript, subtitles, a
// summary, minutes, chapters, a translation, what was said. Matched against
// normalizeRoutingPrompt.
const MEDIA_UNDERSTANDING_RE = anyOf([
  /\b(?:transcri|trascri|transcir|tanscri|trancri)\w*/,
  /\b(?:audios?|videos?|voz|grabacion(?:es)?) a texto\b/,
  /\bspeech[- ]?to[- ]?text\b/,
  /\b(?:pasa|pasalo|pasala|pasamelo|convierte|conviertelo|conviertela|transforma|transformalo|ponlo|ponla)(?: \w+){0,4} (?:a|en|por) (?:texto|escrito)\b/,
  /\bsubtitul\w*|\bsubtitles?\b|\bcaptions?\b|\b(?:web)?vtt\b|\bsrt\b/,
  /\bresum\w*|\bsintetiz\w*|\bsintesis\b|\bsummar\w*/,
  /\bactas?\b|\bminutas?\b|\bmeeting (?:notes|minutes)\b|\bcapitul\w*|\bchapters?\b/,
  /\bpuntos? (?:clave|importantes|principales)\b|\bideas? (?:clave|principales|centrales)\b|\bkey (?:points|takeaways)\b/,
  /\bmarcas? (?:de tiempo|temporales)\b|\btimestamps?\b/,
  /\bhablantes?\b|\binterlocutores?\b|\bquien habla\b|\bspeakers?\b/,
  /\btraduc\w*|\btraduzc\w*|\btranslat\w*/,
  /\bque (?:mas |se |mas se )?(?:dice|dicen|dijo|dijeron|habla|hablan|hablo|hablaron|menciona\w*|explica\w*|comenta\w*|cuenta|conto|contaron|responde\w*|respondio)\b/,
  /\b(?:de|sobre) que (?:trata|tratan|habla|hablan|hablo|hablaron|va)\b/,
  /\bwhat (?:does|did|do) (?:he|she|it|they|the \w+) (?:say|talk about|mention)\b|\bwhat (?:is|was) (?:said|discussed)\b/,
  /\banaliz\w*|\banalisis\b|\banaly[sz]\w*|\bescuch\w*|\blisten\w*|\bexplic\w*|\breintent\w*|\bcompar\w*/,
  /\b(?:toma|tomar|saca\w*|haz\w*|dame|apunta\w*) (?:las |unas |mis )?notas\b/,
])

// «ponlo en word», «pásalo a pdf», «dame la transcripción en txt»: a recording
// exported to a document is its transcript in that format.
const MEDIA_EXPORT_RE =
  /\b(?:ponlo|ponla|ponmelo|ponmela|pasalo|pasala|pasamelo|pasamela|exportalo|exportala|exportamelo|conviertelo|conviertela|guardalo|guardala|descargalo|damelo|damela|dalo|hazlo|hazla|hazmelo|hazmela|pon|pasa|exporta|convierte|guarda|descarga|dame|quiero|necesito)\b(?: \w+){0,3} (?:en|a|como) (?:un |una |formato )?(?:word|docx|pdf|txt|srt|vtt|documento|archivo de texto)\b/

// «del minuto 30 al 45», «minuto 1.5 hasta el 10», «del 1:30 al 10:00». Matched
// against foldRoutingPrompt.
const MEDIA_UNIT_RANGE_RE = anyOf([
  /\b(?:del|desde el|desde|a partir del|entre el|entre los|en el|from) (?:minuto|min|minute|segundo|second|hora|hour)s? ?\d/,
  /\bminutos? \d+(?:[.,]\d+)? ?(?:al?|y|hasta(?: el)?|-|–|to) ?(?:(?:el )?minuto )?\d/,
])
// A bare clock range is also a schedule («de 10:00 a 11:00»).
const MEDIA_CLOCK_RANGE_RE = /\b\d{1,2}:\d{2}(?::\d{2})? ?(?:al?|y|hasta(?: el)?|-|–|to) ?\d{1,2}:\d{2}/
const MEDIA_TIME_RANGE_RE = anyOf([MEDIA_UNIT_RANGE_RE, MEDIA_CLOCK_RANGE_RE])

/** True when the text asks to transcribe, subtitle, summarize, export or question a recording. */
export function isMediaUnderstandingPrompt(prompt: string): boolean {
  const text = normalizeRoutingPrompt(prompt)
  if (!text) return false
  return MEDIA_UNDERSTANDING_RE.test(text)
    || MEDIA_EXPORT_RE.test(text)
    || MEDIA_TIME_RANGE_RE.test(foldRoutingPrompt(prompt))
}

function isMediaAttachment(file: unknown): boolean {
  return isAudioComposerFile(file) || isVideoComposerFile(file)
}

/**
 * A turn about an audio/video recording: «quiero la transcripción de este
 * video», «hazme subtítulos srt», «qué dice este audio», «sácame el acta de
 * esta reunión», «del minuto 30 al 45». It belongs to the durable agent-task
 * media branch, never to video generation, Voz (TTS) or the image-only toast.
 * `files` are the composer attachments, or this chat's latest media batch as
 * reused by resolveMediaFollowupFiles. Images never count, so «anima esta
 * foto» and «haz un video con esta imagen» still generate video.
 */
export function isMediaUnderstandingTurn(prompt: string, files: readonly unknown[] = []): boolean {
  const list = Array.isArray(files) ? files : []
  if (!list.some(isMediaAttachment)) return false
  return isMediaUnderstandingPrompt(prompt)
}

const IMAGE_ATTACHMENT_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i

function isImageAttachment(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate) return false
  return attachmentMime(candidate).startsWith("image/")
    || candidate.type === "image"
    || IMAGE_ATTACHMENT_EXT_RE.test(attachmentDisplayName(candidate, ""))
}

/**
 * True when some attachment is not an image and every such attachment is
 * audio/video («haz un video con este audio»). The image and video generators
 * only take images, so the send hands these turns to the agent-task media
 * branch instead of dropping them with the image-only toast.
 */
export function attachmentsBesideImagesAreMedia(files: readonly unknown[] = []): boolean {
  const nonImages = (Array.isArray(files) ? files : []).filter((file) => !isImageAttachment(file))
  return nonImages.length > 0 && nonImages.every(isMediaAttachment)
}

export type MediaFollowupKind = "explicit" | "contextual" | "immediate"

// What may open a request before its verb: «y …», «ahora …», «¿puedes …?».
const FOLLOWUP_LEAD_IN =
  /(?:(?:y|e|ok|okay|vale|bueno|ahora|ya|luego|despues|tambien|oye|porfa|por favor|gracias|perfecto|genial|listo) )*(?:(?:me )?(?:puedes|podrias|pudieras) |(?:quiero|necesito|quisiera|me gustaria) que |vuelve a )?/
const UNDERSTANDING_VERB =
  /(?:transcri\w*|trascri\w*|analiz\w*|analisis|resum\w*|sintetiz\w*|reintent\w*|compar\w*|traduc\w*|subtitul\w*)/
const REQUEST_VERB =
  /(?:dame|damelo|damela|da|dime|quiero|necesito|quisiera|hazme|haz|haces|saca\w*|genera\w*|crea\w*|prepara\w*|elabora\w*|redacta\w*|pasame|extrae\w*|me (?:das|pasas|haces|sacas|generas|preparas))/
const UNDERSTANDING_OUTPUT =
  /(?:(?:el|la|los|las|un|una|unos|unas|tu|mi|todo el|toda la) )?(?:transcripci\w*|subtitul\w*|srt|vtt|resumen\w*|sintesis|acta|minuta|capitulos?|puntos clave|ideas principales|traduccion\w*|analisis|notas)/
const UNDERSTANDING_HEAD_RE = new RegExp(
  `^${FOLLOWUP_LEAD_IN.source}(?:${UNDERSTANDING_VERB.source}|${REQUEST_VERB.source} ${UNDERSTANDING_OUTPUT.source})\\b`,
)
const MEDIA_NOUN_RE = /\b(?:audios?|videos?|grabaciones|grabacion|recordings?|notas? de voz|podcasts?|mp ?[34]|clips?)\b/
// Outputs that only ever come from a recording.
const RECORDING_OUTPUT_RE = /\b(?:transcripci\w*|subtitul\w*|srt|vtt|marcas? de tiempo|timestamps?|hablantes?)\b/
// Something said aloud: a class, a meeting, the person who spoke. «la clase
// media/obrera» is a social class, not a lesson.
const RECORDING_CONTEXT_RE =
  /\b(?:clases?(?! (?:medias?|altas?|bajas?|sociales?|obreras?|trabajadoras?|dominantes?|politicas?|privilegiadas?)\b)|reunion(?:es)?|charlas?|conferencias?|entrevistas?|ponencias?|sesion(?:es)?|llamadas?|exposicion(?:es)?|webinars?|leccion(?:es)?|catedras?|audiencias?|juntas?|seminarios?|talleres|taller|episodios?|profesora?|profe|docentes?|ponentes?|expositora?|oradora?|entrevistad[oa]s?|invitad[oa]s?|meet|zoom)\b/
// «qué dijo sobre X», «cuándo habló de…», «qué acordaron»: past-tense speech
// points at what was said, i.e. the recording. Only while nobody else is the
// speaker: «qué dijo Einstein», «qué propuso Keynes» or «quién dijo 'pienso,
// luego existo'» are general questions unless the prompt names the recording.
const SAID_WHAT_HEAD = `^${FOLLOWUP_LEAD_IN.source}(?:que|de que|sobre que|cuando|como|donde|por que|cual|cuales) `
const SAID_WHO_HEAD = `^${FOLLOWUP_LEAD_IN.source}(?:quien|quienes|a quien) `
const SAID_PAST_VERB =
  /(?:dijo|dijeron|se dijo|hablaron|se hablo|mencionaron|se menciono|explicaron|comentaron|conto|contaron|respondio|respondieron|preguntaron|recomendo|propuso|concluyeron|acordaron|se acordo|decidieron|se decidio)/
// Without its accent each of these is also a first-person present («cómo le
// explico a mi hijo…»): it is past tense only when typed «habló», «explicó»…
const SAID_ACCENT_VERB = /(?:hablo|menciono|explico|comento|pregunto|concluyo)/
const SAID_ACCENTED_RE = /(?:^|[^\p{L}])(?:habló|mencionó|explicó|comentó|preguntó|concluyó)(?!\p{L})/u
// Between the question word and the verb: «qué más dijo», «qué fue lo que dijo».
const SAID_GAP = `(?:${/(?:mas|se|le|les|lo|nos|me|te|fue|es|era|que|exactamente|entonces|ahi|alli|aqui|tambien|ademas|al|final|principio|inicio|el|ella|ellos|ellas|ya|realmente)/.source} ){0,3}`
// After the verb: nothing, a topic or a pointer, never a new speaker
// («qué dijo Einstein»). «él»/«ella» only before a topic or at the end.
const SAID_TAIL_WORD =
  /(?:sobre|de|del|acerca|respecto|en|al|a|con|entre|para|por|antes|despues|luego|durante|cuando|que|y|eso|esto|aquello|exactamente|entonces|ahi|alli|aqui|mas|tambien|ademas|primero|finalmente|hoy|ayer)/
const SAID_TAIL = `(?:$| ${SAID_TAIL_WORD.source}\\b| (?:el|ella|ellos|ellas)(?:$| ${SAID_TAIL_WORD.source}\\b))`
// «quién dijo que la tierra era redonda» asks about a quote: a who-question
// points at the recording only bare or with a pointer («¿quién dijo eso?»).
const SAID_WHO_TAIL = "(?:$| (?:eso|esto|aquello|ahi|alli)$)"
const saidStrict = (verb: RegExp) => anyOf([
  new RegExp(`${SAID_WHAT_HEAD}${SAID_GAP}${verb.source}${SAID_TAIL}`),
  new RegExp(`${SAID_WHO_HEAD}${SAID_GAP}${verb.source}${SAID_WHO_TAIL}`),
])
const SAID_STRICT_RE = saidStrict(SAID_PAST_VERB)
const SAID_STRICT_ACCENT_RE = saidStrict(SAID_ACCENT_VERB)
// Any speaker, but only next to a recording word: «qué explicó el profesor».
const SAID_LOOSE_RE = new RegExp(
  `^${FOLLOWUP_LEAD_IN.source}(?:que|de que|sobre que|cuando|como|donde|por que|cual|cuales|quien|quienes|a quien) (?:\\w+ ){0,3}(?:${SAID_PAST_VERB.source}|${SAID_ACCENT_VERB.source})\\b`,
)
// «qué dice el profesor», «de qué trata el audio»: names the recording itself.
const SAID_ABOUT_RECORDING_RE = new RegExp(
  `^${FOLLOWUP_LEAD_IN.source}`
    + /(?:que|de que|sobre que) (?:dice|habla|menciona|explica|cuenta|trata) (?:el|la|este|esta|ese|esa) (?:profesora?|profe|docente|ponente|expositora?|oradora?|entrevistad[oa]|invitad[oa]|audio|video|grabacion|clase|reunion|charla|conferencia|entrevista|podcast)\b/.source,
)
const SAID_ENGLISH_RE =
  /^what (?:did|does) (?:he|she|they|the (?:speaker|teacher|professor|lecturer|presenter|host|guest|interviewee|instructor)) (?:say|mention|talk about)\b/
// Accent-folded, case kept: finds the verb in the prompt as typed.
const SAID_VERB_ANY_RE = new RegExp(`(?<![\\p{L}\\d])(?:${SAID_PAST_VERB.source}|${SAID_ACCENT_VERB.source})(?![\\p{L}\\d])`, "iu")
// A capitalized word that does not open a sentence: a name or an acronym.
const PROPER_NOUN_RE = /(?<![.?!¿¡]\s*)(?<![\p{L}\d])\p{Lu}/u

// «qué dijo a su esposa Napoleón», «qué se acordó en el Tratado de Versalles»,
// «qué dijo sobre la inflación el presidente del BCR»: someone or something
// named after the verb is a new speaker or a historic event. An all-caps
// prompt names nobody.
function namesSomeoneAfterSaidVerb(prompt: string): boolean {
  const typed = String(prompt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ")
  const verb = SAID_VERB_ANY_RE.exec(typed)
  if (!verb) return false
  const after = typed.slice(verb.index + verb[0].length)
  return /\p{Ll}/u.test(after) && PROPER_NOUN_RE.test(after)
}

// `instruction` is the request without the user's own material, so a
// recording word quoted or pasted after a colon never names the recording.
function isSaidQuestion(text: string, prompt: string, instruction: string): boolean {
  if (SAID_ABOUT_RECORDING_RE.test(text) || SAID_ENGLISH_RE.test(text)) return true
  if (RECORDING_CONTEXT_RE.test(instruction) || MEDIA_NOUN_RE.test(instruction)) return SAID_LOOSE_RE.test(text)
  const strict = SAID_STRICT_RE.test(text)
    || (SAID_STRICT_ACCENT_RE.test(text) && SAID_ACCENTED_RE.test(String(prompt || "").normalize("NFC").toLowerCase()))
  return strict && !namesSomeoneAfterSaidVerb(prompt)
}

// Another object named before the recording word: «resume este artículo sobre
// la clase» is about the article, «resume la clase en un documento» is not.
const OTHER_OBJECT_RE =
  /\b(?:documentos?|pdfs?|articulos?|libros?|papers?|tesis|informes?|reportes?|imagen(?:es)?|fotos?|capturas?|excel|presentacion(?:es)?|diapositivas?|codigo|paginas?|webs?|correos?|emails?|noticias?|cartas?|ensayos?|novelas?|cuentos?|poemas?|contratos?|textos?|mensajes?|frases?|parrafos?|oracion(?:es)?|agendas?|horarios?|dias?|turnos?|calendarios?)\b/

function namesRecordingFirst(text: string): boolean {
  const recording = text.search(RECORDING_CONTEXT_RE)
  if (recording < 0) return false
  const other = text.search(OTHER_OBJECT_RE)
  return other < 0 || recording < other
}

// The user's own material starts at the first colon that is not part of a
// timecode, a line break or an opening quote: «traduce al inglés: mañana no
// habrá clase», «traduce "hola profe" al inglés». An apostrophe opens a quote
// only after a space («what's» is a word).
const MATERIAL_START_RE = /(?<!\d):(?!\d)|[\r\n]|["«»“”„‘]|(?<![\p{L}\d])['’]/u

function splitInstruction(prompt: string): { instruction: string; material: string } {
  const raw = String(prompt || "")
  const cut = raw.search(MATERIAL_START_RE)
  return cut < 0 ? { instruction: raw, material: "" } : { instruction: raw.slice(0, cut), material: raw.slice(cut + 1) }
}

// «del 1:30 al 10:00», «y solo de 5:00 a 6:00»: the range and nothing else.
const BARE_RANGE_WORDS = new Set([
  "y", "e", "ok", "ahora", "ya", "luego", "tambien", "solo", "solamente", "porfa", "por", "favor",
  "del", "de", "al", "a", "desde", "hasta", "entre", "el", "la", "los", "las", "parte", "tramo", "fragmento", "segmento",
  "minuto", "minutos", "min", "segundo", "segundos", "hora", "horas",
])

function isBareTimeRange(text: string): boolean {
  return text.split(" ").every((word) => /^[\d\-–]+$/.test(word) || BARE_RANGE_WORDS.has(word))
}

// «resúmelo», «tradúcelo», «ponle subtítulos»: the pronoun is the answer just given.
const PRONOUN_FOLLOWUP_RE = new RegExp(
  `^${FOLLOWUP_LEAD_IN.source}(?:(?:resum|traduc|transcrib|analiz|sintetiz|subtitul|explic)\\w*(?:lo|la|los|las)|ponle subtitulos)\\b`,
)
const LINK_RE = /https?:\/\/|\bwww\.|\b(?:youtube|youtu|tiktok|vimeo|instagram|facebook|twitch|spotify)\b/
// «la transcripción del documento», «subtítulos para mi app»: another source.
const FOREIGN_SOURCE_RE =
  /\b(?:del?|de la|de este|de esta|de ese|de esa|de mi|de tu|para (?:mi|tu|la|el|una|un))(?: \w+)? (?:documentos?|pdf|imagen(?:es)?|fotos?|capturas?|excel|presentacion|diapositivas|codigo|app|aplicacion|web|pagina|libro|articulo|paper|tesis|informe)\b/
// A bare request about the answer just given: «transcribe y resume», «hazme
// el acta», «dame un resumen con los puntos clave», «traduce al inglés». Any
// other word («analiza las ventas de hoy») makes it a new task.
const IMMEDIATE_WORDS = [
  // lead-ins and politeness
  "y", "e", "ok", "okay", "vale", "bueno", "ahora", "ya", "luego", "despues", "tambien", "oye", "porfa", "por", "favor",
  "gracias", "perfecto", "genial", "listo", "me", "puedes", "podrias", "pudieras", "quiero", "necesito", "quisiera",
  "gustaria", "que", "vuelve",
  // articles, pronouns, connectors
  "a", "el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "le", "tu", "mi", "todo", "toda", "esto", "eso",
  "con", "en", "de", "del", "al", "para", "sin", "solo", "ademas", "anterior", "texto",
  // what to produce and how
  "breve", "corto", "corta", "ejecutivo", "ejecutiva", "detallado", "detallada", "completo", "completa", "general",
  "puntos", "clave", "ideas", "principales", "importantes", "notas", "marcas", "tiempo", "hablantes", "acta", "minuta",
  "capitulos?", "srt", "vtt", "palabras", "lineas", "parrafos", "vinetas", "bullets", "minutos", "\\d+",
  "ingles", "espanol", "frances", "portugues", "aleman", "italiano", "chino", "japones", "coreano", "ruso", "arabe", "quechua",
  // request and understanding verbs
  "dame", "da", "dime", "hazme", "haz", "haces", "pasame", "das", "pasas",
  "transcri\\w*", "trascri\\w*", "resum\\w*", "sintetiz\\w*", "sintesis", "traduc\\w*", "analiz\\w*", "analisis",
  "subtitul\\w*", "saca\\w*", "genera\\w*", "crea\\w*", "prepara\\w*", "elabora\\w*", "redacta\\w*", "extrae\\w*",
]
const IMMEDIATE_WORD = `(?:${IMMEDIATE_WORDS.join("|")})`
const IMMEDIATE_CLOSED_RE = new RegExp(`^${IMMEDIATE_WORD}(?: ${IMMEDIATE_WORD})*$`)

/**
 * How a message without attachments points back at this chat's latest media
 * batch, or null when it does not:
 * - explicit: names the media or a recording-only output («transcribe los
 *   audios», «dame la transcripción», «reintenta los fallidos»);
 * - contextual: asks about what the recording says («resume la clase», «qué
 *   dijo sobre X», «del minuto 30 al 45»), honoured a few turns after it;
 * - immediate: refers to the answer just given («ponlo en word», «resúmelo»,
 *   «hazme el acta»), honoured only right after the media turn.
 * A link is its own target (transcribe_url), never the last upload.
 */
export function classifyMediaFollowupPrompt(prompt: string): MediaFollowupKind | null {
  const text = normalizeRoutingPrompt(prompt)
  if (!text || text.length > 240) return null
  if (LINK_RE.test(text)) return null
  // Recording words and ranges count only in the request itself, never in the
  // text the user pasted or quoted after it.
  const parts = splitInstruction(prompt)
  const instruction = normalizeRoutingPrompt(parts.instruction)
  const action = /^(?:(?:por favor|ahora|puedes|podrias|quiero que|necesito que|vuelve a) )?(?:transcrib\w*|transcripci\w*|analiz\w*|analisis|resum\w*|reintent\w*|compar\w*)\b/
  if (action.test(text) && MEDIA_NOUN_RE.test(instruction)) return "explicit"
  // "analiza los50" / "reintenta los fallidos" refer to the most recent batch.
  // Keep the vocabulary closed so "analiza el codigo" remains a new task.
  if (/^(?:por favor )?(?:analiza|analizar|resume|resumir|transcribe|transcribir|reintenta|reintentar|compara|comparar)(?: (?:los|las|estos|estas|esos|esas|todos|todas|restantes|fallidos|fallidas|pendientes|nuevamente|otra|vez|de|nuevo|por|favor|\d+))*$/.test(text)) {
    return "explicit"
  }
  const head = UNDERSTANDING_HEAD_RE.test(text) && !FOREIGN_SOURCE_RE.test(text)
  if (head && (MEDIA_NOUN_RE.test(instruction) || RECORDING_OUTPUT_RE.test(instruction))) return "explicit"
  if (head && namesRecordingFirst(instruction)) return "contextual"
  if (isSaidQuestion(text, prompt, instruction)) return "contextual"
  if (text.length <= 120) {
    // The range is in the request, or it is all the material («transcribe:
    // del 1:30 al 10:00»); «traduce: en el minuto 90 metió gol» is the text.
    const scope = foldRoutingPrompt(isBareTimeRange(normalizeRoutingPrompt(parts.material)) ? prompt : parts.instruction)
    if (MEDIA_UNIT_RANGE_RE.test(scope)) return "contextual"
    // A clock range belongs to the recording only with a request about it or
    // on its own; «agenda una reunión de 10:00 a 11:00» and «resume mi día de
    // 9:00 a 17:00» are schedules.
    const range = scope.search(MEDIA_CLOCK_RANGE_RE)
    if (range >= 0 && ((head && !OTHER_OBJECT_RE.test(scope.slice(0, range)))
      || MEDIA_NOUN_RE.test(instruction) || RECORDING_OUTPUT_RE.test(instruction) || isBareTimeRange(text))) return "contextual"
  }
  if ((head && IMMEDIATE_CLOSED_RE.test(text)) || PRONOUN_FOLLOWUP_RE.test(text)) return "immediate"
  if (MEDIA_EXPORT_RE.test(text) && text.split(" ").length <= 8 && !FOREIGN_SOURCE_RE.test(text)) return "immediate"
  return null
}

/** Only media follow-ups, never a generic new request that happens to follow an upload. */
export function isMediaFollowupPrompt(prompt: string): boolean {
  return classifyMediaFollowupPrompt(prompt) !== null
}

// User turns allowed between the media batch and the follow-up, per kind.
const MEDIA_FOLLOWUP_MAX_LATER_TURNS: Record<MediaFollowupKind, number> = {
  explicit: Number.POSITIVE_INFINITY,
  contextual: 4,
  immediate: 0,
}

/** Reuse only this chat's latest attached USER batch; an intervening document stops lookup. */
export function resolveMediaFollowupFiles(prompt: string, messages: readonly unknown[] = []): unknown[] {
  const kind = classifyMediaFollowupPrompt(prompt)
  if (!kind) return []
  let laterUserTurns = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; files?: unknown } | null
    if (!message || String(message.role || "").toLowerCase() !== "user") continue
    const files = parseMessageFiles(message.files).filter((file) => Boolean(resolveUploadFileId(file)))
    if (!files.length) {
      laterUserTurns += 1
      if (laterUserTurns > MEDIA_FOLLOWUP_MAX_LATER_TURNS[kind]) return []
      continue
    }
    return files.length <= 50 && files.every((file) => isAudioComposerFile(file) || isVideoComposerFile(file)) ? files : []
  }
  return []
}

export function attachmentHasPreviewSource(attachment: unknown): boolean {
  const candidate = asComposerFile(attachment)
  return Boolean(
    candidate?.file
    || candidate?.url
    || candidate?.extractedText
    || candidate?.preview
    || candidate?.objectUrl,
  )
}

export function previewAttachmentKey(attachment: unknown): string {
  const candidate = asComposerFile(attachment)
  return String(candidate?.id || candidate?.url || candidate?.name || "")
}

export function isComposerFileUploadPending(file: unknown): boolean {
  const candidate = asComposerFile(file)
  return Boolean(candidate && candidate.status === "uploading" && !resolveUploadFileId(candidate))
}

const PROCESSING_CONTEXT_EXT_RE = /\.(?:pdf|docx?|xlsx?|csv|pptx?|txt|md|markdown|rtf|odt|ods|odp)$/i
const PROCESSING_CONTEXT_MIME_RE =
  /(?:application\/(?:pdf|msword|vnd\.openxmlformats-officedocument|vnd\.ms-|vnd\.oasis\.opendocument|rtf)|text\/(?:plain|markdown|csv|tab-separated-values|html|xml)|application\/(?:json|xml))/i

export function shouldWaitForDocumentProcessing(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate || !resolveUploadFileId(candidate)) return false
  const name = String(candidate.name || candidate.originalName || candidate.filename || "")
  const mime = String(candidate.mimeType || candidate.type || candidate.contentType || "")
  return PROCESSING_CONTEXT_EXT_RE.test(name) || PROCESSING_CONTEXT_MIME_RE.test(mime)
}

export function getFileProcessingStage(file: unknown): FileProcessingStage | null {
  const candidate = asComposerFile(file)
  const stage = candidate?.processingStage || candidate?.stage || null
  return typeof stage === "string" ? stage as FileProcessingStage : null
}

export function isComposerFileProcessingPending(file: unknown): boolean {
  return shouldWaitForDocumentProcessing(file) && isActiveProcessingStage(getFileProcessingStage(file))
}

/**
 * Attachments the composer must keep polling until the backend reports a
 * terminal stage: anything still flagged as processing that already has a
 * server id. Chip variants that render no status poller (the "PEGADO" long
 * paste card) otherwise stay "processing" forever and block the send.
 */
export function collectProcessingFileIds(files: readonly unknown[] = []): string[] {
  const ids: string[] = []
  for (const file of files) {
    const candidate = asComposerFile(file)
    if (!candidate) continue
    const id = resolveUploadFileId(candidate)
    if (!id) continue
    const stillProcessing = isComposerFileProcessingPending(candidate)
      || (candidate.status === "processing" && !isTerminalProcessingStage(getFileProcessingStage(candidate)))
    if (stillProcessing && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function isTerminalProcessingStage(stage: FileProcessingStage | null): boolean {
  return stage === "ready" || stage === "failed"
}

export function isComposerFileUploadFailed(file: unknown): boolean {
  const candidate = asComposerFile(file)
  return Boolean(candidate && (candidate.status === "failed" || getFileProcessingStage(candidate) === "failed"))
}

/** A failed transcription is recoverable server-side; a failed upload is not. */
export function isComposerFileSendBlockedByFailure(file: unknown): boolean {
  if (!isComposerFileUploadFailed(file)) return false
  return !(resolveUploadFileId(file) && (isAudioComposerFile(file) || isVideoComposerFile(file)))
}

export function sanitizeLongPasteMetaForMessage(meta: LongPasteMetadata | null): SafeLongPasteMetadata | null {
  if (!meta || meta.kind !== "long_paste_document") return null
  return {
    kind: "long_paste_document",
    title: meta.title,
    filename: meta.filename,
    preview: meta.preview,
    originalCharCount: meta.originalCharCount,
    originalWordCount: meta.originalWordCount,
    originalLineCount: meta.originalLineCount,
    createdAt: meta.createdAt,
  }
}

export function buildAgentFileMetadata(files: readonly unknown[] = []): AgentFileMetadata[] {
  return files.flatMap((file) => {
    const candidate = asComposerFile(file)
    const id = resolveUploadFileId(candidate)
    if (!candidate || !id) return []

    const safeLongPasteMeta = sanitizeLongPasteMetaForMessage(getLongPasteMetadata(file))
    const displayName = String(
      safeLongPasteMeta?.title
      || candidate.longPasteTitle
      || candidate.originalName
      || candidate.name
      || candidate.filename
      || "archivo",
    )

    return [{
      id,
      ...(getAttachmentRelativePath(candidate) ? { relativePath: getAttachmentRelativePath(candidate)! } : {}),
      name: displayName,
      originalName: displayName,
      filename: String(candidate.filename || candidate.name || displayName),
      mimeType: candidate.mimeType || candidate.type || candidate.contentType || null,
      type: candidate.type || candidate.mimeType || candidate.contentType || null,
      size: candidate.size ?? null,
      url: candidate.url || null,
      openaiFileId: candidate.openaiFileId || null,
      sourceChannel: candidate.sourceChannel || null,
      isLongPasteDocument: Boolean(candidate.isLongPasteDocument || safeLongPasteMeta),
      longPasteTitle: safeLongPasteMeta?.title || optionalString(candidate.longPasteTitle),
      longPastePreview: safeLongPasteMeta?.preview || optionalString(candidate.longPastePreview),
      longPasteMeta: safeLongPasteMeta,
    }]
  })
}

const AUDIO_EXT_RE = /\.(?:mp3|mp2|mpga|wave?|m4a|m4b|m4r|aac|ogg|oga|flac|alac|opus|spx|wma|aiff?|aifc|caf|amr|awb|ac3|eac3|dts|weba|mka|ape|wv|au|snd)$/i
// `.ts`/`.mts` are left out on purpose: they are TypeScript far more often
// than MPEG-TS video (the backend still spots real MPEG-TS by its bytes).
const VIDEO_EXT_RE = /\.(?:mp4|m4v|mov|qt|webm|mkv|avi|wmv|asf|flv|mpeg|mpg|m2v|m2ts|ogv|3gp|3g2|vob)$/i
const TYPESCRIPT_NAME_RE = /\.(?:ts|mts|cts)$/i

export type AttachmentMediaMeta = {
  durationSeconds?: number
  peaks?: number[]
  thumbnailDataUrl?: string | null
}

export type MessageFileSnapshot = {
  id: string | null
  relativePath?: string
  tempId: string | null
  name: string
  originalName: string
  filename: string
  mimeType: string | null
  type: string | null
  size: number | null
  url: string | null
  preview: string | null
  thumbnailUrl: string | null
  path: string | null
  extractedText: string | null
  mediaMeta: AttachmentMediaMeta | null
  sourceChannel: unknown
  isLongPasteDocument: boolean
  longPasteTitle: string | null
  longPastePreview: string | null
  longPasteMeta: SafeLongPasteMetadata | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isDurableUrl(value: unknown): boolean {
  const url = optionalString(value)
  return Boolean(url && !url.startsWith("blob:"))
}

function snapshotMediaMeta(value: unknown): AttachmentMediaMeta | null {
  const record = asRecord(value)
  if (!record) return null
  const durationSeconds = optionalNumber(record.durationSeconds)
  const peaks = Array.isArray(record.peaks)
    ? record.peaks.filter((peak): peak is number => typeof peak === "number" && Number.isFinite(peak))
    : []
  const thumbnailDataUrl = optionalString(record.thumbnailDataUrl)
  if (durationSeconds == null && peaks.length === 0 && !thumbnailDataUrl) return null
  return {
    ...(durationSeconds != null ? { durationSeconds } : {}),
    ...(peaks.length > 0 ? { peaks } : {}),
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
  }
}

function attachmentDisplayName(file: ComposerFileRecord, fallback = "archivo"): string {
  return String(
    file.longPasteTitle
    || file.originalName
    || file.name
    || file.filename
    || fallback,
  )
}

function attachmentMime(file: ComposerFileRecord): string {
  return String(file.mimeType || file.type || file.contentType || "").toLowerCase()
}

export interface MediaTranscriptionProgress {
  stage?: "preparing" | "transcribing" | string
  completed?: number
  total?: number
  percent?: number | null
  etaSeconds?: number | null
}

function formatRemainingEs(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return "menos de 2 min"
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/**
 * Chip copy for a long recording in the durable media queue. Returns null
 * when the server has no live progress (short clips transcribe in one pass),
 * so the caller keeps its plain "Transcribiendo…" label.
 */
export function describeMediaTranscriptionProgress(progress: unknown): string | null {
  if (!progress || typeof progress !== "object") return null
  const p = progress as MediaTranscriptionProgress
  if (p.stage === "preparing") return "Preparando audio…"
  const percent = Number(p.percent)
  if (!Number.isFinite(percent)) return null
  const eta = Number(p.etaSeconds)
  const remaining = Number.isFinite(eta) && eta > 0 ? ` · quedan ~${formatRemainingEs(eta)}` : ""
  return `Transcribiendo ${Math.max(0, Math.min(99, Math.round(percent)))} %${remaining}`
}

export function isAudioComposerFile(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate) return false
  const mime = attachmentMime(candidate)
  if (mime.startsWith("audio/")) return true
  if (mime.startsWith("video/")) return false
  return AUDIO_EXT_RE.test(attachmentDisplayName(candidate, ""))
}

export function getAudioMediaMeta(file: unknown): AttachmentMediaMeta | null {
  const record = asRecord(file)
  return snapshotMediaMeta(record?.mediaMeta)
}

export function isVideoComposerFile(file: unknown): boolean {
  const candidate = asComposerFile(file)
  if (!candidate) return false
  const mime = attachmentMime(candidate)
  // Browsers label TypeScript sources video/mp2t; only a large `.ts` (a real
  // MPEG-TS recording) gets a player.
  if (TYPESCRIPT_NAME_RE.test(attachmentDisplayName(candidate, ""))) {
    const size = Number((candidate as { size?: unknown }).size)
    return Number.isFinite(size) && size >= 16 * 1024 * 1024
  }
  if (mime.startsWith("video/")) return true
  if (mime.startsWith("audio/") || mime.startsWith("image/")) return false
  return VIDEO_EXT_RE.test(attachmentDisplayName(candidate, ""))
}

/**
 * True when the picker File (or a composer chip) should get an instant
 * blob preview + <video>/<audio> player — including WhatsApp/Safari
 * picks that arrive as application/octet-stream with a .mp4/.m4a name.
 */
export function shouldCreateLocalMediaPreview(file: unknown): boolean {
  if (!file) return false
  if (typeof File !== "undefined" && file instanceof File) {
    return isVideoComposerFile({ name: file.name, type: file.type })
      || isAudioComposerFile({ name: file.name, type: file.type })
      || String(file.type || "").toLowerCase().startsWith("image/")
  }
  return isVideoComposerFile(file) || isAudioComposerFile(file)
}

function isDurableMediaSrc(value: unknown): boolean {
  const url = optionalString(value)
  return Boolean(url && !url.startsWith("blob:"))
}

export function resolveComposerMediaSrc(file: unknown): string {
  const candidate = asComposerFile(file)
  if (!candidate) return ""
  const durable = [
    candidate.url,
    candidate.path,
    candidate.imageUrl,
  ].map(optionalString).find((value): value is string => isDurableMediaSrc(value))
  if (durable) return durable
  return optionalString(candidate.preview)
    || optionalString(candidate.objectUrl)
    || optionalString(candidate.url)
    || optionalString(candidate.path)
    || optionalString(candidate.imageUrl)
    || ""
}

/**
 * Plain JSON snapshot of composer attachments for the optimistic user bubble.
 * Drops the native File/blob handle (JSON.stringify throws or {}s it) while
 * keeping name, mime, url, and already-computed audio waveform/duration.
 */
export function snapshotComposerFilesForMessage(files: readonly unknown[] = []): MessageFileSnapshot[] {
  return files.flatMap((file) => {
    if (typeof file === "string") {
      const id = optionalString(file)
      if (!id) return []
      return [{
        id,
        tempId: null,
        name: "archivo",
        originalName: "archivo",
        filename: "archivo",
        mimeType: null,
        type: null,
        size: null,
        url: null,
        preview: null,
        thumbnailUrl: null,
        path: null,
        extractedText: null,
        mediaMeta: null,
        sourceChannel: null,
        isLongPasteDocument: false,
        longPasteTitle: null,
        longPastePreview: null,
        longPasteMeta: null,
      }]
    }

    const candidate = asComposerFile(file)
    if (!candidate) return []
    const record = asRecord(file) || {}
    const safeLongPasteMeta = sanitizeLongPasteMetaForMessage(getLongPasteMetadata(file))
    const displayName = attachmentDisplayName({
      ...candidate,
      longPasteTitle: candidate.longPasteTitle || safeLongPasteMeta?.title,
    })
    const mimeType = optionalString(attachmentMime(candidate))
    const extracted = optionalString(candidate.extractedText)

    return [{
      id: resolveUploadFileId(candidate),
      ...(getAttachmentRelativePath(candidate) ? { relativePath: getAttachmentRelativePath(candidate)! } : {}),
      tempId: optionalString(candidate.tempId),
      name: displayName,
      originalName: String(candidate.originalName || displayName),
      filename: String(candidate.filename || candidate.name || displayName),
      mimeType,
      type: mimeType || optionalString(typeof candidate.type === "string" ? candidate.type : null),
      size: optionalNumber(candidate.size),
      url: optionalString(candidate.url) || optionalString(candidate.imageUrl),
      preview: optionalString(candidate.preview) || optionalString(candidate.objectUrl),
      thumbnailUrl: optionalString(candidate.thumbnailUrl),
      path: optionalString(candidate.path),
      extractedText: extracted && extracted.length <= 4000 ? extracted : null,
      mediaMeta: snapshotMediaMeta(record.mediaMeta),
      sourceChannel: candidate.sourceChannel || null,
      isLongPasteDocument: Boolean(candidate.isLongPasteDocument || safeLongPasteMeta),
      longPasteTitle: safeLongPasteMeta?.title || optionalString(candidate.longPasteTitle),
      longPastePreview: safeLongPasteMeta?.preview || optionalString(candidate.longPastePreview),
      longPasteMeta: safeLongPasteMeta,
    }]
  })
}

function mergeOneMessageFile(incoming: unknown, local: unknown): unknown {
  if (!local || typeof local !== "object") return incoming
  if (!incoming || typeof incoming !== "object") return local
  const incomingRecord = incoming as Record<string, unknown>
  const localRecord = local as Record<string, unknown>
  const incomingUrl = optionalString(incomingRecord.url) || optionalString(incomingRecord.path)
  const localUrl = optionalString(localRecord.url) || optionalString(localRecord.preview)
  const url = isDurableUrl(incomingUrl) ? incomingUrl : (isDurableUrl(localUrl) ? localUrl : incomingUrl || localUrl)
  const incomingMeta = snapshotMediaMeta(incomingRecord.mediaMeta)
  const localMeta = snapshotMediaMeta(localRecord.mediaMeta)
  return {
    ...localRecord,
    ...incomingRecord,
    id: resolveUploadFileId(incoming) || resolveUploadFileId(local) || incomingRecord.id || localRecord.id || null,
    name: incomingRecord.name || localRecord.name,
    originalName: incomingRecord.originalName || localRecord.originalName,
    filename: incomingRecord.filename || localRecord.filename,
    mimeType: incomingRecord.mimeType || localRecord.mimeType || incomingRecord.type || localRecord.type || null,
    type: incomingRecord.type || localRecord.type || incomingRecord.mimeType || localRecord.mimeType || null,
    size: incomingRecord.size ?? localRecord.size ?? null,
    url,
    preview: isDurableUrl(incomingRecord.preview) ? incomingRecord.preview : (localRecord.preview || incomingRecord.preview || null),
    thumbnailUrl: incomingRecord.thumbnailUrl || localRecord.thumbnailUrl || null,
    path: incomingRecord.path || localRecord.path || null,
    mediaMeta: incomingMeta || localMeta,
    extractedText: incomingRecord.extractedText || localRecord.extractedText || null,
  }
}

/**
 * Graft the locally visible attachment records onto a later server payload.
 * Canonical URLs from the server replace blob previews without dropping
 * name / duration / waveform that the optimistic chip already showed.
 */
export function mergeMessageFileLists(incoming: unknown, local: unknown): unknown[] {
  const incomingFiles = parseMessageFiles(incoming)
  const localFiles = parseMessageFiles(local)
  if (localFiles.length === 0) return incomingFiles
  if (incomingFiles.length === 0) return localFiles

  const localById = new Map<string, unknown>()
  for (const file of localFiles) {
    const id = resolveUploadFileId(file)
    if (id && !localById.has(id)) localById.set(id, file)
  }

  const usedLocalIds = new Set<string>()
  const merged = incomingFiles.map((incomingFile, index) => {
    const id = resolveUploadFileId(incomingFile)
    const localMatch = (id && localById.get(id)) || localFiles[index]
    if (id) usedLocalIds.add(id)
    return mergeOneMessageFile(incomingFile, localMatch)
  })

  for (const [id, file] of localById) {
    if (!usedLocalIds.has(id)) merged.push(file)
  }
  return merged
}
