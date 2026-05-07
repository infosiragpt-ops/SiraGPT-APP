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

  it("uses document analysis chunks when direct extractedText is weak", async () => {
    const prisma = {
      file: {
        async findMany() {
          return [
            {
              id: "file-analysis",
              filename: "scan.png",
              originalName: "scan.png",
              mimeType: "image/png",
              size: 4096,
              extractedText: "No text found in image",
              openaiFileId: null,
              documentAnalysis: {
                id: "analysis-1",
                status: "ready",
                summary: "Texto OCR recuperado",
                textCoverage: { status: "complete" },
                ocr: { status: "vision_fallback", confidence: 95 },
                warnings: [],
                pageCount: null,
                sheetCount: null,
                slideCount: null,
                chunkCount: 1,
                tableCount: 0,
                chunks: [
                  {
                    id: "chunk-1",
                    ordinal: 1,
                    sourceType: "page",
                    sourceLabel: "Pagina 1",
                    pageNumber: 1,
                    sheetName: null,
                    slideNumber: null,
                    sectionTitle: null,
                    text: "FACULTAD DE NEGOCIOS\nTitulo y matriz para transcribir.",
                  },
                ],
                tables: [],
              },
            },
          ]
        },
      },
    }

    const context = await buildUploadedFileContext(prisma, {
      userId: "user-1",
      fileIds: ["file-analysis"],
      maxChars: 5000,
    })

    assert.match(context, /FACULTAD DE NEGOCIOS/)
    assert.match(context, /analysis-1/)
  })

  it("builds deep document context from relevant evidence instead of the cover", async () => {
    const chunks = [
      {
        id: "cover",
        analysisId: "analysis-large",
        fileId: "file-large",
        ordinal: 1,
        sourceType: "section",
        sourceLabel: "Portada",
        sectionTitle: "Portada",
        text: "FACULTAD DE NEGOCIOS Carrera Autor Asesor Bachiller.",
      },
      ...Array.from({ length: 230 }, (_, index) => ({
        id: `chunk-${index + 2}`,
        analysisId: "analysis-large",
        fileId: "file-large",
        ordinal: index + 2,
        sourceType: "section",
        sourceLabel: `Capitulo ${index + 1}`,
        sectionTitle: `Capitulo ${index + 1}`,
        text: `El desarrollo operativo ${index + 1} describe antecedentes y procedimientos del estudio.`,
      })),
      {
        id: "conclusion",
        analysisId: "analysis-large",
        fileId: "file-large",
        ordinal: 232,
        sourceType: "section",
        sourceLabel: "Conclusiones",
        sectionTitle: "Conclusiones",
        text: "Los resultados evidencian que el endomarketing fortalece la satisfaccion laboral y mejora el compromiso organizacional.",
      },
    ]
    const prisma = {
      file: {
        async findMany() {
          return [
            {
              id: "file-large",
              filename: "tesis.docx",
              originalName: "tesis.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 500000,
              extractedText: chunks.map((chunk) => chunk.text).join("\n\n"),
              openaiFileId: null,
              documentAnalysis: {
                id: "analysis-large",
                status: "ready",
                summary: "Documento academico extenso",
                textCoverage: { status: "complete" },
                ocr: null,
                warnings: [],
                pageCount: null,
                sheetCount: null,
                slideCount: null,
                chunkCount: chunks.length,
                tableCount: 0,
                chunks: [chunks[0]],
                tables: [],
              },
            },
          ]
        },
      },
      documentAnalysis: {
        async findFirst({ where }: any) {
          assert.equal(where.fileId, "file-large")
          return {
            id: "analysis-large",
            fileId: "file-large",
            userId: "user-1",
            status: "ready",
            summary: "Documento academico extenso",
            chunkCount: chunks.length,
            tableCount: 0,
          }
        },
      },
      documentChunk: {
        async findMany(args: any) {
          assert.equal(args.where.analysisId, "analysis-large")
          assert.equal(args.take, undefined)
          return chunks
        },
      },
    }

    const context = await buildUploadedFileContext(prisma, {
      userId: "user-1",
      fileIds: ["file-large"],
      query: "dame 2 conclusiones profesionales",
      maxChars: 6000,
    })

    assert.match(context, /Contenido relevante recuperado desde todo el documento/)
    assert.match(context, /endomarketing fortalece la satisfaccion laboral/)
    const evidenceBlock = context.split("Contenido relevante recuperado desde todo el documento:")[1]
      .split("[La evidencia")[0]
    assert.doesNotMatch(evidenceBlock, /FACULTAD DE NEGOCIOS/)
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
