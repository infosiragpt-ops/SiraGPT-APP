import { shouldEditExistingDocument } from "./ai-service"
import { documentAttachment, isExplicitDocumentEdit } from "./document-sandbox-client"

/** Never let an ambiguous legacy edit classification select the old editor. */
export function routeDocumentSandboxTurn(prompt: string, attachments: readonly unknown[]): "edit" | "clarify" | null {
  if (!attachments.some(documentAttachment)) return null
  if (isExplicitDocumentEdit(prompt, attachments)) return "edit"
  return shouldEditExistingDocument(prompt, [...attachments]) ? "clarify" : null
}
