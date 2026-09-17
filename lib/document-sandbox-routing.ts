import { shouldEditExistingDocument } from "./ai-service"
import { parseMessageFiles } from "./chat/composer-files"
import { documentAttachment, looksLikeExplicitDocumentEdit, isExplicitDocumentEdit } from "./document-sandbox-client"

export type DocumentSandboxRoute = "edit" | "clarify" | null
export interface DocumentSandboxAdmission {
  route: DocumentSandboxRoute
  attachments: unknown[]
}
export interface DocumentSandboxAdmissionOptions {
  attachments?: readonly unknown[]
  historyAttachments?: readonly unknown[]
  previewAttachments?: readonly unknown[]
}

/** Never let an ambiguous legacy edit classification select an editor. */
export function routeDocumentSandboxTurn(prompt: string, attachments: readonly unknown[]): "edit" | "clarify" | null {
  if (!attachments.some(documentAttachment)) return null
  if (isExplicitDocumentEdit(prompt, attachments)) return "edit"
  return shouldEditExistingDocument(prompt, [...attachments]) ? "clarify" : null
}

const RECENT_HISTORY_MESSAGES = 8

// A follow-up without attachments edits the chat's document only when it names
// something that lives in a document ("cambia el título", "agrega una fila"),
// never a conversational tweak like "cambia el tono de tu respuesta".
const DOCUMENT_TARGET_RE = /\b(?:documento|archivo|word|docx|excel|xlsx|hoja|celda|fila|columna|tabla|powerpoint|pptx|presentacion|diapositiva|slide|pdf|titulo|subtitulo|parrafo|seccion|capitulo|pagina|portada|anexo|informe|tesis|introduccion|conclusion(?:es)?|bibliografia|referencias|indice|encabezado|pie de pagina|vinetas?|grafico)\b/

export function mentionsDocumentTarget(prompt: string): boolean {
  return DOCUMENT_TARGET_RE.test(prompt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
}

export function historyDocumentAttachments(messages: readonly unknown[]): unknown[] {
  const files: unknown[] = []
  for (const message of messages.slice(-RECENT_HISTORY_MESSAGES)) {
    if (!message || typeof message !== "object") continue
    files.push(...parseMessageFiles((message as { files?: unknown }).files))
  }
  return files
}

/**
 * Document editor admission. The server edits by file id (or, on a follow-up,
 * the latest document of the chat), so an explicit edit only needs a document
 * in the composer, the conversation or the open preview — never local bytes.
 */
export function resolveDocumentSandboxAdmission(
  prompt: string,
  options: DocumentSandboxAdmissionOptions = {},
): DocumentSandboxAdmission {
  const composer = [...(options.attachments || [])].filter((item) => documentAttachment(item))
  const context = [...(options.historyAttachments || []), ...(options.previewAttachments || [])]
    .filter((item) => documentAttachment(item))
  const explicit = looksLikeExplicitDocumentEdit(prompt)

  if (composer.length > 0) {
    if (explicit) return { route: "edit", attachments: composer }
    if (shouldEditExistingDocument(prompt, composer)) return { route: "clarify", attachments: composer }
    return { route: null, attachments: [] }
  }
  // Follow-up without attachments: the server resolves the latest version.
  if (explicit && context.length > 0 && mentionsDocumentTarget(prompt)) return { route: "edit", attachments: [] }
  return { route: null, attachments: [] }
}
