import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const {
  buildUploadedFileContext,
  serializeMessageAttachments,
} = require(path.join(process.cwd(), "backend/src/services/message-attachments"))

const prismaMock = {
  file: {
    async findMany() {
      return [
        {
          id: "file-1",
          filename: "facultad.txt",
          originalName: "facultad.txt",
          mimeType: "text/plain",
          size: 128,
          extractedText: "FACULTAD DE NEGOCIOS\nContenido para analizar.",
          openaiFileId: null,
        },
      ]
    },
  },
}

describe("message attachments · agent task persistence", () => {
  it("serializes long pasted documents with a stable display title", async () => {
    const files = await serializeMessageAttachments(prismaMock, {
      userId: "user-1",
      fileIds: ["file-1"],
      clientMetadata: [
        {
          id: "file-1",
          isLongPasteDocument: true,
          longPasteTitle: "FACULTAD DE NEGOCIOS",
          longPastePreview: "FACULTAD DE NEGOCIOS",
        },
      ],
    })

    assert.equal(files.length, 1)
    assert.equal(files[0].id, "file-1")
    assert.equal(files[0].name, "FACULTAD DE NEGOCIOS")
    assert.equal(files[0].url, "/uploads/user-1/facultad.txt")
    assert.equal(files[0].isLongPasteDocument, true)
  })

  it("injects extracted attachment text into the agent system context", async () => {
    const context = await buildUploadedFileContext(prismaMock, {
      userId: "user-1",
      fileIds: ["file-1"],
      maxChars: 5000,
    })

    assert.match(context, /Contexto inicial de archivos adjuntos/)
    assert.match(context, /FACULTAD DE NEGOCIOS/)
    assert.match(context, /file-1/)
  })
})
