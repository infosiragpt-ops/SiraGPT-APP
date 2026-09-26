import { authenticatedFetch } from "./authenticated-fetch"
import { getNormalizedApiBaseUrl } from "./api-base-url"
import { getAttachmentLocalFile } from "./document-viewer-attachment"
import { streamSseJson } from "./sse-client"
import { composerBlocksTools, readComposerPermission, type ComposerPermissionId } from "./chat/composer-session"
import type { AgentTaskState } from "./agent-task-service"

const ID = /^[A-Za-z0-9_-]{1,200}$/
const ARTIFACT_ID = /^[a-f0-9]{6,40}$/i
const KEY = /^[A-Za-z0-9_.:-]{1,200}$/
const SHA = /^[a-f0-9]{64}$/
const STATUSES = ["queued", "inspecting", "planning", "editing", "validating", "done", "failed", "cancelled"] as const
type Status = typeof STATUSES[number]
type Tier = "mechanical" | "academic"
type Json = Record<string, unknown>
export interface DocumentJobPointer { version: 1; idempotencyKey: string }
export interface DocumentArtifact { id: string; kind: string; name: string; mime: string; size: number; sha256: string }
export interface DocumentJobSnapshot {
  id: string; status: Status; eventSeq: number; admissionReady: boolean; errorCode: string | null
  artifacts: DocumentArtifact[]; outcome?: "edited" | "unchanged" | "not_possible"
  costUsd?: string | null; costStatus?: "pending" | "estimated" | "exact"
}
export interface DocumentCapabilities {
  enabled: boolean; ready: boolean; supported: boolean; modelTier: Tier | null
  modes: string[]; formats: string[]; limits: { maxFiles: number; maxFileBytes: number }
}
export interface DocumentAttachment { name: string; id: string; localFile: File | null }

const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export class DocumentSandboxClientError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly admissionRejected = false) {
    super(documentSandboxErrorMessage(code))
    this.name = "DocumentSandboxClientError"
  }
}
export function documentSandboxErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    E_NOT_READY: "La edición verificada no está disponible. No se modificó el documento ni se usó otro editor.",
    E_MODEL: "El modelo seleccionado no admite esta edición verificada. Elige un modelo compatible en el selector; no lo cambiaremos por ti.",
    E_PLAN_GATE: "Los permisos actuales no permiten editar documentos. Cambia el permiso desde el control existente si deseas autorizar la edición.",
    E_FORMAT: "Este formato o conjunto de archivos todavía no admite edición verificada. No se convirtió ni reconstruyó el original.",
    E_PARAMS: "No se pudo aceptar el documento o la instrucción. Comprueba el formato y el tamaño y vuelve a adjuntarlo.",
    E_FORBIDDEN: "No tienes acceso a este trabajo. Comprueba que has iniciado sesión con la cuenta propietaria.",
    E_AUTH: "Tu sesión expiró. Inicia sesión de nuevo para continuar.",
    E_QUOTA: "Se alcanzó el límite disponible. Espera o revisa tu plan antes de volver a intentar.",
    E_CANCELLED: "Edición cancelada. No se entregó una modificación posterior a la cancelación.",
    E_NOT_FOUND: "El trabajo no está disponible o ya fue eliminado. No se inició otro trabajo automáticamente.",
    E_ADMISSION_UNKNOWN: "No se pudo confirmar la recepción del trabajo. Abre de nuevo esta conversación para recuperar su estado; no se inició otra copia.",
    E_ADMISSION_NOT_FOUND: "No se pudo confirmar la admisión del trabajo. Vuelve a adjuntar el original si deseas reintentar; no se inició otra copia automáticamente.",
    E_CONNECTION: "Se perdió la conexión con el trabajo. No se canceló ni se inició otra copia; abre de nuevo esta conversación para recuperar su estado.",
    E_EDIT_AMBIGUOUS: "Indica el cambio exacto que quieres aplicar al archivo adjunto. No se iniciará una edición mientras la instrucción sea ambigua.",
    E_VALIDATION: "No se pudo verificar el documento. No se entregará un archivo sin validar.",
    E_CONFLICT: "El trabajo cambió mientras se procesaba. Abre de nuevo esta conversación para consultar su estado.",
    E_PROVIDER: "El motor elegido no pudo completar la edición. No se utilizó otro proveedor.",
    E_TIMEOUT: "La edición alcanzó su límite de tiempo. Consulta el estado del trabajo antes de volver a intentarlo.",
  }
  return messages[code] || "La edición no pudo completarse. El original se conserva y no se entregó una salida sin validar."
}

