import { shouldEditExistingDocument } from "./ai-service"
import { getAttachmentLocalFile } from "./document-viewer-attachment"
import { documentAttachment, looksLikeExplicitDocumentEdit, isExplicitDocumentEdit } from "./document-sandbox-client"

export const DOCUMENT_SANDBOX_NEED_ORIGINAL =
  "Adjunta o exporta el documento original (.docx, .xlsx, .pptx o .pdf) para aplicar la edición verificada. No se usó el editor anterior."

export type DocumentSandboxRoute = "edit" | "clarify" | "need_original" | null
export interface DocumentSandboxAdmission {
  route: DocumentSandboxRoute
  attachments: unknown[]
}
export interface DocumentSandboxAdmissionOptions {
  attachments?: readonly unknown[]
  historyAttachments?: readonly unknown[]
  previewAttachments?: readonly unknown[]
  wordHtml?: string | null
  connectorOpen?: boolean
}

/** Never let an ambiguous legacy edit classification select the old editor. */
export function routeDocumentSandboxTurn(prompt: string, attachments: readonly unknown[]): "edit" | "clarify" | null {
  if (!attachments.some(documentAttachment)) return null
  if (isExplicitDocumentEdit(prompt, attachments)) return "edit"
  return shouldEditExistingDocument(prompt, [...attachments]) ? "clarify" : null
}

export function historyDocumentAttachments(messages: readonly unknown[]): unknown[] {
  const files: unknown[] = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const list = (message as { files?: unknown }).files
    if (Array.isArray(list)) files.push(...list)
  }
  return files
}

export function connectorHtmlAttachment(html: string, name = "documento.html"): { name: string; file: File } | null {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").trim()
  if (!text || typeof File === "undefined") return null
  return { name, file: new File([html], name, { type: "text/html" }) }
}

function withOriginalBytes(items: readonly unknown[]): unknown[] {
  return items.filter((item) => documentAttachment(item) && getAttachmentLocalFile(item))
}

/** Word/Excel connector or a prior chat document is enough context to refuse the legacy editor. */
export function resolveDocumentSandboxAdmission(
  prompt: string,
  options: DocumentSandboxAdmissionOptions = {},
): DocumentSandboxAdmission {
  const composer = [...(options.attachments || [])]
  const extras = [...(options.historyAttachments || []), ...(options.previewAttachments || [])]
  const documents = [...composer, ...extras].filter((item) => documentAttachment(item))
  const usable = withOriginalBytes(documents)
  const html = connectorHtmlAttachment(options.wordHtml || "")
  const explicit = looksLikeExplicitDocumentEdit(prompt)
  const documentContext = documents.length > 0 || Boolean(options.connectorOpen) || Boolean(html)

  if (usable.length > 0) {
    if (explicit) return { route: "edit", attachments: usable }
    if (shouldEditExistingDocument(prompt, usable)) return { route: "clarify", attachments: usable }
  }
  if (explicit && html) return { route: "edit", attachments: [html] }
  if (explicit && documentContext) return { route: "need_original", attachments: [] }
  return { route: routeDocumentSandboxTurn(prompt, composer), attachments: composer }
}
