import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildAgentFileMetadata,
  collectMessageFileIds,
  collectProcessingFileIds,
  collectUploadFileIds,
  describeMediaTranscriptionProgress,
  isAudioComposerFile,
  isVideoComposerFile,
  isComposerFileProcessingPending,
  isComposerFileUploadFailed,
  isComposerFileSendBlockedByFailure,
  isComposerFileUploadPending,
  parseMessageFiles,
  isMediaFollowupPrompt,
  resolveMediaFollowupFiles,
  shouldWaitForDocumentProcessing,
} from "../lib/chat/composer-files"

describe("chat composer files", () => {
  it("normalizes uploaded file ids and excludes empty optimistic records", () => {
    assert.deepEqual(collectUploadFileIds([
      " direct-id ",
      { id: "server-id" },
      { fileId: "file-id" },
      { attachmentId: "attachment-id" },
      { id: "" },
    ]), ["direct-id", "server-id", "file-id", "attachment-id"])
  })

  it("extracts file ids from persisted JSON strings and fileId aliases", () => {
    assert.deepEqual(parseMessageFiles('[{"fileId":"persisted-1"},{"id":"persisted-1"},{"attachmentId":"persisted-2"}]'), [
      { fileId: "persisted-1" },
      { id: "persisted-1" },
      { attachmentId: "persisted-2" },
    ])
    assert.deepEqual(
      collectMessageFileIds('[{"fileId":"persisted-1"},{"id":"persisted-1"},{"attachmentId":"persisted-2"}]'),
      ["persisted-1", "persisted-2"],
    )
    assert.deepEqual(collectMessageFileIds([{ id: "live-id" }, { fileId: "alias-id" }]), ["live-id", "alias-id"])
  })

  it("distinguishes transport uploads from document processing", () => {
    assert.equal(isComposerFileUploadPending({ status: "uploading" }), true)
    assert.equal(isComposerFileUploadPending({ id: "1", status: "uploading" }), false)
    assert.equal(shouldWaitForDocumentProcessing({ id: "1", name: "brief.pdf" }), true)
    assert.equal(shouldWaitForDocumentProcessing({ id: "1", name: "photo.png" }), false)
    assert.equal(isComposerFileProcessingPending({ id: "1", name: "brief.pdf", processingStage: "extracting" }), true)
    assert.equal(isComposerFileProcessingPending({ id: "1", name: "brief.pdf", processingStage: "ready" }), false)
    assert.equal(isComposerFileUploadFailed({ id: "1", stage: "failed" }), true)
  })

  it("builds agent metadata without embedding the full long-paste text", () => {
    const metadata = buildAgentFileMetadata([{
      id: "paste-1",
      name: "paste.txt",
      type: "text/plain",
      __siraLongPaste: {
        kind: "long_paste_document",
        title: "Informe pegado",
        filename: "informe.txt",
        text: "contenido privado completo",
        preview: "contenido privado…",
        originalCharCount: 26,
        originalWordCount: 3,
        originalLineCount: 1,
        createdAt: "2026-08-05T00:00:00.000Z",
      },
    }])

    assert.equal(metadata.length, 1)
    assert.equal(metadata[0].name, "Informe pegado")
    assert.equal(metadata[0].isLongPasteDocument, true)
    assert.equal("text" in (metadata[0].longPasteMeta || {}), false)
    assert.equal(metadata[0].longPasteMeta?.preview, "contenido privado…")
  })
})

describe("historical media batch follow-ups", () => {
  const files = Array.from({ length: 50 }, (_, index) => ({ id: `audio-${index}`, name: `${index}.mp3`, mimeType: "audio/mpeg" }))
  const history = [
    { role: "USER", files: JSON.stringify(files) },
    { role: "ASSISTANT", files: [{ id: "report", name: "report.pdf" }] },
    { role: "USER", content: "analiza los 50 audios", files: [] },
    { role: "ASSISTANT", content: "Análisis parcial" },
  ]

  it("restores all 50 IDs after refresh and skips empty follow-ups for repeated retries", () => {
    assert.deepEqual(resolveMediaFollowupFiles("reintenta los audios fallidos", history), files)
    assert.deepEqual(resolveMediaFollowupFiles("analiza los50", history), files)
    assert.deepEqual(resolveMediaFollowupFiles("transcribe todos", history), files)
    assert.deepEqual(resolveMediaFollowupFiles("reintenta los fallidos", [
      ...history, { role: "USER", content: "reintenta los audios fallidos" },
    ]), files)
  })

  it("stops at the newest attached nonmedia batch and never borrows another chat's files", () => {
    assert.deepEqual(resolveMediaFollowupFiles("analiza los audios", [
      ...history, { role: "USER", files: [{ id: "new-doc", name: "brief.pdf" }] },
    ]), [])
    assert.deepEqual(resolveMediaFollowupFiles("analiza los audios", []), [])
    assert.deepEqual(resolveMediaFollowupFiles("analiza el código", history), [])
    assert.deepEqual(resolveMediaFollowupFiles("crea una web", history), [])
    assert.deepEqual(resolveMediaFollowupFiles("crea una web para analizar audios", history), [])
    assert.equal(isMediaFollowupPrompt("analiza las ventas de hoy"), false)
  })
})

