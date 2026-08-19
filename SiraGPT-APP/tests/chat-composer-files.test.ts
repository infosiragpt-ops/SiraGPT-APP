import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildAgentFileMetadata,
  collectMessageFileIds,
  collectUploadFileIds,
  isComposerFileProcessingPending,
  isComposerFileUploadFailed,
  isComposerFileUploadPending,
  parseMessageFiles,
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
