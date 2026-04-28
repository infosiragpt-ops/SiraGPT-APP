import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const {
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  extractFileIdsFromMessageFiles,
  hasUsefulExtractedText,
  isPlainTranscriptionRequest,
  resolveTranscriptionFileIds,
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

  it("returns verbatim extracted text for plain transcription requests", async () => {
    const text = await buildTranscriptionTextFromFiles(prismaMock, {
      userId: "user-1",
      fileIds: ["file-1"],
    })

    assert.equal(text, "FACULTAD DE NEGOCIOS\nContenido para analizar.")
  })

  it("detects plain transcription without treating documents as requested exports", () => {
    assert.equal(isPlainTranscriptionRequest("transcribir este documento"), true)
    assert.equal(isPlainTranscriptionRequest("transcribir el texto en Word"), false)
  })

  it("treats empty OCR placeholders as unreadable image text", () => {
    assert.equal(hasUsefulExtractedText("No text found in image"), false)
    assert.equal(hasUsefulExtractedText("No text detected"), false)
    assert.equal(hasUsefulExtractedText("FACULTAD DE NEGOCIOS ADMINISTRACION"), true)
  })

  it("extracts file ids from persisted message attachments", () => {
    const ids = extractFileIdsFromMessageFiles([
      { id: "file-1", name: "captura.png" },
      { fileId: "file-2" },
      { attachments: [{ attachmentId: "file-3" }] },
    ])

    assert.deepEqual(ids, ["file-1", "file-2", "file-3"])
  })

  it("reuses the latest readable chat attachment for plain transcription", async () => {
    const prisma = {
      chat: {
        async findFirst() {
          return { id: "chat-1" }
        },
      },
      message: {
        async findMany() {
          return [
            { files: [{ id: "file-img", name: "captura.png" }] },
            { files: null },
          ]
        },
      },
      file: {
        async findMany() {
          return [
            {
              id: "file-img",
              filename: "captura.png",
              originalName: "captura.png",
              mimeType: "image/png",
              extractedText: "TEXTO OCR EXTRAIDO",
            },
          ]
        },
      },
    }

    const ids = await resolveTranscriptionFileIds(prisma, {
      userId: "user-1",
      chatId: "chat-1",
      providedFileIds: [],
    })

    assert.deepEqual(ids, ["file-img"])
  })
})