export function documentAttachment(value: unknown): DocumentAttachment | null {
  const source = record(value)
  const localFile = getAttachmentLocalFile(value)
  const name = [source.originalName, source.name, source.filename, localFile?.name].find((item) => typeof item === "string" && item.trim())
  const id = [source.fileId, source.id].find((item) => typeof item === "string" && ID.test(item))
  if (typeof name !== "string" || !/\.(?:docx?|xlsx?|xlsm|pptx?|pdf|txt|md|csv|json|html)$/i.test(name)) return null
  return { name, id: typeof id === "string" ? id : "", localFile }
}

/** Explicit identities only; the server checks ownership. URLs and lineage are not edit targets. */
export function documentEditReference(value: unknown): string | null {
  const source = record(value)
  if (typeof source.artifactId === "string" && source.artifactId.trim()) {
    const artifactId = source.artifactId.trim()
    return ARTIFACT_ID.test(artifactId) ? `artifact:${artifactId.toLowerCase()}` : null
  }
  const candidate = typeof value === "string" ? value : [source.fileId, source.id, source.attachmentId]
    .find((item) => typeof item === "string" && item.trim())
  if (typeof candidate !== "string") return null
  const reference = candidate.trim()
  if (reference.startsWith("artifact:")) {
    const artifactId = reference.slice("artifact:".length)
    return ARTIFACT_ID.test(artifactId) ? `artifact:${artifactId.toLowerCase()}` : null
  }
  return ID.test(reference) ? reference : null
}

export function collectDocumentEditReferences(attachments: readonly unknown[]): string[] {
  const references = attachments.map(documentEditReference)
  // An unresolved selected file must not silently become "latest in this chat".
  if (references.some((reference) => !reference)) throw new DocumentSandboxClientError("E_PARAMS")
  return [...new Set(references as string[])]
}

/** A queued edit keeps the selected identity even if the user closes or changes the preview. */
export function snapshotDocumentEditTargets(attachments: readonly unknown[]): Array<{ id: string; name: string; url?: string }> {
  return attachments.map((source) => {
    const id = documentEditReference(source)
    const attachment = documentAttachment(source)
    if (!id || !attachment) throw new DocumentSandboxClientError("E_PARAMS")
    return { id, name: attachment.name,
      ...(id.startsWith("artifact:") ? { url: `/api/agent/artifact/${id.slice("artifact:".length)}` } : {}) }
  })
}

