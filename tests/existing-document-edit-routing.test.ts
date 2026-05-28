import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { shouldAnswerFromExistingDocument } from "../lib/ai-service"

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

    assert.equal(
      shouldAnswerFromExistingDocument(
        "quiero que agregues al final el intuemtno de tesis que vamos a aplicar en esta tesis",
        history,
      ),
      true,
    )
    assert.equal(
      shouldAnswerFromExistingDocument("agrega al final el instrumento de tesis en anexos", history),
      true,
    )
  })
})
