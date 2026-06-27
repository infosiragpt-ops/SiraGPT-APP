
"use client"

import { devLog } from "./dev-log"

export interface IntentAnalysis {
  type: "search_tracks" | "search_artists" | "search_playlists" | "get_recommendations" | "general"
  query: string
  confidence: number
}

export type ChatIntent =
  | 'gmail'
  | 'google_services'
  | 'web_search'
  | 'image'
  | 'video'
  | 'ppt'
  | 'figma'
  | 'plan'
  | 'math'
  | 'viz'
  | 'doc'
  | 'artifact'
  | 'chart'
  | 'webdev'
  | 'agent_task'
  | 'text'
  // Meta-intent: prompt is too under-specified to act on. The contract
  // tells the model to ask exactly ONE short clarifying question rather
  // than guess and waste a deliverable on a wrong assumption.
  | 'ambiguous'

export const VALID_CHAT_INTENTS: ChatIntent[] = [
  'gmail',
  'google_services',
  'web_search',
  'image',
  'video',
  'ppt',
  'figma',
  'plan',
  'math',
  'viz',
  'doc',
  'artifact',
  'chart',
  'webdev',
  'agent_task',
  'text',
  'ambiguous',
]

export const AGENTIC_RUNTIME_INTENTS: ChatIntent[] = [
  'agent_task',
  'web_search',
  'doc',
  'ppt',
  'math',
  'viz',
  'chart',
]

export function shouldRouteThroughAgenticRuntime(intent: ChatIntent): boolean {
  return AGENTIC_RUNTIME_INTENTS.includes(intent === 'ppt' ? 'ppt' : normalizeRoutingIntent(intent))
}

export function normalizeRoutingIntent(intent: ChatIntent): ChatIntent {
  // PowerPoint is a downloadable document artifact in the current chat
  // runtime. Keeping "ppt" as a final route lets it fall through to free
  // chat in some shells, which can leak [CREATE_DOCUMENT:*.pptx] markers.
  return intent === 'ppt' ? 'doc' : intent
}

interface SemanticIntentResponse {
  ok?: boolean
  intent?: ChatIntent
  confidence?: number
  needsClarification?: boolean
  finalOutput?: string
  semanticProfile?: {
    primary_intent: string
    secondary_intents: string[]
    user_goal: string
    required_tools: string[]
    output_format: string
    language: string
    quality_level: string
    confidence: number
    needs_clarification: boolean
  }
  contract?: {
    pipeline?: string
    required_extension?: string | null
    required_tools?: string[]
    ambiguity_score?: number
  }
  routing?: {
    source?: string
    required_tools?: string[]
    release_decision?: string
  }
}

export interface IntentAttributionNode {
  id: string
  label: string
  group: 'current_prompt' | 'conversation_context' | 'attachments' | 'routing'
  weight: number
  evidence: string
}

export interface IntentAttributionEdge {
  from: string
  to: string
  weight: number
  reason: string
}

export interface IntentAttributionGraph {
  nodes: IntentAttributionNode[]
  edges: IntentAttributionEdge[]
  supernodes: Record<string, string[]>
  inferredIntent: ChatIntent | null
  confidence: number
  needsClarification: boolean
  usedHistory: boolean
  rationale: string[]
}

/**
 * Universal 5-step execution skeleton applied to every capability before
 * the per-intent contract. Forces the model to do real analysis instead
 * of jumping straight to generation, which is the difference between
 * "professional" output and "first thing that came to mind".
 *
 * Skipped for the `ambiguous` contract because that contract's whole job
 * is to ask one question, not to execute a 5-step plan.
 */
export const PROFESSIONAL_EXECUTION_SKELETON = [
  'siraGPT execution skeleton — apply EVERY turn before producing the final answer:',
  '1. Analyze intent — restate in one short sentence what the user wants and what for.',
  '2. Identify constraints — provided data, required formats, language, audience, deadline, and any unconfirmed assumptions.',
  '3. State the plan — short list of concrete steps you will take, in order.',
  '4. Execute under the per-capability contract below.',
  '5. Cite sources, surface key computations, and list assumptions at the end — keep verified evidence visibly separated from assumptions.',
].join('\n')

export const PROFESSIONAL_CAPABILITY_CONTRACTS: Partial<Record<ChatIntent, string>> = {
  math: [
    'Render all formulas with LaTeX using $...$ inline and $$...$$ display blocks.',
    'Use Python-backed verification when the task is numeric, statistical, matrix-based, or data-heavy; prefer SymPy, NumPy, SciPy, and Pandas as appropriate.',
    'Show assumptions, units, sample size, formulas used, and a concise interpretation. Do not invent missing data.',
    'For psychometrics such as Cronbach alpha or Spearman, explain reliability/correlation conservatively and include the computation path.',
  ].join('\n'),
  viz: [
    'Choose the renderer professionally: Matplotlib/Seaborn for thesis-ready static figures, Plotly/Recharts for interactive dashboards, D3 for custom structures, Chart.js for clean simple charts, Mermaid for technical diagrams.',
    'Include title, labelled axes or labelled nodes, readable contrast, source/assumption note, and responsive layout.',
    'Use the user-provided data exactly. If data is missing, create clearly-labelled sample data and state that it is synthetic.',
    'For academic/market visuals, prefer sober palettes and export-ready composition over decorative effects.',
  ].join('\n'),
  doc: [
    'Generate a polished downloadable file using the document style bundle when available: APA 7 DOCX, corporate XLSX, thesis/pitch PPTX, letterheaded PDF, or clean SVG.',
    'Never fabricate citations, DOIs, journals, or current sources. If real sources are required but not provided, the request should be handled by the agentic research pipeline.',
    'For Excel analytics, include raw data, formulas/results, and an interpretation sheet. For PPTX, use agenda, section dividers, strong titles, concise bullets, and speaker notes when useful.',
    'When the user uploads Word, Excel, PowerPoint, or PDF and asks to modify/improve it, preserve the original as read-only and return a new edited file in the same format unless they ask otherwise. Preserve logos, images, tables, formulas, sheet names, headers, footers, and layout as far as the renderer allows.',
    'No Lorem ipsum, TODOs, empty placeholders, or unfinished sections.',
  ].join('\n'),
  artifact: [
    'Build a live React artifact that defines App and works inside a sandboxed iframe with no imports, no bundler, and no external network calls.',
    'Use available globals only: React, Recharts, d3, Plotly, mathjs, papaparse, SheetJS, lodash, Three.js, and async storage.get/set/delete/list.',
    'Make it accessible, responsive, keyboard-usable, validated, and stateful where relevant. Show empty states, errors, reset/export controls, and concise helper text.',
    'For Three.js, keep scenes lightweight and dispose renderer, geometries, and materials in cleanup. Never store secrets or API keys in artifact storage.',
  ].join('\n'),
  agent_task: [
    'Operate as a long-running autonomous agent: plan, retrieve/search, execute code, generate deliverables, verify artifacts, repair failures, then finalize.',
    'Use web search for real/current/academic/market sources; use private RAG when the user references uploaded or project files.',
    'For every file deliverable, verify row counts, sheet names, paragraph/page counts, headers, and non-empty content before finalizing.',
    'For uploaded document editing, never mutate the source file. Copy/reconstruct into a new artifact, apply only requested edits, and preserve document structure, logos, tables, formulas, sheet names, headers, footers, slide layouts, and visual hierarchy whenever possible.',
    'Separate verified evidence from assumptions and keep citations/DOIs/URLs/years intact.',
  ].join('\n'),
  web_search: [
    'Ground the answer in real sources. Prefer recent, authoritative, citable references when the user asks for academic, scientific, legal, market, or current information.',
    'When the user asks for articles/sources but does not explicitly request Word, Excel, PDF, PPTX, or another file, answer directly in the chat as a clean citation list: Authors. (Year). Title. Journal, volume(issue), pages. DOI URL.',
    'Return concise synthesis with source metadata: title, year/date, venue/publisher, DOI/URL when available, and limitations.',
    'Do not fabricate citations or overstate findings.',
  ].join('\n'),
  plan: [
    'Produce an architectural floor-plan deliverable with scaled walls, doors, windows, room labels, dimensions, north arrow, legend, and print-readable geometry.',
    'Keep assumptions explicit when dimensions or room counts are missing.',
  ].join('\n'),
  figma: [
    'Create a professional design/diagram artifact with clear hierarchy, labelled nodes, consistent spacing, and implementation-ready structure.',
    'Prefer accessible naming and clean information architecture over decorative complexity.',
  ].join('\n'),
  ppt: [
    'Create a professional presentation with coherent palette, agenda, section dividers, strong slide titles, concise bullets, visual hierarchy, and speaker notes when useful.',
    'Avoid text-heavy slides and unfinished placeholders.',
  ].join('\n'),
  webdev: [
    'Build production-grade responsive UI, not a generic template: clear visual direction, accessible semantics, working interactions, polished states, and mobile layout.',
    'Include realistic content, no Lorem ipsum, no broken buttons, no placeholder-only sections, and avoid reproducing the chat UI itself.',
  ].join('\n'),
  image: [
    'Preserve the user intent while improving composition, lighting, material detail, and professional visual direction.',
    'Avoid adding text unless the user explicitly requests typography.',
  ].join('\n'),
  video: [
    'Preserve the user intent while specifying cinematic motion, continuity, camera direction, lighting, and safe concise scene structure.',
  ].join('\n'),
  ambiguous: [
    'The user request is under-specified. Ask EXACTLY ONE short clarifying question instead of guessing.',
    'Pick the single most-critical missing field — usually one of: objective, scope, format, data source, audience, deadline.',
    'Phrase the question directly and concretely; max 2 sentences. Mirror the user language.',
    'Do not propose a tentative plan, do not list multiple options, do not assume a deliverable format, do not attempt the task before the user answers.',
    'Skip the question and proceed under the closest matching contract only if subsequent context (attachments, conversation history) already resolves the ambiguity.',
  ].join('\n'),
}