/** Language-only explicit-edit detector. Attachments are resolved by the admission helper. */
export function looksLikeExplicitDocumentEdit(prompt: string): boolean {
  const text = prompt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()
  if (/^no (?:cambies|cambiar|modifiques) nada\b/.test(text)) return true
  if (clauseLooksLikeEdit(text)) return true
  // Real follow-ups name the file first and ask later ("en el mismo documento
  // ## CARTA…_editado_.docx\n\nDOCX quiero que agregues observaciones…").
  // Drop file names/markdown and evaluate each sentence on its own.
  const cleaned = text
    .replace(/\\_/g, "_")
    .replace(/#+\s*/g, " ")
    .replace(/\S+\.(?:docx?|xlsx?|xlsm|pptx?|pdf|odt|ods|odp|csv|rtf)\b/g, " ")
  if (cleaned
    .split(/[\n.;]+/)
    .map((clause) => clause.replace(/^\s*(?:(?:el|la|mi|este|esta)\s+)?(?:docx|word|excel|xlsx|pptx|powerpoint|pdf|documento|archivo)\b\s*[,:]?\s*/, "").trim())
    .some((clause) => clause.length > 0 && clause !== text && clauseLooksLikeEdit(clause))) return true
  return fuzzyLooksLikeDocumentEdit(prompt)
}

// Typo/caps/accents-tolerant fallback. Luis's real message «EN EL MISMO WORD
// QIERO QUE AGREGES COMENTARIOS EN OBSERVACIONES PORFVAOR» matched none of the
// exact verb forms above and fell to the plain chat, which echoed the
// document. Words are compared against verb STEMS with one-edit tolerance,
// and the sentence must name something that lives in a document.
const FUZZY_EDIT_STEMS = [
  "agreg", "anad", "anhad", "insert", "incorpor", "inclu", "met", "pon", "ponl", "coloc", "escrib", "redact", "complet",
  "llen", "rellen", "marc", "coment", "edit", "modif", "modific", "corrig", "correg", "cambi", "reempl", "sustitu",
  "actualiz", "quit", "borr", "elimin", "mejor", "arregl", "ajust", "renombr", "reescrib", "traduc", "parafrase", "numer",
]
const FUZZY_DOC_TARGET_RE = /\b(?:documento|archivo|word|docx|excel|xlsx|hoja|celda|fila|columna|tabla|powerpoint|pptx|presentacion|diapositiva|slide|pdf|titulo|subtitulo|parrafo|seccion|capitulo|pagina|portada|anexo|informe|tesis|introduccion|conclusion(?:es)?|bibliografia|referencias|indice|encabezado|pie de pagina|vinetas?|grafico|observacion(?:es)?|comentarios?|campos?|casillas?|firma|formulario|matriz|ficha|items?|preguntas?|respuestas?|filas|columnas|celdas|notas?|texto)\b/
const FUZZY_READ_ONLY_RE = /^\s*(?:explica|explicame|describe|resume|resumeme|analiza|revisa|que|como|por que|dime|cual|cuales|cuanto|traduceme lo que|no (?:edites|modifiques|reescribas|cambies))\b/

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

// One-edit tolerance only against stems of 5+ letters: shorter stems make
// ordinary words look like verbs ("comercial" ~ "comen").
function fuzzyEditVerb(word: string): boolean {
  if (word.length < 3) return false
  for (const stem of FUZZY_EDIT_STEMS) {
    if (word.startsWith(stem)) return true
    // "agreges" ~ "agreg" + suffix with a typo; compare the stem-length prefix.
    if (word.length >= 6 && stem.length >= 5 && editDistanceAtMostOne(word.slice(0, stem.length), stem)) return true
  }
  return false
}

// "genera un documento nuevo de propuesta" creates, it does not edit.
const FUZZY_NEW_DOC_RE = /\b(?:gener\w*|cre\w*|elabor\w*|produc\w*|haz(?:me)?|hacer|arma\w*|dise[nñ]\w*)\b[^.;\n]{0,60}\b(?:nuev[oa]s?|desde cero|otro|otra)\b|\b(?:nuev[oa]s?)\s+(?:documento|archivo|informe|word|excel|ppt|pptx|presentacion|reporte)\b/

export function fuzzyLooksLikeDocumentEdit(prompt: string): boolean {
  const raw = prompt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  // «¿Puedes editar este Word?» asks about capability; quoted text is document
  // content, never an instruction.
  if (/^\s*[¿]?\s*(?:puedes|podrias|podras|me puedes|me podrias|sabes|se puede|es posible)\b[^?]*\?\s*$/.test(raw)) return false
  const text = raw
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|«[^»\n]*»/g, " ")
    .replace(/\\_/g, "_").replace(/#+\s*/g, " ")
    .replace(/\S+\.(?:docx?|xlsx?|xlsm|pptx?|pdf|odt|ods|odp|csv|rtf)\b/g, " ")
    .replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim()
  if (!text || FUZZY_READ_ONLY_RE.test(text)) return false
  if (FUZZY_NEW_DOC_RE.test(text)) return false
  if (/\b(?:dice|decia|menciona|indica|senala)\b/.test(text) && !/\b(?:cambi\w*|edit\w*|modific\w*|agreg\w*|pon\w*|escrib\w*)\b[^,;.]{0,40}$/.test(text) && text.split(" ").filter(fuzzyEditVerb).length <= 1) return false
  if (!FUZZY_DOC_TARGET_RE.test(text)) return false
  return text.split(" ").some(fuzzyEditVerb)
}

function clauseLooksLikeEdit(text: string): boolean {
  let command = text.replace(/^[¿¡]\s*/, "").replace(/[?!]+$/, "").trim()
  if (/^(?:explica\b|describe\b|resume\b|analiza\b|revisa\b|que\b|como\b|por que\b|dime\b|no (?:edites|modifiques|reescribas)\b)/.test(command)) return false
  const polite = /^(?:puedes|podrias|podras|me puedes|me podrias)\s+/.test(command)
  command = command.replace(/^(?:(?:por favor|ahora|quiero que|necesito que|te pido que|deseo que|quiero|necesito|puedes|podrias|podras|me puedes|me podrias)\s*[, :]?\s*)+/, "")
  // A location before the verb is still a direct instruction, not an inferred edit.
  command = command.replace(/^(?:en|sobre)\s+(?:el|la|los|las|mi|este|esta)\s+(?:mismo\s+)?(?:titulo|portada|documento|word|archivo|informe|tabla|celda|hoja|diapositiva|pdf)\b[^,;.!?\n]{0,100}?(?=\s+(?:cambi|edit|modific|corrig|correg|reempla|sustitu|mejor|actualiz|pon|coloc))\s*[, :]?\s*/, "")
  const action = /^(?:cambia(?:r|me|lo|la)?|cambies|edita(?:r|lo|la)?|edites|modifica(?:r|lo|la)?|modifiques|corrige(?:lo|la)?|corrijas|corregir|mejora(?:r|lo|la)?|mejores|reemplaza(?:r)?|reemplaces|sustituye|sustituyas|sustituir|renombra(?:r)?|renombres|borra(?:r)?|borres|elimina(?:r)?|elimines|quita(?:r)?|quites|agrega(?:r)?|agregues|anade|anadas|anadir|inserta(?:r)?|insertes|reescribe|reescribas|reescribir|actualiza(?:r)?|actualices|traduce|traduzcas|traducir|parafrasea(?:r)?|parafrasees|une|unas|unir|fusiona(?:r)?|fusiones|numera(?:r)?|numeres|rota(?:r)?|rotes|pon|poner|coloca(?:r)?|completa(?:r|lo|la|me)?|completes|llena(?:r|lo|la)?|llenes|rellena(?:r|lo|la)?|rellenes|marca(?:r|lo|la)?|marques|incorpora(?:r)?|incorpores|incluye|incluyas|replace|edit|modify|rewrite|rename|remove|merge|rotate|fill)\b/
  const match = command.match(action)
  if (!match) return false
  // "¿Puedes editar documentos?" asks about capability; a concrete requested
  // replacement/region is required when asking politely to edit.
  const target = command.slice(match[0].length).trim()
  if (/^(?:de tema|(?:el|mi|tu) (?:modelo|proveedor|permiso|plan|cuenta)|tu (?:respuesta|forma de responder))\b/.test(target)) return false
  if (polite && /^(?:(?:mi|mis|un|una|unos|unas|el|la|los|las|este|esta|estos|estas)\s+)?(?:documentos?|archivos?|word|pdf|docx|excel|pptx)(?:\s+adjunt[oa]s?)?$/.test(target)) return false
  return target.length > 0
}

/** Explicit requests, including polite Spanish forms. This never interprets quoted instructions as authority. */
export function isExplicitDocumentEdit(prompt: string, attachments: readonly unknown[]): boolean {
  if (!attachments.some(documentAttachment)) return false
  return looksLikeExplicitDocumentEdit(prompt)
}

export function parseDocumentJobPointer(metadata: unknown): DocumentJobPointer | null {
  let value = metadata
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { return null }
  }
  const pointer = record(record(value).docSandbox)
  return pointer.version === 1 && typeof pointer.idempotencyKey === "string" && KEY.test(pointer.idempotencyKey)
    ? { version: 1, idempotencyKey: pointer.idempotencyKey } : null
}

