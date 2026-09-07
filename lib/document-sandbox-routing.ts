import { shouldEditExistingDocument } from "./ai-service"
import {
  documentAttachment,
  documentSandboxClient,
  DocumentSandboxClientError,
  isExplicitDocumentEdit,
  type DocumentCapabilities,
} from "./document-sandbox-client"

export type DocumentSandboxRoute = "edit" | "clarify" | null
export type DocumentSandboxAdmission = "sandbox" | "legacy" | "clarify" | "none" | "blocked"

/** Codes that mean the verified sandbox is not usable and no durable job exists yet. */
export const DOCUMENT_SANDBOX_UNAVAILABLE_CODES = ["E_NOT_READY", "E_NOT_FOUND", "E_CONNECTION"] as const

/** Never let an ambiguous legacy edit classification select the old editor. */
export function routeDocumentSandboxTurn(prompt: string, attachments: readonly unknown[]): DocumentSandboxRoute {
  if (!attachments.some(documentAttachment)) return null
  if (isExplicitDocumentEdit(prompt, attachments)) return "edit"
  return shouldEditExistingDocument(prompt, [...attachments]) ? "clarify" : null
}

export function isDocumentSandboxRuntimeReady(
  capabilities?: Pick<DocumentCapabilities, "enabled" | "ready"> | null,
): boolean {
  return capabilities?.enabled === true && capabilities?.ready === true
}

export function isDocumentSandboxUnavailableError(error: unknown): boolean {
  if (!(error instanceof DocumentSandboxClientError)) return false
  // A rejected POST may have created a durable job. Never treat that as a
  // pre-admission outage or the composer would start a second editor.
  if (error.admissionRejected) return false
  return (DOCUMENT_SANDBOX_UNAVAILABLE_CODES as readonly string[]).includes(error.code)
}

export function resolveDocumentSandboxAdmission(input: {
  route: DocumentSandboxRoute
  capabilities?: Pick<DocumentCapabilities, "enabled" | "ready"> | null
  error?: { code: string; admissionRejected?: boolean } | null
}): DocumentSandboxAdmission {
  if (!input.route) return "none"
  if (input.error) {
    if (input.error.admissionRejected) return "blocked"
    if ((DOCUMENT_SANDBOX_UNAVAILABLE_CODES as readonly string[]).includes(input.error.code)) return "legacy"
    return "blocked"
  }
  if (!isDocumentSandboxRuntimeReady(input.capabilities)) return "legacy"
  return input.route === "clarify" ? "clarify" : "sandbox"
}

export async function admitDocumentSandboxTurn(
  prompt: string,
  attachments: readonly unknown[],
  model: string,
  options: {
    signal?: AbortSignal
    capabilities?: (
      model: string,
      signal?: AbortSignal,
    ) => Promise<Pick<DocumentCapabilities, "enabled" | "ready">>
  } = {},
): Promise<Exclude<DocumentSandboxAdmission, "none" | "blocked">> {
  const route = routeDocumentSandboxTurn(prompt, attachments)
  if (!route) return "legacy"
  const readCapabilities = options.capabilities || ((selected, signal) => documentSandboxClient.capabilities(selected, signal))
  try {
    options.signal?.throwIfAborted()
    const capabilities = await readCapabilities(model, options.signal)
    options.signal?.throwIfAborted()
    const admission = resolveDocumentSandboxAdmission({ route, capabilities })
    if (admission === "blocked" || admission === "none") return "legacy"
    return admission
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
    const admission = resolveDocumentSandboxAdmission({
      route,
      error: error instanceof DocumentSandboxClientError
        ? { code: error.code, admissionRejected: error.admissionRejected }
        : { code: "E_CONNECTION" },
    })
    if (admission === "legacy") return "legacy"
    throw error instanceof DocumentSandboxClientError ? error : new DocumentSandboxClientError("E_CONNECTION")
  }
}