describe("collectProcessingFileIds", () => {
  const TXT = "text/plain"

  it("lists attachments that still need polling and skips settled or id-less ones", () => {
    const ids = collectProcessingFileIds([
      { id: "paste-1", name: "campo-contenido-2026-09-02T20-31-40.txt", mimeType: TXT, status: "processing", processingStage: "extracting" },
      { id: "doc-2", name: "informe.pdf", mimeType: "application/pdf", status: "processing", processingStage: "chunking" },
      { id: "ready-3", name: "notas.txt", mimeType: TXT, status: "ready", processingStage: "ready" },
      { id: "failed-4", name: "roto.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", status: "failed", processingStage: "failed" },
      { tempId: "tmp-5", name: "subiendo.txt", mimeType: TXT, status: "uploading" },
      { id: "img-6", name: "foto.png", mimeType: "image/png", status: "ready" },
    ])
    assert.deepEqual(ids, ["paste-1", "doc-2"])
  })

  it("keeps a chip flagged processing without any stage (upload response arrived before the pipeline reported)", () => {
    assert.deepEqual(
      collectProcessingFileIds([{ id: "paste-7", name: "campo-contenido.txt", mimeType: TXT, status: "processing" }]),
      ["paste-7"],
    )
    assert.deepEqual(collectProcessingFileIds([{ id: "x", name: "campo-contenido.txt", mimeType: TXT, status: "processing", processingStage: "ready" }]), [])
    assert.deepEqual(collectProcessingFileIds([]), [])
    assert.deepEqual(collectProcessingFileIds([null, undefined, "junk"] as any), [])
  })
})

 describe("media batch send admission", () => {
  it("permits partial media processing failures but not lost uploads or failed documents", () => {
    assert.equal(isComposerFileSendBlockedByFailure({ id: "audio-1", name: "one.mp3", processingStage: "failed" }), false)
    assert.equal(isComposerFileSendBlockedByFailure({ id: "video-1", name: "two.mp4", processingStage: "failed" }), false)
    assert.equal(isComposerFileSendBlockedByFailure({ tempId: "no-upload", name: "one.mp3", status: "failed" }), true)
    assert.equal(isComposerFileSendBlockedByFailure({ id: "doc-1", name: "one.pdf", processingStage: "failed" }), true)
  })
})

describe("long recording chip progress", () => {
  it("shows real % and remaining time instead of a bare Transcribiendo…", () => {
    assert.equal(describeMediaTranscriptionProgress(null), null)
    assert.equal(describeMediaTranscriptionProgress({ stage: "preparing" }), "Preparando audio…")
    assert.equal(describeMediaTranscriptionProgress({ stage: "transcribing", percent: 34.4, etaSeconds: 40 * 60 }), "Transcribiendo 34 % · quedan ~40 min")
    assert.equal(describeMediaTranscriptionProgress({ stage: "transcribing", percent: 80, etaSeconds: 3 * 3600 + 900 }), "Transcribiendo 80 % · quedan ~3 h 15 min")
    assert.equal(describeMediaTranscriptionProgress({ stage: "transcribing", percent: 5 }), "Transcribiendo 5 %")
  })

  it("classifies every supported audio/video format by extension when the browser gives no MIME", () => {
    for (const name of ["nota.caf", "llamada.amr", "voz.m4a", "libro.m4b", "radio.wma", "musica.mka", "ptt.opus", "clase.aiff"]) {
      assert.equal(isAudioComposerFile({ name, type: "" }), true, name)
    }
    for (const name of ["clase.mkv", "cine.wmv", "tv.ts", "movil.3gp", "viejo.flv"]) {
      assert.equal(isVideoComposerFile({ name, type: "" }), true, name)
    }
  })
})