export function parseDocumentSnapshot(value: unknown): DocumentJobSnapshot {
  const data = record(value)
  if (typeof data.id !== "string" || !ID.test(data.id) || !STATUSES.includes(data.status as Status) || !integer(data.eventSeq)) {
    throw new DocumentSandboxClientError("E_CONNECTION")
  }
  const artifacts = (Array.isArray(data.artifacts) ? data.artifacts : []).map((value) => {
    const item = record(value)
    if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.kind !== "string" ||
      typeof item.name !== "string" || !item.name || /[\x00-\x1f\x7f/\\]/.test(item.name) ||
      typeof item.mime !== "string" || !integer(item.size) || typeof item.sha256 !== "string" || !SHA.test(item.sha256)) {
      throw new DocumentSandboxClientError("E_VALIDATION")
    }
    return item as unknown as DocumentArtifact
  })
  return { id: data.id, status: data.status as Status, eventSeq: data.eventSeq, admissionReady: data.admissionReady === true,
    errorCode: typeof data.errorCode === "string" ? data.errorCode : null, artifacts,
    ...(data.costUsd === null ? { costUsd: null, costStatus: "pending" as const }
      : typeof data.costUsd === "string" && /^\d+(?:\.\d{1,12})?$/.test(data.costUsd) && ["exact", "estimated"].includes(String(data.costStatus))
        ? { costUsd: data.costUsd, costStatus: data.costStatus as "exact" | "estimated" } : {}),
    ...(["edited", "unchanged", "not_possible"].includes(String(data.outcome)) ? { outcome: data.outcome as DocumentJobSnapshot["outcome"] } : {}) }
}