export function buildProfessionalCapabilityPrompt(intent: ChatIntent, prompt: string): string {
  const contract = PROFESSIONAL_CAPABILITY_CONTRACTS[intent]
  if (!contract) return prompt
  const sections: string[] = [prompt, '', '---']
  // Ambiguous contract is a clarification request — wrapping it in the
  // 5-step skeleton would push the model to fabricate a plan before
  // asking, which is exactly what the contract forbids.
  if (intent !== 'ambiguous') {
    sections.push(PROFESSIONAL_EXECUTION_SKELETON, '')
  }
  sections.push(
    `siraGPT professional execution contract for ${intent}:`,
    contract,
    '---',
  )
  return sections.join('\n')
}

const normalizePrompt = (prompt: string) =>
  (prompt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const GOAL_COMMAND_RE = /(?:^|\s)\/goal\b|\b(?:modo\s+goal|goal\s+mode)\b/i

const EXISTING_DOCUMENT_REFERENCE_RE =
  /\b(?:del|de la|de el|en el|sobre el|este|esta|ese|esa|mi|el|la)\s+(?:word|documento|archivo|adjunto|docx?|pdf|excel|xlsx|power\s*point|powerpoint|pptx?)\b|\b(?:word|documento|archivo|adjunto|docx?|pdf|excel|xlsx|pptx?)\s+(?:adjunto|subido|cargado|anterior)\b/i

const DOCUMENT_UNDERSTANDING_RE =
  /\b(?:cual|cu[aá]l|que|qu[eé]|quien|qui[eé]n|cuando|cu[aá]ndo|donde|d[oó]nde|primera\s+palabra|primer\s+parrafo|primer\s+p[aá]rrafo|resume|resumen|resumir|analiza|analisis|an[aá]lisis|lee|leer|extrae|extraer|identifica|identificar|dime|segun|seg[uú]n|explica|explicar|contenido|menciona|dice)\b/i

const EXISTING_DOCUMENT_EDIT_RE =
  /\b(?:agrega(?:r|me|s)?|a[ñn]ad(?:e|ir|eme|as)?|inserta(?:r|me|s)?|incorpora(?:r|me|s)?|inclu(?:ye|ir|yeme|yas)?|completa(?:r|me|s)?|llen(?:a|ar|ame|as)?|rellena(?:r|me|s)?|desarrolla(?:r|me|s)?|modifica(?:r|me|s)?|edita(?:r|me|s)?|corrige(?:r|me|s)?|actualiza(?:r|me|s)?|reemplaza(?:r|me|s)?|cambia(?:r|me|s)?|pon(?:er|me)?|coloca(?:r|me|s)?)\b[^.?!]{0,180}\b(?:al\s+final|anexos?|ap[eé]ndice|secci[oó]n|apartado|cap[ií]tulo|portada|car[aá]tula|t[ií]tulo|encabezado|pie\s+de\s+p[aá]gina|tabla|hoja|celda|fila|columna|diapositiva|instrumento|cuestionario|encuesta|escala|tesis|mismo\s+word|mismo\s+documento|sin\s+cambiar|conserva(?:r)?|preserva(?:r)?)\b/i

// STRONG document-mutation verbs: an imperative command to change the file's
// content (delete / remove / insert / add / edit / replace / restructure). On
// an attachment turn these unambiguously mean "edit the attached document" even
// with NO structure keyword ("borra el jurado evaluador", "elimina los anexos",
// "agrega una conclusión") — so unlike EXISTING_DOCUMENT_EDIT_RE they need no
// target noun. They never appear in plain read-only Q&A ("¿qué dice?",
// "resume", "explica"). Used to route document EDITS to the durable
// /api/agent/task path, where the source-preserving Office editor verifies the
// downloaded artifact.
const DOCUMENT_MUTATION_STRONG_RE =
  /\b(?:borra\w*|borre\w*|elimin\w*|quita\w*|quite\w*|suprim\w*|remov\w*|remueve\w*|tach(?:a|e|ar)\w*|descart\w*|s[aá]ca\w*|agrega\w*|agr[eé]ga\w*|a[ñn]ad\w*|inserta\w*|insert\w*|incorpora\w*|edita\w*|edit[aá]\w*|modific\w*|corrig\w*|correg\w*|reemplaz\w*|sustitu\w*|renombr\w*|reescrib\w*|reorganiz\w*|reordena\w*|reformate\w*|reenumera\w*|delete\w*|remove\w*|erase\w*|append\w*|modify\w*|replace\w*|rewrite\w*|rename\w*)\b/i

const DOCUMENT_ATTACHMENT_REVISION_RE =
  /\b(?:corrig\w*|correg\w*|mejor\w*|modific\w*|edit\w*|actualiz\w*|formaliz\w*|ajust\w*|optim\w*)\b/i

// Whole-document transforms (translate / rewrite / summarize / rephrase)
// operate on the entire uploaded file, so unlike EXISTING_DOCUMENT_EDIT_RE
// they don't require a sub-region target keyword. When a document is
// attached, these verbs should route to the source-preserving editor.
// IMPORTANT: match VERB forms only — generic stems like `cambi\w*` / `resum\w*`
// also capture nouns ("cambio", "resumen", "traducción") and would hijack
// read-only prompts ("explica el cambio del documento") into a fake edit.
const WHOLE_DOCUMENT_TRANSFORM_RE =
  /\b(?:traduc(?:e\w*|ir\w*|iendo|id[oa])|traduzca\w*|reescrib(?:e\w*|ir\w*|iendo)|reescrit[oa]|reformul(?:e\w*|a|as|ar\w*|alo|ala|ame|ando|ad[oa])|parafrase\w*|sintetiz(?:a\w*|e\w*|ando|ad[oa])|sintetice\w*|resum(?:e|es|ir\w*|a|as|amos|elo|ela|elos|elas|eme|emelo|iendo|id[oa])|transcrib(?:e\w*|ir\w*|a\w*|iendo)|transcrit[oa]|cambi(?:a\w*|e\w*))\b/i

const OUTPUT_FORMAT_REQUEST_RE =
  /\b(?:en|como|a)\s+(?:un\s+|una\s+)?(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|svg)\b|\b(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|exporta(?:r|me)?|descarga(?:r|me)?|prepara(?:r|me)?|elabora(?:r|me)?|redacta(?:r|me)?)\b.*\b(?:word|docx|pdf|excel|xlsx|pptx|power\s*point|powerpoint|svg|documento|archivo|informe|reporte|presentaci[oó]n)\b/i

const DOCUMENT_FILE_EXT_RE = /\.(?:docx?|pdf|xlsx?|csv|pptx?|txt|md)$/i
const SPREADSHEET_FILE_EXT_RE = /\.(?:xlsx?|csv)$/i

const DOCUMENT_MIME_RE =
  /(?:application\/(?:pdf|msword|vnd\.openxmlformats-officedocument|vnd\.ms-|vnd\.oasis\.opendocument)|text\/(?:plain|markdown|csv)|application\/csv)/i

const SPREADSHEET_MIME_RE = /(?:spreadsheet|excel|csv|ms-excel|sheet)/i

const MEDIA_CREATE_ACTION_RE_FRAGMENT =
  '(?:cr(?:ea|eame|ear)|gener(?:a|ame|ar|ate)|haz(?:me|melo|lo|la)?|dame|quiero|necesito|produce(?:me)?|compon(?:e|me|er)|prepara(?:me)?|convierte(?:lo)?|narra(?:me)?|lee(?:me)?|make|create|generate|compose|produce|turn|read)'

const MUSIC_OBJECT_RE_FRAGMENT =
  '(?:cancion(?:es)?|musica|music|melodi(?:a|as)|instrumental(?:es)?|soundtracks?|banda sonora|jingles?|tema musical|temas musicales|beats?|songs?|tune)'

const VOICE_OBJECT_RE_FRAGMENT =
  '(?:audios?|voz|voces|narracion(?:es)?|narra|locucion(?:es)?|podcasts?|voiceover|voice over|audiolibros?|dictado|tts|speech|doblaje|voz en off)'

const VIDEO_OBJECT_RE_FRAGMENT =
  '(?:videos?|clips?|animaci(?:o|ó)n(?:es)?|movies?|sora|veo\\s*3|veo3|text[- ]?to[- ]?video|image[- ]?to[- ]?video)'

const createMediaGenerationPattern = (objectPattern: string) =>
  new RegExp(
    `\\b${MEDIA_CREATE_ACTION_RE_FRAGMENT}\\b[^.?!]{0,120}\\b${objectPattern}\\b|\\b${objectPattern}\\b[^.?!]{0,120}\\b${MEDIA_CREATE_ACTION_RE_FRAGMENT}\\b`,
    'i'
  )

const DEFAULT_VIDEO_DURATION_SECONDS = Object.freeze([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
const VIDEO_DURATION_SECONDS_RE =
  /\b(1[0-5]|[4-9])\s*(?:s|seg(?:undo)?s?|sec(?:ond)?s?)\b/i

export type RequestedVideoAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
export type RequestedVideoResolution = '480p' | '720p'

const VIDEO_RATIO_TOKEN_RE =
  /\b(16:9|9:16|1:1|4:3|3:4|21:9|16x9|9x16|1x1|4x3|3x4|21x9)\b/i

const VIDEO_RESOLUTION_TOKEN_RE =
  /\b(480|720)\s*p\b/i

export function extractRequestedVideoDurationSeconds(
  prompt: string,
  allowedDurations: readonly number[] = DEFAULT_VIDEO_DURATION_SECONDS,
): number | null {
  const normalized = normalizePrompt(prompt)
  const match = normalized.match(VIDEO_DURATION_SECONDS_RE)
  if (!match) return null
  const duration = Number(match[1])
  return allowedDurations.includes(duration) ? duration : null
}

export function extractRequestedVideoAspectRatio(prompt: string): RequestedVideoAspectRatio | null {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return null

  const ratio = normalized.match(VIDEO_RATIO_TOKEN_RE)
  if (ratio) return ratio[1].replace('x', ':') as RequestedVideoAspectRatio

  if (/\b(?:cuadrad[oa]s?|square|post de instagram|feed de instagram)\b/.test(normalized)) return '1:1'
  if (/\b(?:vertical(?:es)?|retrato|portrait|tiktok|reels?|historias?|story|stories|shorts?|para movil|formato movil|mas alto que ancho)\b/.test(normalized)) return '9:16'
  if (/\b(?:rectangular(?:es)?|horizontal(?:es)?|apaisad[oa]s?|panoramic[oa]s?|landscape|widescreen|youtube|miniatura|thumbnail|banner|portada|cover|cabecera|mas ancho que alto)\b/.test(normalized)) return '16:9'
  if (/\b(?:cinema|cinematico|cinematografico|ultrawide|panavision)\b/.test(normalized)) return '21:9'

  return null
}

export function extractRequestedVideoResolution(prompt: string): RequestedVideoResolution | null {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return null

  const match = normalized.match(VIDEO_RESOLUTION_TOKEN_RE)
  if (match?.[1] === '480') return '480p'
  if (match?.[1] === '720') return '720p'

  if (/\b(?:sd|baja resolucion|resolucion baja|ligero|liviano)\b/.test(normalized)) return '480p'
  if (/\b(?:hd|alta resolucion|resolucion alta|calidad alta)\b/.test(normalized)) return '720p'

  return null
}

export function extractRequestedVideoAudio(prompt: string): boolean | null {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return null

  if (/\b(?:sin audio|sin sonido|sin musica|sin voz|mudo|silencioso|audio off|mute|muted|no audio|no sound)\b/.test(normalized)) return false
  if (/\b(?:con audio|con sonido|con musica|con voz|audio on|sonido activado|audio activado)\b/.test(normalized)) return true

  return null
}

const parseFilesFromMessage = (message: any): any[] => {
  const rawFiles = message?.files
  if (!rawFiles) return []
  if (Array.isArray(rawFiles)) return rawFiles
  if (typeof rawFiles === 'string') {
    try {
      const parsed = JSON.parse(rawFiles)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

const isDocumentLikeAttachment = (file: any) => {
  if (!file) return false
  if (typeof file === 'string') return DOCUMENT_FILE_EXT_RE.test(file)
  const name = String(file.name || file.originalName || file.filename || file.path || '')
  const mimeType = String(file.mimeType || file.type || file.contentType || '')
  if (mimeType.startsWith('image/') || file.type === 'image') return false
  return DOCUMENT_FILE_EXT_RE.test(name) || DOCUMENT_MIME_RE.test(mimeType)
}

const isSpreadsheetLikeAttachment = (file: any) => {
  if (!file) return false
  if (typeof file === 'string') return SPREADSHEET_FILE_EXT_RE.test(file)
  const name = String(file.name || file.originalName || file.filename || file.path || '')
  const mimeType = String(file.mimeType || file.type || file.contentType || '')
  return SPREADSHEET_FILE_EXT_RE.test(name) || SPREADSHEET_MIME_RE.test(mimeType)
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i
const isImageLikeAttachment = (file: any) => {
  if (!file) return false
  if (typeof file === 'string') return IMAGE_FILE_EXT_RE.test(file)
  const name = String(file.name || file.originalName || file.filename || file.path || '')
  const mimeType = String(file.mimeType || file.type || file.contentType || '')
  return mimeType.toLowerCase().startsWith('image/') || file.type === 'image' || IMAGE_FILE_EXT_RE.test(name)
}

/**
 * True when EVERY attachment is an image (and there is at least one). Such
 * turns need VISION, which lives only in the plain /api/ai/generate path — the
 * queued agent-task / react-agent loop has no vision and stalls on the image.
 */
export function isImageOnlyAttachmentTurn(files: any[] = []): boolean {
  const list = Array.isArray(files) ? files : []
  return list.length > 0 && list.every(isImageLikeAttachment)
}

export function hasDocumentAttachmentContext(conversationHistory: any[] = []): boolean {
  return (Array.isArray(conversationHistory) ? conversationHistory : []).some((message) =>
    parseFilesFromMessage(message).some(isDocumentLikeAttachment)
  )
}

export function shouldEditExistingDocument(
  prompt: string,
  conversationHistory: any[] = []
): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return false
  const hasDocumentContext = hasDocumentAttachmentContext(conversationHistory)
  if (
    hasDocumentContext
    && !OUTPUT_FORMAT_REQUEST_RE.test(normalized)
    && (
      (DOCUMENT_MUTATION_STRONG_RE.test(normalized) && !WHOLE_DOCUMENT_TRANSFORM_RE.test(normalized))
      || DOCUMENT_ATTACHMENT_REVISION_RE.test(normalized)
    )
  ) {
    return true
  }
  const referencesExistingDocument =
    EXISTING_DOCUMENT_REFERENCE_RE.test(normalized) || hasDocumentContext
  if (EXISTING_DOCUMENT_EDIT_RE.test(normalized)) return referencesExistingDocument
  // Whole-document transforms (traduce / resume / reescribe / reformula) count
  // as edits only when the prompt explicitly references a document AND a file is
  // attached — so "traduce esta frase" / "cambia de tema" stay normal chat
  // answers, and pure format conversions ("pásalo a PDF") go to doc generation.
  if (
    WHOLE_DOCUMENT_TRANSFORM_RE.test(normalized)
    && EXISTING_DOCUMENT_REFERENCE_RE.test(normalized)
    && !OUTPUT_FORMAT_REQUEST_RE.test(normalized)
  ) {
    return hasDocumentContext
  }
  return false
}

export function shouldAnswerFromExistingDocument(
  prompt: string,
  conversationHistory: any[] = []
): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return false
  if (OUTPUT_FORMAT_REQUEST_RE.test(normalized)) return false
  if (shouldEditExistingDocument(prompt, conversationHistory)) return false
  const referencesExistingDocument =
    EXISTING_DOCUMENT_REFERENCE_RE.test(normalized)
    || hasDocumentAttachmentContext(conversationHistory)
  if (!referencesExistingDocument) return false
  if (!DOCUMENT_UNDERSTANDING_RE.test(normalized)) return false

  // Even without loaded history, this is a question about an existing
  // document ("del Word"), not a request to create a new Word file.
  // History presence is used separately to reattach the previous file.
  return true
}

export function shouldUseExistingDocumentFileContext(
  prompt: string,
  conversationHistory: any[] = []
): boolean {
  return shouldAnswerFromExistingDocument(prompt, conversationHistory)
    || shouldEditExistingDocument(prompt, conversationHistory)
}

const ROUTING_PATTERNS = {
  gmail: /\b(gmail|e-?mail|correo(s)?|mail|inbox|bandeja de entrada|redacta(r)? (un )?correo|envia(r)? (un )?correo|responde(r)? (un )?correo|lee(r)? (mis )?correos)\b/i,
  googleServices: /\b(google (calendar|calendario|drive)|calendar|calendario|evento|event|meeting|reunion|agenda|drive|carpeta|folder)\b/i,
  urlReference: /\bhttps?:\/\/\S+|\bwww\.\S+/i,
  realtimeLookup: /\b(clima|tiempo actual|pron[oó]stico|temperatura|weather|forecast)\b|\b(resultados?|marcador|score|partidos?|fixture|estad[ií]sticas?)\b.*\b(nba|nfl|mlb|nhl|f[uú]tbol|soccer|epl|champions|liga|deporte|sports?)\b|\b(restaurantes?|hoteles?|lugares?|atracciones?|direcci[oó]n|mapa|ruta|itinerario|cerca de mi|google places)\b/i,
  externalResearch: /\b(investiga(r|cion)?|investigate|research|busca(r)?|find|recopila(r)?|fuentes|citas|referencias|articulos?|papers?|literatura|academicos?|cientificos?|mercado|benchmark|competidores|estado del arte|revision sistematica|metaanalisis|meta analisis|scielo|redalyc|dialnet|openalex|crossref|pubmed|doi|semantic scholar|doaj|scopus|web of science|wos)\b/i,
  deliverableFile: /\b(docx|xlsx|pptx|word|excel|power\s*point|powerpoint|pdf\b|svg|informe|reporte|presentacion|diapositivas|slides|hoja de calculo|spreadsheet|archivo|documento|matriz narrativa|matriz de consistencia|base de datos)\b/i,
  dataWork: /\b(calcula(r)?|analiza(r)?|procesa(r)?|limpia(r)?|extrae(r)?|clasifica(r)?|regresion|estadistica|csv|datos|dataset|cronbach|spearman|anova|correlacion|likert)\b/i,
  codeWork: /\b(codigo|code|programa|script|web|website|landing|sitio|frontend|backend|software|app|aplicacion|aplicaci[oó]n|runtime|debug|bug|corrige(r)?|arregla(r)?|fix|prueba(s)?|test(s)?|autocorrige(r)?|auto corrige(r)?|revisando y corrigiendo)\b/i,
  implementationWork: /\b(implementa(r|me)?|mejora(r|s)?|optimiza(r)?|integra(r)?|aplica(r)?|añade|agrega(r)?|refactoriza(r)?|revisa(r)?|audita(r)?|haz(?:lo)?|build|ship|patch)\b/i,
  repoOperation: /\b(?:github\.com\/[\w.-]+\/[\w.-]+|git\s+clone|clona(?:r|me)?|clone(?:ar)?|fork|pull\s+request|pr\b|commit|push|sube(?:r)?\s+(?:a\s+)?(?:github|main)|repositorio|repo|checkout|branch|rama|main|ci\s+(?:verde|green)|actions?)\b/i,
  longRunningAgent: /\b(2 horas|dos horas|30 minutos|60 minutos|una hora|sin detenerse|sin parar|persistente|background|mientras salgo|aunque cierre|auto.?corrige|autonom(o|a)|verifica(r)?|self.?check|self.?supervision|modo\s+goal|goal\s+mode)\b|(?:^|\s)\/goal\b/i,
  architecturePlan: /\b(plano|planos|blueprint|floor[- ]?plan|planta (arquitect|baj|alt)|plano arquitectonico|dxf)\b|\b(casa|vivienda|departamento|oficina)\b.*\b(plano|planta|arquitectonico|distribucion|habitaciones|dormitorios|banos)\b/i,
  artifact: /\b(calculadora (interactiva|de|para|con)|simulador|quiz|cuestionario|widget|componente interactivo|artifact|artefacto|editor (apa|en tiempo real|de citas?)|dashboard (interactivo|con inputs|que (calcul|actualiz|responda))|herramienta (interactiva|para calcular)|interfaz interactiva|visualizador (interactivo|que recalcul)|mapa interactivo|animacion(?:es)?(?: en)? 3d|three\.?js|threejs|modelo 3d|visor 3d|evaluador de ensayos|grader|rubrica interactiva)\b/i,
  math: /\b(integral|integrar|derivada|derivar|d\/dx|ecuacion|cronbach|alpha de cronbach|autovalor|eigenval|matriz (inversa|transpuesta|determinante)|regresion|chi[- ]?cuadrado|anova|t[- ]?test|p[- ]?valor|probabilidad (de|binomial|normal|poisson)|varianza|desviacion estandar|media aritmetica|desviacion tipica|limite cuando|serie de fourier|transformada de laplace|sistema de ecuaciones|factorizar|simplifica (la )?expresion|despejar|funcion (derivada|continua|inversa)|examen de (matematicas|fisica|quimica|estadistica)|problemas de (matematicas|fisica|quimica|estadistica))\b/i,
  // doc — match ONLY when there is an explicit generation/export verb
  // paired with a document format/keyword, OR a specific instrument/
  // template name. Bare format keywords (word, excel, pdf, pptx) are
  // intentionally NOT included here: a question like "¿cuál es la
  // primera palabra del word?" is about an existing uploaded file, not
  // a request to generate a new document. Without this guard, every
  // mention of "word"/"excel" routed to the document pipeline.
  doc: /\b(?:(?:descargar?|genera(?:r|me)?|crea(?:me|r)?|exporta(?:r|me)?|haz(?:me)?|hazme|envia(?:me)?|elabora(?:me|r)?|redacta(?:me|r)?|prepara(?:me|r)?|arma(?:me)?|construye(?:me)?|necesito|quiero|dame)\s+(?:un[oa]?\s+|el\s+|la\s+|los\s+|las\s+)?(?:nuev[oa]\s+)?(?:documento|archivo|informe|reporte|tesis|monograf[ií]a|ensayo|memoria|presentaci[oó]n|hoja\s+de\s+c[aá]lculo|spreadsheet|ppt|pptx?|docx?|word|excel|powerpoint|power\s*point|pdf|xlsx|svg)|exporta(?:r|me)?\s+(?:a|en|como)\s+(?:pdf|word|excel|docx|xlsx|pptx|powerpoint|svg)|informe\s+(?:apa|word|pdf)|tesis\s+(?:formato|apa|word)|apa\s*7|apa\s+septima|plantilla\s+upn|instrumento\s+(?:bai|phq|gad|whoqol)|whoqol|phq-?9|gad-?7|escala\s+de\s+bai)\b/i,
  viz: /\b(graficos?|graficas?|plot|plotear|histogram(a|as)?|pareto|ishikawa|fishbone|espina de pescado|box[- ]?plot|diagrama de caja|scatter|dispersion|s[- ]?curve|curva s|earned value|gantt|sankey|treemap|mapa de arbol|heatmap|mapa de calor|flujo de (datos|procesos?)|diagrama (de )?(flujo|er|entidad[- ]relacion|clases?|secuencia|estados?|uml|jerarquia|jornada|journey)|dashboard (de|para|con)|visuali(c|z)a(r|cion)?|torta|pastel|barras apiladas?|mermaid|d3|plotly|recharts|chart\.?js)\b/i,
  image: /\b(imagen|image|photo|foto|picture|drawing|dibujo|logo|ilustracion|render)\b/i,
  video: createMediaGenerationPattern(VIDEO_OBJECT_RE_FRAGMENT),
  musicGeneration: createMediaGenerationPattern(MUSIC_OBJECT_RE_FRAGMENT),
  voiceGeneration: createMediaGenerationPattern(VOICE_OBJECT_RE_FRAGMENT),
  webdev: /\b(website|webpage|pagina web|sitio web|landing page|portfolio|html|css|javascript|react|next\.?js|frontend|web app|tienda online|ecommerce|e-commerce)\b/i,
  webdevBuildAction: /\b(crea(r|me)?|build|make|design|disena(r|me)?|diseña(r|me)?|desarrolla(r)?|programa(r)?|genera(r)?|haz|construye|implementa(r)?|maqueta(r)?)\b/i,
  figma: /\b(figma|wireframe|user flow|design system|diagrama de producto|prototipo navegable)\b/i,
}

export function shouldAutoActivateVideoGeneration(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  return !!normalized && ROUTING_PATTERNS.video.test(normalized)
}

// Analysis/understanding questions ABOUT an image ("describe esta imagen",
// "¿qué ves?", "transcribe la foto", "what does it say"). These mention image
// words, so the bare `image` routing pattern misreads them as image
// GENERATION — which hijacked "describir que ves en esta imagen" + an attached
// photo into the image generator instead of the vision chat path. Inputs are
// matched after normalizePrompt (lowercase, accents stripped).
const IMAGE_ANALYSIS_PROMPT_RE = new RegExp(
  '(' + [
    // Spanish analysis verbs / question shapes
    '\\bdescrib',                                  // describe / describir / descríbeme
    '\\btranscrib',                                // transcribe / transcribir / transcríbela
    '\\bque\\s+(se\\s+)?ves?\\b',                  // qué ves / que se ve
    '\\bque\\s+dice\\b',
    '\\bque\\s+hay\\b',
    '\\bque\\s+observas\\b',
    '\\bocr\\b',
    '\\bextrae\\w*\\s+(el\\s+)?texto',
    '\\blee\\w*\\s+(la|el|esta|este)\\b',
    '\\b(analiza\\w*|explica\\w*|interpreta\\w*|identifica\\w*|reconoce\\w*|traduce\\w*|resume\\w*)\\s+(la\\s+|el\\s+|esta\\s+|este\\s+)?(imagen|foto|captura|screenshot|pantallazo)',
    '\\bdescripcion\\s+de\\s+(la|esta)\\s+(imagen|foto|captura)',
    // English
    '\\btranscribe\\b', '\\bcaption\\b',
    '\\bwhat\\s+do\\s+you\\s+see\\b',
    '\\bwhat\\s+does\\s+(it|this|the)\\s+\\w*\\s*say\\b',
    '\\bwhat.?s\\s+in\\s+(the|this)\\b',
    '\\bread\\s+(the|this)\\b',
    '\\bextract\\s+(the\\s+)?text',
    '\\b(analyze|explain|identify|translate|summarize)\\s+(the\\s+|this\\s+)?(image|photo|picture|screenshot)',
  ].join('|') + ')',
  'i',
)

/**
 * True when the prompt asks to ANALYSE / read / describe an image rather than
 * generate one. Used to keep "describe esta imagen" turns on the vision chat
 * path — the image generator must never hijack an understanding question.
 */
export function isImageAnalysisPrompt(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return false
  return IMAGE_ANALYSIS_PROMPT_RE.test(normalized)
}

const CONTEXT_FOLLOWUP_RE =
  /\b(?:eso|esto|aquello|lo anterior|anterior|mismo|misma|tambien|también|ahora|despues|después|luego|ademas|además|hazlo|hacelo|con eso|usa eso|usalo|úsalo|en base a eso|basado en eso|convierte(?:lo)?|pasalo|pásalo|exportalo|expórtalo)\b/i

const NON_CREATION_MEDIA_ADVICE_RE =
  /\b(?:qu[eé]|cu[aá]l(?:es)?|recomienda(?:s|me)?|sugiere(?:s|me)?|aconseja(?:s|me)?|mejor(?:es)?)\b[^.?!]{0,120}\b(?:videos?|m[uú]sica|canci[oó]n(?:es)?|audios?)\b|\b(?:videos?|m[uú]sica|canci[oó]n(?:es)?|audios?)\b[^.?!]{0,120}\b(?:recomienda(?:s|me)?|sugiere(?:s|me)?|aconseja(?:s|me)?|mejor(?:es)?)\b/i

const getMessageText = (message: any): string => {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

const addIntentNode = (
  nodes: IntentAttributionNode[],
  id: string,
  label: string,
  group: IntentAttributionNode['group'],
  weight: number,
  evidence: string
) => {
  if (!nodes.some((node) => node.id === id)) {
    nodes.push({ id, label, group, weight, evidence })
  }
}

const signalIntentFromText = (text: string): ChatIntent | null => {
  const normalized = normalizePrompt(text)
  if (!normalized) return null
  if (GOAL_COMMAND_RE.test(text)) return 'agent_task'

  const asksForUrlReference = ROUTING_PATTERNS.urlReference.test(normalized)
  const asksForExternalResearch = ROUTING_PATTERNS.externalResearch.test(normalized)
  const asksForRealtimeLookup = ROUTING_PATTERNS.realtimeLookup.test(normalized)
  const asksForDeliverableFile = ROUTING_PATTERNS.deliverableFile.test(normalized)
  const asksForDataWork = ROUTING_PATTERNS.dataWork.test(normalized)
  const asksForCodeWork = ROUTING_PATTERNS.codeWork.test(normalized)
  const asksForImplementationWork = ROUTING_PATTERNS.implementationWork.test(normalized)
  const asksForRepoOperation = ROUTING_PATTERNS.repoOperation.test(normalized)
  const asksForLongRunningAgent = ROUTING_PATTERNS.longRunningAgent.test(normalized)

  if (ROUTING_PATTERNS.gmail.test(normalized)) return 'gmail'
  if (ROUTING_PATTERNS.googleServices.test(normalized)) return 'google_services'

  if (
    asksForRepoOperation
    || (asksForUrlReference && asksForImplementationWork && asksForCodeWork)
    || (asksForDeliverableFile && (asksForExternalResearch || asksForDataWork || asksForCodeWork))
    || (asksForLongRunningAgent && (asksForExternalResearch || asksForDeliverableFile || asksForDataWork || asksForCodeWork))
  ) {
    return 'agent_task'
  }

  if (asksForExternalResearch || asksForRealtimeLookup || asksForUrlReference) return 'web_search'
  if (ROUTING_PATTERNS.architecturePlan.test(normalized)) return 'plan'
  if (ROUTING_PATTERNS.artifact.test(normalized)) return 'artifact'
  if (ROUTING_PATTERNS.math.test(normalized)) return 'math'
  if (ROUTING_PATTERNS.doc.test(normalized)) return 'doc'
  if (ROUTING_PATTERNS.viz.test(normalized)) return 'viz'
  if (ROUTING_PATTERNS.video.test(normalized)) return 'video'
  if (ROUTING_PATTERNS.musicGeneration.test(normalized) || ROUTING_PATTERNS.voiceGeneration.test(normalized)) return 'agent_task'
  // "describe esta imagen / ¿qué ves? / transcribe la foto" is image
  // ANALYSIS (vision chat), not generation — don't let the bare image-word
  // pattern hijack it into the image generator.
  if (ROUTING_PATTERNS.image.test(normalized) && !IMAGE_ANALYSIS_PROMPT_RE.test(normalized)) return 'image'
  if (ROUTING_PATTERNS.figma.test(normalized)) return 'figma'
  if (ROUTING_PATTERNS.webdev.test(normalized) && ROUTING_PATTERNS.webdevBuildAction.test(normalized)) return 'webdev'
  return null
}

const latestUserContextIntent = (conversationHistory: any[] = []): ChatIntent | null => {
  const recent = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .slice(-8)
    .reverse()

  for (const message of recent) {
    const role = String(message?.role || '').toLowerCase()
    if (role && role !== 'user') continue
    const intent = signalIntentFromText(getMessageText(message))
    if (intent && intent !== 'ambiguous') return normalizeRoutingIntent(intent)
  }

  return null
}

/**
 * A small, deterministic analogue of the attribution-graph idea from
 * interpretability work: expose which prompt/history/attachment features
 * caused a routing decision. This is not model-internal tracing; it is an
 * inspectable graph over our own routing signals so follow-up prompts can
 * inherit the user's actual goal instead of being classified from keywords
 * alone.
 */
export function buildIntentAttributionGraph(
  prompt: string,
  conversationHistory: any[] = [],
  files: any[] = []
): IntentAttributionGraph {
  const normalized = normalizePrompt(prompt)
  const nodes: IntentAttributionNode[] = []
  const edges: IntentAttributionEdge[] = []
  const supernodes: Record<string, string[]> = {
    user_goal: [],
    requested_output: [],
    context_source: [],
    execution_route: [],
  }
  const rationale: string[] = []
  const words = normalized.split(/\s+/).filter(Boolean)

  const currentIntent = signalIntentFromText(normalized)
  const historyIntent = latestUserContextIntent(conversationHistory)
  const allFiles = [
    ...(Array.isArray(files) ? files : []),
    ...(Array.isArray(conversationHistory) ? conversationHistory.flatMap(parseFilesFromMessage) : []),
  ]
  const hasDocumentContext = allFiles.some(isDocumentLikeAttachment)
  const hasSpreadsheetContext = allFiles.some(isSpreadsheetLikeAttachment)
  const editsExistingDocument = hasDocumentContext
    && !OUTPUT_FORMAT_REQUEST_RE.test(normalized)
    && (
      EXISTING_DOCUMENT_EDIT_RE.test(normalized)
      || (DOCUMENT_MUTATION_STRONG_RE.test(normalized) && !WHOLE_DOCUMENT_TRANSFORM_RE.test(normalized))
      || DOCUMENT_ATTACHMENT_REVISION_RE.test(normalized)
      || (WHOLE_DOCUMENT_TRANSFORM_RE.test(normalized) && EXISTING_DOCUMENT_REFERENCE_RE.test(normalized))
    )
  const isShortContextualFragment =
    words.length <= 6
    && !!historyIntent
    && !isLightweightConversationalPrompt(normalized)
    && !/[?¿]/.test(normalized)
    && /^(?:en|con|para|sin|mas|más|otra|otro|hazlo|hacelo|pasalo|pásalo|tambien|también|ahora)\b/.test(normalized)
  const isFollowup = CONTEXT_FOLLOWUP_RE.test(normalized) || isShortContextualFragment

  if (currentIntent) {
    addIntentNode(nodes, `current:${currentIntent}`, `current prompt suggests ${currentIntent}`, 'current_prompt', 0.9, prompt)
    supernodes.user_goal.push(`current:${currentIntent}`)
  }
  if (ROUTING_PATTERNS.urlReference.test(normalized)) {
    addIntentNode(nodes, 'current:external-reference', 'external reference URL', 'current_prompt', 0.78, prompt)
    supernodes.context_source.push('current:external-reference')
  }
  if (ROUTING_PATTERNS.implementationWork.test(normalized)) {
    addIntentNode(nodes, 'current:implementation-action', 'implementation or improvement action', 'current_prompt', 0.8, prompt)
    supernodes.user_goal.push('current:implementation-action')
  }
  if (ROUTING_PATTERNS.codeWork.test(normalized)) {
    addIntentNode(nodes, 'current:software-target', 'software/code target', 'current_prompt', 0.78, prompt)
    supernodes.user_goal.push('current:software-target')
  }
  if (historyIntent) {
    addIntentNode(nodes, `history:${historyIntent}`, `recent context suggests ${historyIntent}`, 'conversation_context', 0.72, historyIntent)
    supernodes.context_source.push(`history:${historyIntent}`)
  }
  if (isFollowup) {
    addIntentNode(nodes, 'current:followup', 'context-dependent follow-up', 'current_prompt', 0.82, prompt)
    supernodes.context_source.push('current:followup')
  }
  if (hasDocumentContext) {
    addIntentNode(nodes, 'attachment:document', 'document attachment context', 'attachments', 0.68, 'document-like file')
    supernodes.context_source.push('attachment:document')
  }
  if (editsExistingDocument) {
    addIntentNode(nodes, 'current:document-edit', 'edits a specific part of an existing document', 'current_prompt', 0.88, prompt)
    supernodes.user_goal.push('current:document-edit')
  }
  if (hasSpreadsheetContext) {
    addIntentNode(nodes, 'attachment:spreadsheet', 'spreadsheet attachment context', 'attachments', 0.74, 'spreadsheet-like file')
    supernodes.context_source.push('attachment:spreadsheet')
  }
  if (ROUTING_PATTERNS.deliverableFile.test(normalized) || OUTPUT_FORMAT_REQUEST_RE.test(normalized)) {
    addIntentNode(nodes, 'current:deliverable', 'explicit output format', 'current_prompt', 0.85, prompt)
    supernodes.requested_output.push('current:deliverable')
  }

  let inferredIntent: ChatIntent | null = null
  let confidence = 0

  if (hasDocumentContext && shouldAnswerFromExistingDocument(prompt, conversationHistory)) {
    inferredIntent = 'agent_task'
    confidence = 0.9
    rationale.push('Uploaded-document question requires durable agent execution with private-context retrieval before answering.')
  } else if (isFollowup && currentIntent && historyIntent) {
    if (hasDocumentContext && shouldAnswerFromExistingDocument(prompt, conversationHistory)) {
      inferredIntent = 'agent_task'
      confidence = 0.9
      rationale.push('Follow-up asks about an uploaded document; durable agent must retrieve private context before answering.')
    } else if (currentIntent === 'doc' && ['web_search', 'math', 'viz', 'agent_task'].includes(historyIntent)) {
      inferredIntent = 'agent_task'
      confidence = 0.88
      rationale.push('Follow-up asks for a file while prior context contains research, computation, or visualization work.')
    } else if (currentIntent === 'viz' && ['math', 'web_search', 'agent_task'].includes(historyIntent)) {
      inferredIntent = 'viz'
      confidence = 0.84
      rationale.push('Follow-up asks to visualize the result from prior analytical context.')
    } else {
      inferredIntent = normalizeRoutingIntent(currentIntent)
      confidence = 0.76
      rationale.push('Current prompt has an explicit route and recent context only supplies the object.')
    }
  } else if (isFollowup && historyIntent && !currentIntent) {
    inferredIntent = normalizeRoutingIntent(historyIntent)
    confidence = words.length <= 4 ? 0.65 : 0.72
    rationale.push('Short follow-up inherits the latest concrete user goal from conversation history.')
  } else if (editsExistingDocument) {
    inferredIntent = 'agent_task'
    confidence = 0.9
    rationale.push('Existing document attachment plus edit wording requires the agentic source-preserving document editor.')
  } else if (!currentIntent && hasSpreadsheetContext && ROUTING_PATTERNS.dataWork.test(normalized)) {
    inferredIntent = 'math'
    confidence = 0.7
    rationale.push('Spreadsheet attachment plus data-work wording implies computation/analysis.')
  } else if (!currentIntent && hasDocumentContext && DOCUMENT_UNDERSTANDING_RE.test(normalized) && !OUTPUT_FORMAT_REQUEST_RE.test(normalized)) {
    inferredIntent = 'agent_task'
    confidence = 0.84
    rationale.push('Document attachment plus understanding wording implies agentic document chat with private-context retrieval.')
  } else if (currentIntent) {
    inferredIntent = normalizeRoutingIntent(currentIntent)
    confidence = currentIntent === 'agent_task' ? 0.86 : 0.8
    rationale.push('Current prompt has enough direct attribution support to choose a route before semantic fallback.')
  }

  if (inferredIntent) {
    addIntentNode(nodes, `route:${inferredIntent}`, `route to ${inferredIntent}`, 'routing', confidence, rationale.join(' '))
    supernodes.execution_route.push(`route:${inferredIntent}`)
    for (const node of nodes) {
      if (node.group !== 'routing') {
        edges.push({
          from: node.id,
          to: `route:${inferredIntent}`,
          weight: Math.min(node.weight, confidence),
          reason: 'signal contributes to contextual route',
        })
      }
    }
  }

  return {
    nodes,
    edges,
    supernodes,
    inferredIntent,
    confidence,
    needsClarification: !inferredIntent && isAmbiguousPrompt(prompt) && !historyIntent,
    usedHistory: !!inferredIntent && (isFollowup || !!historyIntent),
    rationale,
  }
}

const LIGHTWEIGHT_CHAT_RE =
  /^(hola|hello|hi|hey|buenas|buenos dias|buenos días|buenas tardes|buenas noches|que tal|qué tal|como estas|cómo estás|gracias|ok|okay|vale|si|sí|no)[\s.!?¿¡]*$/i

export function isLightweightConversationalPrompt(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return true
  if (LIGHTWEIGHT_CHAT_RE.test(normalized)) return true

  const words = normalized.split(/\s+/).filter(Boolean)
  if (words.length <= 4 && !/[?¿]/.test(normalized)) {
    const hasWorkIntent = [
      ROUTING_PATTERNS.externalResearch,
      ROUTING_PATTERNS.urlReference,
      ROUTING_PATTERNS.realtimeLookup,
      ROUTING_PATTERNS.deliverableFile,
      ROUTING_PATTERNS.dataWork,
      ROUTING_PATTERNS.codeWork,
      ROUTING_PATTERNS.implementationWork,
      ROUTING_PATTERNS.repoOperation,
      ROUTING_PATTERNS.doc,
      ROUTING_PATTERNS.viz,
      ROUTING_PATTERNS.math,
      ROUTING_PATTERNS.artifact,
      ROUTING_PATTERNS.webdev,
      ROUTING_PATTERNS.musicGeneration,
      ROUTING_PATTERNS.voiceGeneration,
    ].some((pattern) => pattern.test(normalized))
    return !hasWorkIntent
  }

  return false
}

export function shouldRouteTextPromptThroughAgenticRuntime(prompt: string, files: any[] = []): boolean {
  const normalized = normalizePrompt(prompt)
  if (GOAL_COMMAND_RE.test(prompt)) return true
  if (files.length > 0) {
    const fileList = Array.isArray(files) ? files : []
    // Image-only analysis turns ("resolver", "¿qué dice?", "transcribe",
    // "resuelve esta derivada") need VISION, which lives ONLY in the plain
    // /api/ai/generate path (base64 image → vision model, with auto-routing to
    // a vision-capable model when the selected one is text-only). The queued
    // agent-task / react-agent loop has no vision: it never receives the image,
    // so the model spins blind until the 90s stale guard fires ("Sin
    // actualizaciones recientes"). Route pure image-analysis turns to the
    // vision path; keep the agentic loop only when the user explicitly asks to
    // CREATE a deliverable (image/video/diagram/doc/code) from the image.
    // An image-only turn can NEVER be served by the queued agent / react-agent
    // loop — that loop has no vision, so it receives no image and stalls blind
    // until the 90s stale guard. ALWAYS send image-only turns to the plain
    // /api/ai/generate vision path, which reads the image (auto-routing to a
    // vision-capable model when the selected one is text-only) and can analyse,
    // transcribe, solve, or describe-to-create from it.
    const everyFileIsImage = fileList.length > 0 && fileList.every(isImageLikeAttachment)
    if (everyFileIsImage) return false
    // Document EDIT requests ("borra el jurado evaluador", "elimina los anexos",
    // "agrega una conclusión", "cambia el título del informe") must run through
    // /api/agent/task. The backend source-preserving editor can load the actual
    // uploaded Office/PDF bytes, create a same-format artifact, emit a
    // downloadable file card, and run deterministic validation against the
    // generated DOCX/XLSX/PPTX/PDF. A STRONG mutation verb
    // (borra/elimina/agrega/edita/reemplaza…) is an edit of the attached file
    // REGARDLESS of any format mention — "borra el jurado evaluador y dámelo en
    // word" is still an edit, not a fresh generation.
    if (
      DOCUMENT_MUTATION_STRONG_RE.test(normalized)
      || (
        !OUTPUT_FORMAT_REQUEST_RE.test(normalized)
        && (EXISTING_DOCUMENT_EDIT_RE.test(normalized) || WHOLE_DOCUMENT_TRANSFORM_RE.test(normalized))
      )
    ) {
      return true
    }
    const hasDocumentForSynthesis = fileList.some((file) =>
      isDocumentLikeAttachment(file) && !isSpreadsheetLikeAttachment(file)
    )
    if (
      hasDocumentForSynthesis
      && DOCUMENT_UNDERSTANDING_RE.test(normalized)
      && !OUTPUT_FORMAT_REQUEST_RE.test(normalized)
    ) {
      // Uploaded-document Q&A must run through the durable agent, not
      // simple chat. The agent is what can retrieve private context,
      // preserve the task id, recover from stream cuts, and finalize with
      // evidence instead of guessing from the model's memory.
      return true
    }
    return true
  }
  if (isLightweightConversationalPrompt(normalized)) return false

  // No-file interactive prompts (research, deliverables, code, data work,
  // long questions, etc.) run through the RELIABLE inline /generate agentic
  // loop — which already owns web_search/read_url + artifact tools, a
  // per-step timeout and a plain-stream fallback, and streams its reasoning
  // live. The durable QUEUED agent-task path is reserved for /goal (handled
  // at the top) and uploaded-document tasks (the files branch above): for
  // plain text prompts it could leave the chat stuck on
  // "stream_closed_without_done / 0 pasos" when the worker doesn't relay
  // events. Routing them inline is what makes the chat respond reliably.
  return false
}

export function shouldUseFastTextRoute(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return true
  if (GOAL_COMMAND_RE.test(prompt)) return false
  if (isLightweightConversationalPrompt(normalized)) return true
  if (
    NON_CREATION_MEDIA_ADVICE_RE.test(normalized)
    && !ROUTING_PATTERNS.video.test(normalized)
    && !ROUTING_PATTERNS.musicGeneration.test(normalized)
    && !ROUTING_PATTERNS.voiceGeneration.test(normalized)
  ) {
    return true
  }

  const hasExplicitWorkIntent = [
    ROUTING_PATTERNS.gmail,
    ROUTING_PATTERNS.googleServices,
    ROUTING_PATTERNS.urlReference,
    ROUTING_PATTERNS.realtimeLookup,
    ROUTING_PATTERNS.externalResearch,
    ROUTING_PATTERNS.deliverableFile,
    ROUTING_PATTERNS.dataWork,
    ROUTING_PATTERNS.codeWork,
    ROUTING_PATTERNS.implementationWork,
    ROUTING_PATTERNS.repoOperation,
    ROUTING_PATTERNS.longRunningAgent,
    ROUTING_PATTERNS.architecturePlan,
    ROUTING_PATTERNS.artifact,
    ROUTING_PATTERNS.math,
    ROUTING_PATTERNS.doc,
    ROUTING_PATTERNS.viz,
    ROUTING_PATTERNS.image,
    ROUTING_PATTERNS.video,
    ROUTING_PATTERNS.musicGeneration,
    ROUTING_PATTERNS.voiceGeneration,
    ROUTING_PATTERNS.webdev,
    ROUTING_PATTERNS.figma,
  ].some((pattern) => pattern.test(normalized))

  if (hasExplicitWorkIntent) return false

  const words = normalized.split(/\s+/).filter(Boolean)
  return words.length <= 60
}

// Lead verbs that signal the user is asking for *something*, but on
// their own (or with only filler tokens) they convey no concrete object,
// scope, or deliverable. These are the prompts where guessing produces
// garbage and asking 1 question is dramatically better than risking it.
const AMBIGUOUS_LEAD_VERB_RE =
  /^(ayud(?:a|ame)|hazme?|haz(?:lo|elo)?|crea(?:me|lo)?|necesito|quiero|dame|prepara(?:me)?|exporta(?:me)?|envia(?:me)?|genera(?:me)?|sigueme|continua)$/

const AMBIGUOUS_FILLER_TOKEN_RE =
  /^(con|de|por|para|en|a|al|del|la|el|los|las|un|una|uno|unos|unas|algo|alg[uú]n|alguna|esto|eso|aquello|ese|esa|este|esta|aquel|mi|tu|su|nuestro|favor|porfa|porfis|porfavor|ya|ahora|hoy|ayuda|cosas?|temas?)$/

/**
 * True when the prompt is a bare lead-verb / single-noun fragment with
 * no concrete object — the kind of input where the model, if it tries
 * to answer, will invent an unrelated deliverable. Routing these to the
 * `ambiguous` contract makes the model ask 1 short clarifying question.
 *
 * This is intentionally narrow:
 *   - greetings ("hola", "ok") → handled by isLightweightConversationalPrompt
 *   - questions ("¿qué es X?") → never flagged as ambiguous
 *   - prompts >4 words → never flagged
 *   - prompts with a concrete noun → never flagged
 *
 * Examples that DO trigger:
 *   "ayúdame", "necesito ayuda", "hazme algo", "tesis", "informe"
 *
 * Examples that do NOT trigger:
 *   "hola", "qué hora es", "dime sobre Python",
 *   "ayúdame con la tesis", "genera un informe en Word"
 */
export function isAmbiguousPrompt(prompt: string): boolean {
  const normalized = normalizePrompt(prompt)
  if (!normalized) return false
  if (LIGHTWEIGHT_CHAT_RE.test(normalized)) return false
  if (/[?¿]/.test(normalized)) return false

  const words = normalized.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false

  // Single bare token that is itself a lead verb — "ayúdame", "hazlo",
  // "necesito" — is the textbook ambiguous case.
  if (words.length === 1 && AMBIGUOUS_LEAD_VERB_RE.test(words[0])) return true

  // Single bare content noun ("tesis", "informe") with no verb / no
  // qualifier — flag only when the noun is in the work-deliverable
  // vocabulary, otherwise it might be conversational.
  if (words.length === 1 && ROUTING_PATTERNS.deliverableFile.test(words[0])) return true

  // Lead-verb opener with only filler tokens behind it.
  if (words.length <= 4 && AMBIGUOUS_LEAD_VERB_RE.test(words[0])) {
    const rest = words.slice(1)
    if (rest.length === 0) return true
    if (rest.every(w => AMBIGUOUS_FILLER_TOKEN_RE.test(w))) return true
  }

  return false
}

export function classifyIntentFastPath(prompt: string): ChatIntent | null {
  const lc = normalizePrompt(prompt)

  if (GOAL_COMMAND_RE.test(prompt)) return 'agent_task'

  // Ambiguous comes first — under-specified prompts route to the
  // clarifying-question contract rather than being guessed at as 'text'.
  // Greetings ("hola") are filtered inside isAmbiguousPrompt and fall
  // through to the lightweight chat path below.
  if (isAmbiguousPrompt(prompt)) return 'ambiguous'

  if (isLightweightConversationalPrompt(lc)) return 'text'

  if (ROUTING_PATTERNS.gmail.test(lc)) return 'gmail'
  if (ROUTING_PATTERNS.googleServices.test(lc)) return 'google_services'

  const asksForExternalResearch = ROUTING_PATTERNS.externalResearch.test(lc)
  const asksForUrlReference = ROUTING_PATTERNS.urlReference.test(lc)
  const asksForRealtimeLookup = ROUTING_PATTERNS.realtimeLookup.test(lc)
  const asksForDeliverableFile = ROUTING_PATTERNS.deliverableFile.test(lc)
  const asksForDataWork = ROUTING_PATTERNS.dataWork.test(lc)
  const asksForCodeWork = ROUTING_PATTERNS.codeWork.test(lc)
  const asksForImplementationWork = ROUTING_PATTERNS.implementationWork.test(lc)
  const asksForRepoOperation = ROUTING_PATTERNS.repoOperation.test(lc)
  const asksForLongRunningAgent = ROUTING_PATTERNS.longRunningAgent.test(lc)

  if (
    asksForRepoOperation
    || (asksForUrlReference && asksForImplementationWork && asksForCodeWork)
    || (asksForDeliverableFile && (asksForExternalResearch || asksForDataWork || asksForCodeWork))
    || (asksForLongRunningAgent && (asksForExternalResearch || asksForDeliverableFile || asksForDataWork || asksForCodeWork))
  ) {
    return 'agent_task'
  }

  if (asksForExternalResearch || asksForRealtimeLookup || asksForUrlReference) return 'web_search'
  if (ROUTING_PATTERNS.architecturePlan.test(lc)) return 'plan'
  if (ROUTING_PATTERNS.artifact.test(lc)) return 'artifact'
  if (ROUTING_PATTERNS.math.test(lc)) return 'math'
  if (ROUTING_PATTERNS.doc.test(lc)) return 'doc'
  if (ROUTING_PATTERNS.viz.test(lc)) return 'viz'
  if (ROUTING_PATTERNS.video.test(lc)) return 'video'
  if (ROUTING_PATTERNS.musicGeneration.test(lc) || ROUTING_PATTERNS.voiceGeneration.test(lc)) return 'agent_task'
  // Image ANALYSIS questions ("describe esta imagen") are vision chat, not
  // generation — same gate as signalIntentFromText.
  if (ROUTING_PATTERNS.image.test(lc) && !IMAGE_ANALYSIS_PROMPT_RE.test(lc)) return 'image'
  if (ROUTING_PATTERNS.figma.test(lc)) return 'figma'
  if (ROUTING_PATTERNS.webdev.test(lc) && ROUTING_PATTERNS.webdevBuildAction.test(lc)) return 'webdev'

  return null
}

// Enhanced AI Service
export class AIService {
  async analyzeIntent(prompt: string): Promise<ChatIntent> {
    return classifyIntentFastPath(prompt) || 'text'
  }

  private async classifyIntentViaSemanticRouter(
    prompt: string,
    conversationHistory: any[] = [],
    signal?: AbortSignal
  ): Promise<ChatIntent | null> {
    if (typeof window === 'undefined') return null
    if (!prompt?.trim()) return 'text'

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort('semantic-router-timeout'), 1200)
    const forwardAbort = () => controller.abort(signal?.reason || 'caller-aborted')
    signal?.addEventListener('abort', forwardAbort, { once: true })

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/ai/intent/semantic`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            conversationHistory: Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [],
          }),
          signal: controller.signal,
        }
      )

      if (!response.ok) return null
      const data = await response.json() as SemanticIntentResponse
      if (
        data?.ok
        && data.intent
        && VALID_CHAT_INTENTS.includes(data.intent)
        && typeof data.confidence === 'number'
        && data.confidence >= 0.55
      ) {
        const requiredExtension = String(data.contract?.required_extension || '').toLowerCase()
        const outputFormat = String(data.semanticProfile?.output_format || data.finalOutput || '').toLowerCase()
        const requiredTools = Array.isArray(data.contract?.required_tools) ? data.contract.required_tools : []
        const isDownloadableDocument =
          /\.(docx|xlsx|pptx|pdf|csv|svg|html|md)$/.test(requiredExtension)
          || /\b(docx|xlsx|pptx|pdf|csv|svg|html|markdown|md)_?(file|document)?\b/.test(outputFormat)
          || (requiredTools.includes('create_document') && /\.(docx|xlsx|pptx|pdf|csv|svg|html|md)$/.test(requiredExtension))
        if (isDownloadableDocument) return 'doc'
        return normalizeRoutingIntent(data.intent)
      }
      return null
    } catch (error: any) {
      if (signal?.aborted) throw error
      return null
    } finally {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  async classifyIntent(
    prompt: string,
    conversationHistory: any[] = [],
    signal?: AbortSignal
  ): Promise<ChatIntent> {

    if (shouldEditExistingDocument(prompt, conversationHistory)) {
      return 'agent_task';
    }

    if (shouldAnswerFromExistingDocument(prompt, conversationHistory)) {
      return 'agent_task';
    }

    const attributionGraph = buildIntentAttributionGraph(prompt, conversationHistory)
    if (attributionGraph.inferredIntent && attributionGraph.confidence >= 0.65) {
      return normalizeRoutingIntent(attributionGraph.inferredIntent);
    }

    const deterministicIntent = classifyIntentFastPath(prompt);
    if (deterministicIntent) return normalizeRoutingIntent(deterministicIntent);

    if (shouldUseFastTextRoute(prompt)) {
      return 'text';
    }

    const semanticIntent = await this.classifyIntentViaSemanticRouter(prompt, conversationHistory, signal);
    if (semanticIntent) {
      if (semanticIntent === 'doc' && shouldAnswerFromExistingDocument(prompt, conversationHistory)) {
        return 'agent_task';
      }
      return normalizeRoutingIntent(semanticIntent);
    }

    try {

      const messages = [
        {
          role: "system",
          content: `You are an expert at classifying user intent. Analyze the user's prompt (which could be in any language including Roman Urdu, Urdu, English, German, Spanish, etc.) and classify it into exactly one of these categories: 'gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'figma', 'plan', 'math', 'viz', 'doc', 'artifact', 'chart', 'webdev', 'agent_task', 'ambiguous', or 'text'.

- 'ambiguous': The prompt is too under-specified to act on — a bare lead verb ("ayúdame", "necesito"), a single noun without context ("tesis", "informe"), or any request where the deliverable, scope, or data source is missing. Prefer 'ambiguous' over guessing a deliverable type. Do NOT use 'ambiguous' for greetings (those are 'text') or for vague-but-answerable questions ("explícame algo" → 'text').

- 'gmail': Sending, reading, or managing emails. Examples: "send an email to hamza", "read my last 5 emails", "enviar un correo electrónico".
- 'google_services': Interacting with Google Calendar or Drive. Examples: "show my meetings for tomorrow", "find my marketing presentation on Drive", "mostrar mis eventos del calendario".
- 'web_search': Any request that needs REAL external sources — academic papers, news, facts that could be out of the LLM's training cutoff, or anything where the user explicitly asks for references/citations. Triggers the multi-provider agentic pipeline (Web of Science, Scopus, OpenAlex, SciELO, Semantic Scholar, Crossref, PubMed, DOAJ). Examples:
  * "busca 10 artículos sobre embarazo adolescente" / "dame 20 fuentes sobre alfa de Cronbach"
  * "find papers on gene editing crispr 2024" / "give me sources for systematic review on SMED"
  * "¿quién es el presidente de Francia?" / "who is the president of France?"
  * "what's the latest news on OpenAI?" / "últimas noticias de la NASA"
  * "investiga sobre X" / "investigate X" / "research X"
  * Any question where the user wants citations, a literature scan, or an answer grounded in real web/scholarly sources. If in doubt AND the request asks for information the LLM cannot safely answer from memory, prefer 'web_search' over 'text'.
- 'image': GENERATING a new image. Examples: "create an image of a sunset", "genera una imagen de un gato". NOT for questions ABOUT an attached or previous image — "describe esta imagen", "¿qué ves en la foto?", "transcribe la captura", "what does this image say" are 'text' (vision analysis), never 'image'.
- 'video': Generating videos. Examples: "make a video of a beach", "crea un video de la ciudad".
- 'ppt': Creating PowerPoint presentations. Examples in multiple languages:
* English: "create a presentation about AI", "make a PPT on climate change", "generate slides about marketing"
* Roman Urdu: "AI ke bare mein presentation banao", "PPT banao machine learning par", "climate change par slides bana do"
* Urdu: "مصنوعی ذہانت کے بارے میں پریزنٹیشن بنائیں", "پی پی ٹی بناؤ", "سلائیڈز تیار کرو"
* German: "erstelle eine Präsentation über KI", "mach eine PPT zum Klimawandel"
* Spanish: "crea una presentación sobre IA", "haz un PPT sobre el clima"
* French: "crée une présentation sur l'IA", "génère des slides"
- 'chart': Creating charts or graphs. Examples: "create a bar chart", "make a pie graph".
- 'figma': Creating flowcharts, process diagrams,sequence diagrams, class diagrams, state diagrams, ER diagrams, user journey diagrams, git graphs, or design diagrams. Examples: "create a flowchart of login flow", "make a process diagram", "design a workflow".
- 'plan': Creating architectural FLOOR PLANS / blueprints of buildings, houses, apartments, rooms. The output is a CAD/DXF drawing with walls, doors, windows, dimensions. Examples in multiple languages: "crea el plano de una casa", "dibújame un plano arquitectónico", "blueprint for a 3 bedroom house", "planta de un departamento 80 m2", "floor plan of an office", "plano de una vivienda con 2 baños". Do NOT classify generic "house" conversation as 'plan' — only when the user is explicitly asking for a drawing / plano / blueprint / floor plan / planta arquitectónica.
- 'artifact': Building an INTERACTIVE React component that runs live inside the chat (calculator, simulator, quiz, dashboard with inputs, editor with real-time validation, interactive map). The user expects to TYPE / CLICK / DRAG something and see the UI respond. Examples: "calculadora de Cronbach's alpha donde pegue los valores", "simulador SMED con inputs", "quiz con 10 preguntas sobre X", "dashboard de tesis con filtros", "editor de citas APA 7 en tiempo real", "visualizador S-curve EVM que recalcule al cambiar inputs". Only route here when the output is clearly a LIVE, stateful UI — not a static chart (that is 'viz') and not a downloadable document (that is 'doc').
- 'doc': Generating a downloadable document — Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF, or SVG. Examples: "dame un informe en Word con...", "genera un Excel con estas columnas", "crea una presentación PowerPoint de defensa de tesis", "exporta a PDF el contrato", "genera un archivo SVG del logo". Only route here when the user clearly wants a FILE they can download (keywords: word, excel, pptx, docx, pdf, hoja de cálculo, presentación, informe, exportar).
- 'viz': Building a chart, plot, or technical diagram. Covers S-curve Earned Value charts, Pareto diagrams, Ishikawa fishbone diagrams, histograms, scatter + regression, box plots, interactive dashboards, heatmaps, sankey, treemaps, flowcharts, ER diagrams, UML class/sequence/state diagrams, Gantt charts, user-journey diagrams. Examples: "dibuja un diagrama de Pareto con estos datos", "plot a histogram of weights", "interactive scatter with hover", "flowchart del proceso de onboarding", "diagrama ER de un e-commerce", "Gantt de 5 fases del proyecto", "S-curve de Earned Value". If the user wants to SEE data rendered as a picture / plot / diagram → 'viz'. If they want to COMPUTE a statistic → 'math'.
- 'math': Solving a mathematics, statistics, or quantitative-science problem that benefits from LaTeX formulas and (optionally) numerical Python execution. Examples: "resuelve la integral de x^2·sin(x) dx por partes", "calcula el Cronbach's alpha de [...]", "autovalores de la matriz [[2,1],[1,3]]", "probabilidad binomial n=10 p=0.3 k=4", "derivada parcial de x^2·y respecto a y", "solve the system 2x + 3y = 12, x - y = 1", "factoriza x^3 - 6x^2 + 11x - 6", "limite cuando x->0 de sin(x)/x". Generic "what is 2+2" stays 'text'. Only route to 'math' when the problem has symbolic or numerical content worth showing with LaTeX or running Python on.
- 'webdev': Building websites or UI components. Examples: "build a login page", "create a React component".
- 'agent_task': Multi-step compound tasks that require BOTH research AND building a deliverable file (Excel/Word/PPT/PDF) AND running code. The task agent will plan, search the web, write Python, generate the document, and self-verify before delivering. Use this when the user asks for things like:
  * "busca 30 artículos sobre X y mételos en un Excel" / "find 30 papers on X and put them in an Excel"
  * "investiga sobre Y y dame un informe Word con citas APA" / "research Y and give me a Word report with APA citations"
  * "crea un PPT con los datos del CSV adjunto" / "build a PPT from the attached CSV"
  * "calcula la regresión lineal de estos datos y entrega un PDF con la gráfica"
  * Anything that combines: search → process → produce file. Single-deliverable requests like "just create an empty Word doc" stay in 'doc'; pure data analysis without a deliverable file stays in 'math' or 'viz'.
- 'text': For all other general conversation, questions, and text generation.
  This includes structured text outputs such as tables, dummy data, formatted lists, or code-generated textual data.
  If the user asks to create a "table", "list", "dataset", or "dummy data" without explicitly mentioning charts, slides, or presentations, classify as 'text'.

IMPORTANT:
- Classify by the action the user expects, not only by keywords.
- Only classify as 'webdev' when the user wants a website, landing page, web app, or UI built. Code debugging, code review, or explanations stay 'text' unless the user asks for autonomous repair plus deliverables, which is 'agent_task'.
- If the user asks for a specific programming language (Python, JavaScript, HTML), inspect whether they want a UI. If not, classify as 'text'.
- If the user asks for a downloadable Word/Excel/PDF/PPTX, classify as 'doc' unless the request also needs external research, data processing, or long-running self-verification, which is 'agent_task'.
- If the user asks for a live calculator, simulator, quiz, dashboard with inputs, editor, 3D viewer, or persistent in-chat tool, classify as 'artifact'.
- If a request explicitly needs real citations, current facts, market data, scientific papers, or source verification, prefer 'web_search' over 'text'.

Examples:
- "Design a dark mode developer portfolio" → 'webdev' (web development)
 
- "Build a landing page" → 'webdev' (web development)
- "Make me a website for my business" → 'webdev' (web development)
- "Create HTML/CSS for a login form" → 'webdev' (web development)
- "encuentra mi presentación de marketing del último trimestre en Drive" → 'google_services'
- "Generate an image of a cat" → 'image' (visual content)
- "Create a logo design" → 'image' (visual design)
- "Make a video of sunset" → 'video' (video content)
- "Explain how React works" → 'text' (explanation)
- "What is JavaScript?" → 'text' (question)
- "Create a Word document with APA 7 structure" → 'doc'
- "Research 30 papers and put them in Excel" → 'agent_task'
Respond with only one word.

`,
        }
      ];

      if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
        const recentMessages = conversationHistory.slice(-2);
        for (const msg of recentMessages) {
          const role = msg.role === "USER" ? "user" : "assistant";
          const textPart = Array.isArray(msg.content)
            ? msg.content.find((c: any) => c.type === "text")?.text || ""
            : msg.content;
          messages.push({ role, content: textPart });
        }
      }

      // ✅ Finally add the new user prompt
      messages.push({ role: "user", content: prompt });

      // const response = await fetch("https://api.openai.com/v1/chat/completions", {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/proxy/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages,
          }),
          // Allow caller to abort the request (used by Stop button)
          signal,
        }
      );

      if (!response.ok) throw new Error(`API error: ${response.statusText}`);
      const data = await response.json();
      const intent = data.choices[0].message.content.toLowerCase().trim();
      devLog('intent FROM OPEN AI', intent);

      if (VALID_CHAT_INTENTS.includes(intent as ChatIntent)) {
        return normalizeRoutingIntent(intent as ChatIntent);
      }
      return 'agent_task'; // Default durable runtime fallback
    } catch (error: any) {
      // If this was explicitly aborted (e.g. user pressed Stop), don't try to
      // recover or return any fallback intent. Let caller decide what to do.
      if (error?.name === 'AbortError') {
        throw error;
      }

      console.error("Intent classification failed:", error);
      const fallbackIntent = await this.analyzeIntent(prompt);
      return fallbackIntent || 'agent_task';
    }
  }
}

export const aiService = new AIService()
