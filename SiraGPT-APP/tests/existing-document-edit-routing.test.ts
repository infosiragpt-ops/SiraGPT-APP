import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  shouldAnswerFromExistingDocument,
  shouldEditExistingDocument,
  shouldUseExistingDocumentFileContext,
} from "../lib/ai-service"

describe("existing document follow-up routing", () => {
  it("reattaches the previous document for edit/append follow-ups, not only summaries", () => {
    const history = [
      {
        role: "USER",
        content: "te subí mi Word, dame un resumen",
        files: [
          {
            id: "file-docx",
            name: "tesis.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      },
    ]

    // Since commit fb579d110, edit detection lives in shouldEditExistingDocument
    // and the reattachment gate used by the chat composer
    // (lib/chat-context-integrated.tsx) is shouldUseExistingDocumentFileContext
    // = answer-from-doc OR edit-doc. Both follow-ups below must keep
    // reattaching the previously uploaded document.
    assert.equal(
      shouldUseExistingDocumentFileContext(
        "quiero que agregues al final el intuemtno de tesis que vamos a aplicar en esta tesis",
        history,
      ),
      true,
    )
    assert.equal(
      shouldUseExistingDocumentFileContext("agrega al final el instrumento de tesis en anexos", history),
      true,
    )

    // The append follow-up with an explicit edit verb + region is classified
    // as an EDIT of the existing document — and therefore excluded from the
    // read-only answer path (the two detectors are mutually exclusive).
    assert.equal(
      shouldEditExistingDocument("agrega al final el instrumento de tesis en anexos", history),
      true,
    )
    assert.equal(
      shouldAnswerFromExistingDocument("agrega al final el instrumento de tesis en anexos", history),
      false,
    )
  })
})