export function documentJobState(snapshot?: DocumentJobSnapshot, message?: string): AgentTaskState {
  const status = snapshot?.status || "queued"
  const done = ["done", "failed", "cancelled"].includes(status)
  const labels: Record<Status, string> = { queued: "Encolado", inspecting: "Inspeccionando documento", planning: "Planificando cambios",
    editing: "Editando el original", validating: "Validando el resultado", done: "Validación terminada", failed: "Edición no completada", cancelled: "Edición cancelada" }
  const outputs = snapshot?.artifacts.filter((item) => item.kind === "output") || []
  const hasReport = snapshot?.artifacts.some((item) => item.kind === "validation_report") === true
  const accepted = status === "done" && outputs.length > 0 && hasReport && snapshot?.admissionReady === true &&
    snapshot.errorCode === null && ["edited", "unchanged", "not_possible"].includes(snapshot.outcome || "")
  const error = status === "failed" ? documentSandboxErrorMessage(snapshot?.errorCode || "E_VALIDATION")
    : status === "cancelled" ? documentSandboxErrorMessage("E_CANCELLED")
      : status === "done" && !accepted ? documentSandboxErrorMessage("E_VALIDATION") : undefined
  const delivery = accepted ? snapshot!.artifacts.filter((item) => ["output", "agent_result", "validation_report", "text_diff"].includes(item.kind)) : []
  const cost = snapshot?.costStatus === "pending" ? "\n\nCosto pendiente de confirmación."
    : snapshot?.costUsd !== undefined && snapshot.costUsd !== null
      ? `\n\nCosto ${snapshot.costStatus === "exact" ? "registrado" : "estimado"}: US$${snapshot.costUsd}.` : ""
  return {
    steps: [{ id: "document-sandbox", label: message || labels[status], icon: "thought", status: error ? "error" : done ? "done" : "running", toolCalls: [] }],
    artifacts: delivery.map((item) => ({ id: item.id, filename: item.name, mime: item.mime, sizeBytes: item.size,
      downloadUrl: `/api/docs/jobs/${snapshot!.id}/artifacts/${item.id}?download=1`,
      ...(item.kind === "output" ? { validation: { passed: true } } : {}) })),
    approvals: [], checkpoints: [], qualityGates: [], repairs: [], done, error,
    ...(!done ? { lastEventAt: new Date().toISOString() } : {}),
    finalText: (accepted ? snapshot?.outcome === "not_possible"
      ? "No pude aplicar el cambio conservando el documento. Te devuelvo el original intacto, verificado, sin presentar esto como una edición."
      : snapshot?.outcome === "unchanged"
        ? "El documento se verificó sin modificar su contenido. Puedes descargar el mismo archivo."
        : "El documento pasó la validación independiente. Puedes descargar el archivo y consultar su reporte de cambios."
      : error || "") + cost,
  }
}

export function serializeDocumentJobState(state: AgentTaskState): string {
  return "```agent-task-state\n" + JSON.stringify(state) + "\n```" + (state.finalText ? "\n\n" + state.finalText : "")
}

interface ClientOptions {
  request?: typeof fetch; apiBase?: string; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number; reconnectMs?: number; recoveryMs?: number
  readPermission?: () => ComposerPermissionId
}
const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal?.reason || new DOMException("Aborted", "AbortError")) }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve() }, ms)
  signal?.addEventListener("abort", abort, { once: true })
})
export function createDocumentSandboxClient(options: ClientOptions = {}) {
  const request = options.request || authenticatedFetch
  const base = (options.apiBase || getNormalizedApiBaseUrl()).replace(/\/+$/, "")
  const root = `${base}/docs/jobs`
  const pause = options.sleep || wait
  const now = options.now || Date.now
  const recoveryMs = options.recoveryMs ?? 30_000
  const endpoint = (id: string) => {
    if (!ID.test(id)) throw new DocumentSandboxClientError("E_PARAMS")
    return `${root}/${encodeURIComponent(id)}`
  }
  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    const timeout = new AbortController()
    const propagate = () => timeout.abort(init.signal?.reason)
    if (init.signal?.aborted) propagate()
    else init.signal?.addEventListener("abort", propagate, { once: true })
    const timer = setTimeout(() => timeout.abort(), init.method === "POST" && init.body instanceof FormData ? 125_000 : 15_000)
    try {
      const response = await request(url, { ...init, signal: timeout.signal, credentials: "include", cache: "no-store" })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        const code = response.status === 401 ? "E_AUTH" : response.status === 403 ? record(data).code === "E_PLAN_GATE" ? "E_PLAN_GATE" : "E_FORBIDDEN"
          : response.status === 404 ? "E_NOT_FOUND" : typeof record(data).code === "string" ? record(data).code as string : "E_CONNECTION"
        throw new DocumentSandboxClientError(code, response.status)
      }
      return data
    } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", propagate) }
  }
  const snapshot = async (jobId: string, signal?: AbortSignal) => parseDocumentSnapshot(await json(endpoint(jobId), { signal }))
  const byKey = async (pointer: DocumentJobPointer, signal?: AbortSignal) => {
    if (!KEY.test(pointer.idempotencyKey)) throw new DocumentSandboxClientError("E_PARAMS")
    return parseDocumentSnapshot(await json(`${root}/by-key/${encodeURIComponent(pointer.idempotencyKey)}`, { signal }))
  }
  async function capabilities(model: string, signal?: AbortSignal): Promise<DocumentCapabilities> {
    const data = record(await json(`${root}/capabilities?model=${encodeURIComponent(model)}`, { signal }))
    const limits = record(data.limits)
    return { enabled: data.enabled === true, ready: data.ready === true, supported: data.supported === true,
      modelTier: data.modelTier === "mechanical" || data.modelTier === "academic" ? data.modelTier : null,
      modes: Array.isArray(data.modes) ? data.modes.filter((item): item is string => typeof item === "string") : [],
      formats: Array.isArray(data.formats) ? data.formats.filter((item): item is string => typeof item === "string") : [],
      limits: { maxFiles: integer(limits.maxFiles) ? Math.min(limits.maxFiles, 10) : 0,
        maxFileBytes: integer(limits.maxFileBytes) ? Math.min(limits.maxFileBytes, 50 * 1024 * 1024) : 0 } }
  }
  async function prepare(prompt: string, attachments: readonly unknown[], model: string, signal?: AbortSignal) {
    const permission = (options.readPermission || readComposerPermission)()
    if (composerBlocksTools(permission)) throw new DocumentSandboxClientError("E_PLAN_GATE")
    const caps = await capabilities(model, signal)
    if (!caps.enabled || !caps.ready) throw new DocumentSandboxClientError("E_NOT_READY")
    if (!model) throw new DocumentSandboxClientError("E_MODEL")
    // Any picker TEXT model must admit. The server maps an unknown catalog
    // identity to the mechanical engine path; do not refuse on modelTier.
    const modelTier = caps.modelTier === "academic" ? "academic" : "mechanical"
    const files = attachments.map(documentAttachment)
    if (!caps.modes.includes("preserve") || !files.length || files.length > caps.limits.maxFiles || files.some((file) => !file)) {
      throw new DocumentSandboxClientError("E_FORMAT")
    }
    if (files.some((file) => !caps.formats.includes(file!.name.split(".").pop()!.toLowerCase())) ||
      (files.length > 1 && files.some((file) => !/\.pdf$/i.test(file!.name)))) throw new DocumentSandboxClientError("E_FORMAT")
    const form = new FormData()
    form.set("instructions", prompt); form.set("mode", "preserve"); form.set("modelTier", modelTier); form.set("requestedModel", model)
    form.set("permission", permission)
    let total = 0
    for (const file of files) {
      signal?.throwIfAborted()
      // /files/:id/content is extracted text, NOT original bytes. A restored
      // queue without its File must be reattached rather than reconstructed.
      // Arbitrary attachment URLs are never fetched by this editing adapter.
      if (!(file!.localFile instanceof Blob)) throw new DocumentSandboxClientError("E_PARAMS")
      const bytes = file!.localFile
      total += bytes.size
      if (!bytes.size || bytes.size > caps.limits.maxFileBytes || total > 100 * 1024 * 1024) throw new DocumentSandboxClientError("E_PARAMS")
      form.append("files[]", bytes, file!.name)
    }
    return form
  }
  async function recover(pointer: DocumentJobPointer, signal?: AbortSignal, includePendingAdmission = false): Promise<DocumentJobSnapshot> {
    const started = now()
    let onlyNotFound = true
    do {
      signal?.throwIfAborted()
      try {
        const result = await byKey(pointer, signal)
        onlyNotFound = false
        if (includePendingAdmission || result.admissionReady || ["done", "failed", "cancelled"].includes(result.status)) return result
      } catch (error) {
        if (!(error instanceof DocumentSandboxClientError) || error.code !== "E_NOT_FOUND") onlyNotFound = false
        if (error instanceof DocumentSandboxClientError && !["E_NOT_FOUND", "E_CONNECTION", "E_NOT_READY"].includes(error.code)) throw error
      }
      if (now() - started >= recoveryMs) break
      await pause(Math.min(1000, recoveryMs), signal)
    } while (now() - started <= recoveryMs)
    throw new DocumentSandboxClientError(onlyNotFound ? "E_ADMISSION_NOT_FOUND" : "E_ADMISSION_UNKNOWN")
  }
  async function submit(form: FormData, pointer: DocumentJobPointer, signal?: AbortSignal): Promise<DocumentJobSnapshot> {
    if (!KEY.test(pointer.idempotencyKey)) throw new DocumentSandboxClientError("E_PARAMS")
    try {
      return parseDocumentSnapshot(await json(root, { method: "POST", body: form, signal, headers: { "Idempotency-Key": pointer.idempotencyKey } }))
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof DocumentSandboxClientError && error.httpStatus &&
        ((error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 409) ||
          (error.httpStatus === 503 && error.code === "E_NOT_READY"))) {
        throw new DocumentSandboxClientError(error.code, error.httpStatus, true)
      }
      // The POST may have committed. Lookup only; never issue a new paid job or new idempotency key.
      return recover(pointer, signal)
    }
  }
  async function observe(jobId: string, onSnapshot: (value: DocumentJobSnapshot) => void, signal?: AbortSignal): Promise<DocumentJobSnapshot> {
    let cursor = 0; let disconnectedSince: number | null = null; let lastHeartbeat = now()
    while (!signal?.aborted) {
      try {
        let value = await snapshot(jobId, signal)
        onSnapshot(value)
        if (["done", "failed", "cancelled"].includes(value.status)) return value
        cursor = Math.max(cursor, value.eventSeq)
        const connection = new AbortController()
        const abort = () => connection.abort(signal?.reason)
        signal?.addEventListener("abort", abort, { once: true })
        const timer = setTimeout(() => connection.abort(), 70_000)
        try {
          const response = await request(`${endpoint(jobId)}/events`, { signal: connection.signal, credentials: "include", cache: "no-store",
            headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) } })
          if (!response.ok || !response.body || !response.headers.get("Content-Type")?.includes("text/event-stream")) {
            await response.body?.cancel()
            throw new DocumentSandboxClientError(response.status === 401 ? "E_AUTH" : response.status === 403 ? "E_FORBIDDEN" : "E_CONNECTION")
          }
          disconnectedSince = null
          for await (const event of streamSseJson<unknown>(response.body, { signal: connection.signal,
            onMalformedMessage: () => { throw new DocumentSandboxClientError("E_CONNECTION") },
            onChunk: () => { if (now() - lastHeartbeat >= 10_000) { lastHeartbeat = now(); onSnapshot(value) } },
          })) {
            const data = record(event)
            if (integer(data.seq) && data.seq > cursor) cursor = data.seq
            // Progress is read from a durable snapshot, not from model-produced event text.
            if (record(data.payload).status || data.status) {
              const current = await snapshot(jobId, signal); value = current; onSnapshot(current)
              if (["done", "failed", "cancelled"].includes(current.status)) return current
            }
          }
        } finally { clearTimeout(timer); connection.abort(); signal?.removeEventListener("abort", abort) }
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof DocumentSandboxClientError && !["E_CONNECTION", "E_NOT_READY"].includes(error.code)) throw error
        disconnectedSince ??= now()
        if (now() - disconnectedSince >= recoveryMs) throw new DocumentSandboxClientError("E_CONNECTION")
      }
      await pause(options.reconnectMs ?? 1000, signal)
    }
    signal?.throwIfAborted()
    throw new DocumentSandboxClientError("E_CONNECTION")
  }
  async function cancel(pointer: DocumentJobPointer, signal?: AbortSignal): Promise<DocumentJobSnapshot> {
    // Cancellation must not wait for a known job's input upload to finish.
    const job = await recover(pointer, signal, true)
    if (["done", "failed", "cancelled"].includes(job.status)) return snapshot(job.id, signal)
    await json(`${endpoint(job.id)}/cancel`, { method: "POST", signal })
    return snapshot(job.id, signal)
  }
  return { capabilities, prepare, submit, recover, observe, cancel, snapshot, byKey }
}

export const documentSandboxClient = createDocumentSandboxClient()
